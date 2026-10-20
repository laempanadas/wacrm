import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentLinkItem } from './mercado-pago';
import { exactBrlCents } from './payment-identity';

/** Only explicitly offline orders with no durable online claim can be ignored.
 * Unknown legacy methods and conflicting bindings remain fail-closed. */
export async function matchOpenPayment<T extends Record<string, unknown>>(
  rows: T[],
  fingerprint: string,
  database: SupabaseClient,
  accountId: string
): Promise<{ ambiguous: boolean; match?: T }> {
  const candidates = await Promise.all(
    rows
      .filter((row) => {
        const offline = ['dinheiro', 'na_retirada'].includes(
          String(row.payment_method)
        );
        const bound = [
          row.payment_fingerprint,
          row.preference_id,
          row.payment_url,
          row.payment_id,
          row.paid_online,
        ].some((value) => value != null && value !== '' && value !== false);
        return (
          !offline ||
          bound ||
          ['checkout_uncertain', 'processing', 'uncertain', 'failed'].includes(
            String(row.status)
          )
        );
      })
      .map(async (row) => ({
        row,
        fingerprint:
          row.payment_fingerprint == null
            ? await legacyOpenPaymentFingerprint(row, database, accountId)
            : typeof row.payment_fingerprint === 'string' &&
                /^[a-f0-9]{64}$/.test(row.payment_fingerprint)
              ? row.payment_fingerprint
              : null,
      }))
  );
  const matching = candidates.filter(
    (candidate) => candidate.fingerprint === fingerprint
  );
  return {
    ambiguous:
      candidates.some((candidate) => candidate.fingerprint === null) ||
      matching.length > 1,
    match: matching.length === 1 ? matching[0].row : undefined,
  };
}

/** Core orders persist raw lines, while their frozen ledger owns observations.
 * A row alone cannot prove that missing notes mean empty notes. Never infer
 * legacy identity from totals or from an unrelated checkout. */
async function legacyOpenPaymentFingerprint(
  row: Record<string, unknown>,
  database: SupabaseClient,
  accountId: string
): Promise<string | null> {
  if (row.account_id !== accountId || !row.id || !row.external_reference)
    return null;
  const result = await database
    .from('order_checkouts')
    .select('*')
    .eq('account_id', accountId)
    .eq('external_reference', row.external_reference);
  if (result.error) throw result.error;
  if (!result.data || result.data.length !== 1) return null;
  const ledger = result.data[0];
  const snapshot = ledger.snapshot;
  if (
    ledger.account_id !== accountId ||
    ledger.external_reference !== row.external_reference ||
    ledger.status !== 'completed' ||
    ledger.order_id !== row.id ||
    !row.preference_id ||
    ledger.preference_id !== row.preference_id ||
    !row.payment_url ||
    ledger.payment_url !== row.payment_url ||
    ledger.deal_id !== row.deal_id ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    snapshot.contactId !== row.contact_id ||
    typeof snapshot.observations !== 'string' ||
    exactBrlCents(snapshot.total) === null ||
    exactBrlCents(snapshot.total) !== exactBrlCents(row.total)
  )
    return null;
  const frozen = {
    items: snapshot.items,
    delivery_kind: snapshot.deliveryKind,
    delivery_address: snapshot.deliveryAddress,
  };
  const rawFingerprint = storedOpenPaymentFingerprint(frozen);
  if (!rawFingerprint || rawFingerprint !== storedOpenPaymentFingerprint(row))
    return null;
  return storedOpenPaymentFingerprint({
    ...frozen,
    observations: snapshot.observations,
  });
}

export function storedOpenPaymentFingerprint(input: {
  items?: unknown;
  delivery_kind?: unknown;
  delivery_address?: unknown;
  observations?: unknown;
}): string | null {
  if (
    !Array.isArray(input.items) ||
    !input.items.length ||
    !['delivery', 'retirada'].includes(String(input.delivery_kind)) ||
    typeof input.delivery_address !== 'string'
  )
    return null;
  const items: PaymentLinkItem[] = [];
  for (const item of input.items) {
    if (
      !item ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      exactBrlCents(item.unitPrice) === null ||
      (item.id !== undefined &&
        (typeof item.id !== 'string' || !item.id.trim())) ||
      (item.description !== undefined && typeof item.description !== 'string')
    )
      return null;
    items.push(item);
  }
  return openPaymentFingerprint({
    items,
    delivery_kind: String(input.delivery_kind),
    delivery_address: input.delivery_address,
    observations:
      typeof input.observations === 'string' ? input.observations : '',
  });
}

/** Fixed fields and sorted lines: JSONB key order and UI line order are not
 * payment identities. Trim only title/address boundaries in every writer and
 * legacy recovery. Keep duplicates, SKU, description and exact minor units. */
export function openPaymentFingerprint(input: {
  items: PaymentLinkItem[];
  delivery_kind: string;
  delivery_address: string;
  observations?: string;
}): string {
  const lines = input.items
    .map((item) =>
      JSON.stringify([
        item.id ?? null,
        item.title.trim(),
        `${item.description ?? ''}${input.observations ? `\nObservações: ${input.observations}` : ''}`,
        item.quantity,
        exactBrlCents(item.unitPrice),
      ])
    )
    .sort();
  return createHash('sha256')
    .update(
      JSON.stringify([
        'quick-payment-v1',
        lines,
        input.delivery_kind,
        input.delivery_address.trim(),
      ])
    )
    .digest('hex');
}
