import type { SupabaseClient } from '@supabase/supabase-js';
import { correctFlowCheckout } from '@/lib/flows/checkout-consent';
import { hasOrderIntent } from './text-order-parser';
import { loadOrderCatalog } from './order-catalog';
import {
  advanceOrderDraft,
  orderSummary,
  type OrderDraft,
} from './order-draft';
import { createOrderWithMercadoPago } from './create-order-with-mercado-pago';
import {
  getSavedCustomerAddress,
  saveContactOrderFields,
} from './custom-fields';
import { applyContactTag, TAG_HUMANO } from './create-order';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sendWhatsAppPaymentMessage } from '@/lib/whatsapp/payment-message';

export {
  STANDARD_DELIVERY_CUSTOM_FIELDS,
  type StandardDeliveryCustomField,
  type ContactOrderFieldsInput,
  parseAddressComponents,
  getSavedCustomerAddress,
  saveContactOrderFields,
} from './custom-fields';

export interface TextOrderFlowContext {
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  contactRecord: { id: string; name?: string | null; phone: string };
  contactName: string;
  senderPhone: string;
  conversationId: string;
  inboundText: string;
  inboundMessageId: string;
  inboundTimestamp: string;
  phoneNumberId: string;
  accessToken: string;
}
export interface TextOrderFlowResult {
  handled: boolean;
  outcome?:
    | 'order_created'
    | 'address_requested'
    | 'confirmation_requested'
    | 'needs_human'
    | 'duplicate';
  error?: string;
}

async function handoff(ctx: TextOrderFlowContext): Promise<void> {
  const { error } = await ctx.supabase
    .from('conversations')
    .update({ ai_autoreply_disabled: true })
    .eq('id', ctx.conversationId)
    .eq('account_id', ctx.accountId);
  if (error) throw error;
  await applyContactTag(ctx.supabase, ctx, ctx.contactRecord.id, TAG_HUMANO);
}

async function saveDraft(
  ctx: TextOrderFlowContext,
  draft: OrderDraft,
  release = false
): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('order_drafts')
    .update({
      state: draft,
      ...(release ? { processing_message_id: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', ctx.accountId)
    .eq('conversation_id', ctx.conversationId)
    .eq('processing_message_id', ctx.inboundMessageId)
    .select('id')
    .single();
  if (error || !data)
    throw new Error(error?.message || 'Order turn lost its durable claim');
}

/** At-most-once outbound effect. Ambiguous sends remain reserved for reconciliation. */
async function sendAndRecord(
  ctx: TextOrderFlowContext,
  effectKey: string,
  text: string,
  paymentUrl?: string
): Promise<void> {
  const db = ctx.supabase;
  const { error: claimError } = await db.from('order_message_outbox').insert({
    account_id: ctx.accountId,
    conversation_id: ctx.conversationId,
    effect_key: effectKey,
    status: 'sending',
    payload: { text, paymentUrl },
  });
  if (claimError?.code === '23505') return;
  if (claimError) throw claimError;
  try {
    let record: {
      messageId: string;
      contentType: string;
      formattedText: string;
      interactivePayload?: unknown;
    };
    if (paymentUrl)
      record = await sendWhatsAppPaymentMessage({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
        toPhone: ctx.senderPhone,
        bodyText: text,
        buttonUrl: paymentUrl,
        buttonText: '💳 Pagar Agora',
        lastCustomerMessageAt: ctx.inboundTimestamp,
      });
    else {
      const age = Date.now() - Date.parse(ctx.inboundTimestamp);
      if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000)
        throw new Error(
          'Janela de atendimento encerrada; é necessário um template aprovado.'
        );
      const result = await sendTextMessage({
        phoneNumberId: ctx.phoneNumberId,
        accessToken: ctx.accessToken,
        to: ctx.senderPhone,
        text,
      });
      if (!result.messageId)
        throw new Error(
          'Envio sem confirmação da Meta; não repetir automaticamente.'
        );
      record = {
        messageId: result.messageId,
        contentType: 'text',
        formattedText: text,
      };
    }
    // Save the receipt first: DB failure afterwards must never repeat an accepted Meta send.
    const { error: receiptError } = await db
      .from('order_message_outbox')
      .update({ status: 'sent', message_id: record.messageId, payload: record })
      .eq('account_id', ctx.accountId)
      .eq('effect_key', effectKey);
    if (receiptError) throw receiptError;
    const { error: messageError } = await db.from('messages').insert({
      conversation_id: ctx.conversationId,
      sender_type: 'bot',
      content_type: record.contentType,
      content_text: record.formattedText,
      interactive_payload: record.interactivePayload ?? null,
      message_id: record.messageId,
      status: 'sent',
    });
    if (messageError) throw messageError;
  } catch (error) {
    await db
      .from('order_message_outbox')
      .update({ status: 'uncertain' })
      .eq('account_id', ctx.accountId)
      .eq('effect_key', effectKey);
    throw error;
  }
}

export async function processFreeTextOrderInbound(
  ctx: TextOrderFlowContext
): Promise<TextOrderFlowResult> {
  const db = ctx.supabase;
  let ownsTurn = false;
  let catalogRunOwnsTurn = false;
  try {
    const { data: existing, error: readError } = await db
      .from('order_drafts')
      .select('state')
      .eq('account_id', ctx.accountId)
      .eq('conversation_id', ctx.conversationId)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing && !hasOrderIntent(ctx.inboundText))
      return { handled: false };
    if (!ctx.inboundMessageId)
      throw new Error('Missing inbound Meta message ID');
    const { data: activeFlow, error: flowError } = await db
      .from('flow_runs')
      .select(
        'id, account_id, flow_id, user_id, contact_id, conversation_id, status, current_node_key, consent_revision, vars'
      )
      .eq('account_id', ctx.accountId)
      .eq('conversation_id', ctx.conversationId)
      .eq('status', 'active')
      .maybeSingle();
    if (flowError) throw flowError;
    const catalogOwnsTurn = activeFlow && Array.isArray(activeFlow.vars?.itens);
    catalogRunOwnsTurn = Boolean(catalogOwnsTurn);
    // The new catalog run owns delivery/address/confirmation replies even when
    // an old text draft remains persisted (including payment_created).
    if (catalogOwnsTurn && !hasOrderIntent(ctx.inboundText))
      return { handled: false };
    const { data: conversation, error: conversationError } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, last_agent_message_at')
      .eq('id', ctx.conversationId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (conversationError) throw conversationError;
    const activeAgent =
      conversation?.assigned_agent_id &&
      conversation.last_agent_message_at &&
      Date.now() - Date.parse(conversation.last_agent_message_at) <
        30 * 60 * 1000;
    if (
      (conversation?.ai_autoreply_disabled || activeAgent) &&
      !catalogOwnsTurn
    )
      return { handled: true, outcome: 'needs_human' };
    // Do not steal item corrections from an active catalog order into a new text draft.
    // The original cart remains intact; an attendant reviews the persisted inbound change.
    if (catalogOwnsTurn) {
      await correctFlowCheckout(db, activeFlow, ctx.inboundText);
      await sendAndRecord(
        ctx,
        `turn:${ctx.inboundMessageId}`,
        'Sua alteração foi preservada para revisão. Se o checkout já iniciou, um atendente reconciliará o pedido e o pagamento; não presumimos cancelamento.'
      );
      return { handled: true, outcome: 'needs_human' };
    }
    const { data: claim, error: claimError } = await db.rpc(
      'claim_order_turn',
      {
        p_account_id: ctx.accountId,
        p_conversation_id: ctx.conversationId,
        p_contact_id: ctx.contactRecord.id,
        p_message_id: ctx.inboundMessageId,
        p_text: ctx.inboundText,
      }
    );
    if (claimError) throw claimError;
    if (claim?.outcome === 'duplicate')
      return { handled: true, outcome: 'duplicate' };
    if (claim?.outcome !== 'claimed') {
      await handoff(ctx);
      return {
        handled: true,
        outcome: 'needs_human',
        error: 'Outro turno está em processamento; atendimento necessário.',
      };
    }
    ownsTurn = true;
    const initial: OrderDraft = {
      id: claim.id,
      version: 0,
      items: [],
      unresolved: [],
      stage: 'collecting',
      total: 0,
    };
    const previous = claim.state?.id ? (claim.state as OrderDraft) : initial;
    const catalog = await loadOrderCatalog(db, ctx.accountId);
    const savedAddress = await getSavedCustomerAddress(
      db,
      ctx.accountId,
      ctx.contactRecord.id
    );
    const transition = advanceOrderDraft(
      previous,
      ctx.inboundText,
      catalog,
      savedAddress
    );
    const draft = transition.draft;
    await saveDraft(ctx, draft);
    const customerName = ctx.contactRecord.name || ctx.contactName || 'Cliente';
    await saveContactOrderFields(db, ctx.accountId, ctx.contactRecord.id, {
      itens: orderSummary(draft),
      endereco: draft.deliveryAddress,
      nomeCliente: customerName,
    });
    if (transition.checkout) {
      const reference = `TEXT-${draft.id}-${draft.version}`;
      const result = await createOrderWithMercadoPago(
        { accountId: ctx.accountId, userId: ctx.userId },
        {
          contactId: ctx.contactRecord.id,
          customerName,
          deliveryKind: 'delivery',
          deliveryAddress: draft.deliveryAddress,
          items: draft.items.map((item) => ({
            id: item.id,
            title: item.title,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            description: item.notes,
            requestedText: item.requestedText,
          })),
          conversationId: ctx.conversationId,
          payerPhone: ctx.senderPhone,
          externalReference: reference,
        }
      );
      if (!result.ok || !result.link_mercado_pago)
        throw new Error(
          result.error || 'Falha ao criar pagamento; atendimento necessário.'
        );
      draft.stage = 'payment_created';
      await saveDraft(ctx, draft);
      await sendAndRecord(
        ctx,
        `payment:${reference}`,
        `La Empanadas — Pedido ${result.orderId || result.dealId || draft.id}\nTotal: R$ ${draft.total.toFixed(2).replace('.', ',')}\nPague com segurança pelo Mercado Pago.`,
        result.link_mercado_pago
      );
    } else {
      if (draft.stage === 'needs_human' || draft.stage === 'payment_created')
        await handoff(ctx);
      const reply =
        draft.stage === 'awaiting_address' && savedAddress
          ? `${transition.reply}\nOu responda SIM para usar o endereço cadastrado: ${savedAddress}`
          : transition.reply;
      await sendAndRecord(ctx, `turn:${ctx.inboundMessageId}`, reply);
    }
    const { error: eventError } = await db
      .from('order_inbound_events')
      .update({ status: 'completed' })
      .eq('account_id', ctx.accountId)
      .eq('meta_message_id', ctx.inboundMessageId);
    if (eventError) throw eventError;
    await saveDraft(ctx, draft, true);
    return {
      handled: true,
      outcome: transition.checkout
        ? 'order_created'
        : draft.stage === 'needs_human' || draft.stage === 'payment_created'
          ? 'needs_human'
          : draft.stage === 'awaiting_address'
            ? 'address_requested'
            : 'confirmation_requested',
    };
  } catch (error) {
    // Fail closed: no LLM/legacy payment fallback and no automatic uncertain-effect retry.
    if (ownsTurn)
      await db
        .from('order_inbound_events')
        .update({ status: 'failed' })
        .eq('account_id', ctx.accountId)
        .eq('meta_message_id', ctx.inboundMessageId);
    try {
      // Catalog ownership is exclusively changed by the consent RPC. A failed
      // RPC/notice must not let this stale text worker hand off a newer run.
      if (!catalogRunOwnsTurn) await handoff(ctx);
    } catch (handoffError) {
      console.error(
        '[text-order-flow] handoff persistence failed',
        handoffError
      );
    }
    return {
      handled: true,
      outcome: 'needs_human',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
