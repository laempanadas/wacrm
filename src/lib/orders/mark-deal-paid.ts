// src/lib/orders/mark-deal-paid.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ORDERS_PAID_STAGE_NAME,
  markContactPaymentConfirmed,
  TAG_CONFIRMADO,
  TAG_AGUARDANDO,
  TAG_HUMANO,
} from './create-order';

export { TAG_CONFIRMADO, TAG_AGUARDANDO, TAG_HUMANO };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MarkDealPaidResult =
  | { moved: true; dealId: string; stageId: string; stageCreated: boolean }
  | {
      moved: false;
      reason:
        | 'invalid_deal_id'
        | 'lookup_failed'
        | 'deal_not_found'
        | 'pipeline_not_found'
        | 'contact_not_found'
        | 'stage_unavailable'
        | 'update_failed';
    };

/**
 * Moves an order's deal to the "Pago" stage of its pipeline and marks it
 * won (the pipeline UI shows won deals as "Marcado como pago"). Creates
 * the stage at the end of the pipeline if the account doesn't have it.
 */
export async function markDealPaid(
  db: SupabaseClient,
  args: { accountId: string; dealId: string }
): Promise<MarkDealPaidResult> {
  // orders.deal_id isn't always a deal id (the payment route stores the
  // external reference there), so don't send junk to a uuid column.
  if (!UUID_RE.test(args.dealId))
    return { moved: false, reason: 'invalid_deal_id' };

  const { data: deal, error: dealErr } = await db
    .from('deals')
    .select('id, pipeline_id, contact_id, user_id')
    .eq('id', args.dealId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (dealErr) return { moved: false, reason: 'lookup_failed' };
  if (!deal) return { moved: false, reason: 'deal_not_found' };

  const { data: pipeline, error: pipelineErr } = await db
    .from('pipelines')
    .select('id')
    .eq('id', deal.pipeline_id)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (pipelineErr) return { moved: false, reason: 'lookup_failed' };
  if (!pipeline) return { moved: false, reason: 'pipeline_not_found' };

  if (deal.contact_id) {
    const { data: contact, error: contactErr } = await db
      .from('contacts')
      .select('id')
      .eq('id', deal.contact_id)
      .eq('account_id', args.accountId)
      .maybeSingle();
    if (contactErr) return { moved: false, reason: 'lookup_failed' };
    if (!contact) return { moved: false, reason: 'contact_not_found' };
  }

  const { data: stages, error: stagesErr } = await db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', deal.pipeline_id);
  if (stagesErr) return { moved: false, reason: 'stage_unavailable' };

  let stageId = (stages ?? []).find(
    (s: { name: string }) =>
      s.name.trim().toLowerCase() === ORDERS_PAID_STAGE_NAME.toLowerCase()
  )?.id as string | undefined;
  let stageCreated = false;

  if (!stageId) {
    const lastPosition = Math.max(
      -1,
      ...(stages ?? []).map((s: { position: number }) => s.position)
    );
    const { data: created, error } = await db
      .from('pipeline_stages')
      .insert({
        pipeline_id: deal.pipeline_id,
        name: ORDERS_PAID_STAGE_NAME,
        position: lastPosition + 1,
        color: '#16a34a',
      })
      .select('id')
      .maybeSingle();
    if (error || !created) {
      console.error('[markDealPaid] Could not create stage:', error);
      return { moved: false, reason: 'stage_unavailable' };
    }
    stageId = created.id as string;
    stageCreated = true;
  }

  // Bind the write to the account and relationship snapshot we validated.
  let update = db
    .from('deals')
    .update({
      stage_id: stageId,
      status: 'won',
      updated_at: new Date().toISOString(),
    })
    .eq('id', deal.id)
    .eq('account_id', args.accountId)
    .eq('pipeline_id', deal.pipeline_id);
  update = deal.contact_id
    ? update.eq('contact_id', deal.contact_id)
    : update.is('contact_id', null);
  const { data: updated, error: updateErr } = await update
    .select('id')
    .maybeSingle();
  if (updateErr || !updated) {
    console.error('[markDealPaid] Could not update deal:', updateErr);
    return { moved: false, reason: 'update_failed' };
  }

  if (deal.contact_id) {
    try {
      await markContactPaymentConfirmed(
        db,
        { accountId: args.accountId, userId: (deal.user_id as string) || '' },
        deal.contact_id as string
      );
    } catch (err) {
      console.warn(
        '[markDealPaid] Falha ao atualizar tag de confirmação no contato:',
        err
      );
    }
  }

  return { moved: true, dealId: deal.id, stageId, stageCreated };
}
