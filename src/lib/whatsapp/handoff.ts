import type { SupabaseClient } from '@supabase/supabase-js';
import { hasFreshOrderIntent } from '@/lib/orders/draft-lifecycle';

export type HandoffReason =
  | 'customer_request'
  | 'order_review'
  | 'payment_review'
  | 'technical_error'
  | 'human_active'
  | 'manual';

export const HANDOFF_WAITING = 'Um atendente já vai te responder.';
export const HANDOFF_RESUME =
  'Ainda não consegui um atendente. Posso continuar seu pedido por aqui? Responda CONTINUAR COM O BOT.';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
}

export function isHumanRequest(text: string): boolean {
  return /^(?:(?:quero|preciso|gostaria de)\s+)?(?:falar com (?:um |uma |o |a )?)?(?:atendente|humano|pessoa)(?: por favor)?$/.test(
    normalize(text)
  );
}

export interface HandoffDecision {
  blocked: boolean;
  episode_id?: string;
  notice?: 'waiting' | 'resume';
  resumed?: boolean;
}

interface HandoffInput {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactId: string;
  text: string;
  messageId: string;
  reason?: HandoffReason;
  send: (effectKey: string, text: string) => Promise<void>;
}

/** SQL locks the conversation and notifies recipients in the same transaction.
 * The send callback must use a durable outbox: retries share the episode key. */
export async function handleConversationHandoff(
  input: HandoffInput
): Promise<boolean> {
  const { data, error } = await input.db.rpc('handle_conversation_handoff', {
    p_account_id: input.accountId,
    p_conversation_id: input.conversationId,
    p_contact_id: input.contactId,
    p_request: Boolean(input.reason) || isHumanRequest(input.text),
    p_reason: input.reason ?? 'customer_request',
    p_resume: normalize(input.text) === 'continuar com o bot',
    p_new_order: hasFreshOrderIntent(input.text),
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data.blocked !== 'boolean')
    throw new Error('Handoff decision was not persisted');
  const decision = data as HandoffDecision;
  if (decision.blocked && decision.notice && decision.episode_id)
    await input.send(
      `handoff:${decision.episode_id}:${decision.notice}`,
      decision.notice === 'resume' ? HANDOFF_RESUME : HANDOFF_WAITING
    );
  return decision.blocked;
}

/** Assignment alone is not a lock; a recent human send is. Future/invalid
 * timestamps fail closed rather than expiring a possibly active human. */
export function hasActiveHuman(
  lastAgentMessageAt?: string | null,
  now = Date.now()
): boolean {
  if (!lastAgentMessageAt) return false;
  const age = now - Date.parse(lastAgentMessageAt);
  return !Number.isFinite(age) || age < 30 * 60 * 1000;
}

/** Used by the AI/flow sender; text-order sends already own an outbox. */
export async function sendHandoffNotice(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  effectKey: string,
  text: string,
  send: (text: string) => Promise<unknown>
): Promise<void> {
  const claim = await db.from('order_message_outbox').insert({
    account_id: accountId,
    conversation_id: conversationId,
    effect_key: effectKey,
    status: 'sending',
    payload: { text },
  });
  if (claim.error?.code === '23505') return;
  if (claim.error) throw new Error(claim.error.message);
  try {
    await send(text);
    const saved = await db
      .from('order_message_outbox')
      .update({ status: 'sent' })
      .eq('account_id', accountId)
      .eq('effect_key', effectKey);
    if (saved.error) throw new Error(saved.error.message);
  } catch (error) {
    await db
      .from('order_message_outbox')
      .update({ status: 'uncertain' })
      .eq('account_id', accountId)
      .eq('effect_key', effectKey);
    throw error;
  }
}
