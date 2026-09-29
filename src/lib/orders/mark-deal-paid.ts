// src/lib/orders/mark-deal-paid.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { ORDERS_PAID_STAGE_NAME } from './create-order';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MarkDealPaidResult =
  | { moved: true; dealId: string; stageId: string; stageCreated: boolean }
  | { moved: false; reason: 'invalid_deal_id' | 'deal_not_found' | 'stage_unavailable' | 'update_failed' };

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
  if (!UUID_RE.test(args.dealId)) return { moved: false, reason: 'invalid_deal_id' };

  const { data: deal } = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('id', args.dealId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!deal) return { moved: false, reason: 'deal_not_found' };

  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', deal.pipeline_id);

  let stageId = (stages ?? []).find(
    (s: { name: string }) => s.name.trim().toLowerCase() === ORDERS_PAID_STAGE_NAME.toLowerCase()
  )?.id as string | undefined;
  let stageCreated = false;

  if (!stageId) {
    const lastPosition = Math.max(-1, ...(stages ?? []).map((s: { position: number }) => s.position));
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

  const { error: updateErr } = await db
    .from('deals')
    .update({ stage_id: stageId, status: 'won', updated_at: new Date().toISOString() })
    .eq('id', deal.id);
  if (updateErr) {
    console.error('[markDealPaid] Could not update deal:', updateErr);
    return { moved: false, reason: 'update_failed' };
  }

  return { moved: true, dealId: deal.id, stageId, stageCreated };
}
