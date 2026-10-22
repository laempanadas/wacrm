import type { SupabaseClient } from '@supabase/supabase-js';
import { getExistingPaymentLink } from '@/lib/payments/mercado-pago';
import { exactBrlCents } from '@/lib/payments/payment-identity';
import { openPaymentFingerprint } from '@/lib/payments/open-payment-identity';
import { isCompleteDeliveryAddress } from '@/lib/orders/text-order-parser';
import type { OrderDraft } from '@/lib/orders/order-draft';

export type AiTotal =
  | { kind: 'none'; text: string }
  | { kind: 'invalid'; text: string }
  | { kind: 'valid'; text: string; cents: number };

/** A model control is a request to validate, never authority to charge. */
export function parseAiTotal(raw: string): AiTotal {
  // Count openings independently: malformed, multiline and nested controls
  // must not disappear from the count just because their body is invalid.
  const openings = [...raw.matchAll(/\[\s*TOTAL\b/gi)];
  if (!openings.length) return { kind: 'none', text: raw.trim() };
  const fragments: string[] = [];
  let cursor = 0;
  let control = '';
  for (const opening of openings) {
    if (opening.index < cursor) continue;
    fragments.push(raw.slice(cursor, opening.index));
    let end = opening.index;
    let depth = 0;
    // Strip the whole balanced fragment, including nested brackets; an
    // unterminated fragment consumes the remainder rather than leaking it.
    do {
      if (raw[end] === '[') depth++;
      if (raw[end] === ']') depth--;
      end++;
    } while (end < raw.length && depth > 0);
    control = raw.slice(opening.index, end);
    cursor = end;
  }
  const text = (fragments.join('') + raw.slice(cursor)).trim();
  const match =
    openings.length === 1 && /^\[TOTAL:([1-9]\d*|0)\.(\d{2})\]$/.exec(control);
  const cents = match ? Number(match[1]) * 100 + Number(match[2]) : 0;
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 99999999)
    return { kind: 'invalid', text };
  return { kind: 'valid', text, cents };
}

export const AI_PAYMENT_CLARIFICATION =
  'Antes de enviar o pagamento, preciso conferir os itens, quantidades, endereço e sua confirmação do pedido. Qual informação deseja completar ou corrigir? Nenhuma nova cobrança foi criada.';

export type AiPaymentResolution =
  | { kind: 'clarify'; text: string }
  | { kind: 'payment'; url: string; reference: string; cents: number };

/** Only an already-created canonical payment can authorize this AI CTA.
 * Creation/confirmation remains exclusively in the deterministic order engine.
 * In particular awaiting_confirmation is NOT persisted consent, and model prose,
 * a bare amount, "Pix feito", greetings and "pode confirmar" cannot supply it.
 */
export async function resolveAiPayment(
  db: SupabaseClient,
  scope: { accountId: string; conversationId: string; contactId: string },
  cents: number
): Promise<AiPaymentResolution> {
  const clarify = (text = AI_PAYMENT_CLARIFICATION): AiPaymentResolution => ({
    kind: 'clarify',
    text,
  });
  try {
    const { data, error } = await db
      .from('order_drafts')
      .select('state')
      .eq('account_id', scope.accountId)
      .eq('conversation_id', scope.conversationId)
      .eq('contact_id', scope.contactId)
      .maybeSingle();
    if (error) return clarify();
    const draft = data?.state as OrderDraft | undefined;
    if (!draft || !Array.isArray(draft.items) || !draft.items.length)
      return clarify(
        'Quais itens e quantidades você deseja pedir? Depois conferimos o endereço e o resumo antes de gerar o pagamento. Nenhuma cobrança foi criada.'
      );
    if (!isCompleteDeliveryAddress(draft.deliveryAddress || ''))
      return clarify(
        'Para conferir o pedido, envie o endereço completo: rua, número e bairro. Nenhuma nova cobrança foi criada.'
      );
    if (
      !Array.isArray(draft.unresolved) ||
      draft.unresolved.length ||
      draft.stage !== 'payment_created'
    )
      return clarify(
        'Confira os itens e o endereço no resumo do pedido e responda CONFIRMO O PEDIDO, ou envie a correção necessária. Nenhuma nova cobrança foi criada.'
      );
    const total = draft.items.reduce((sum, item) => {
      const unit = exactBrlCents(item.unitPrice);
      return unit !== null &&
        Number.isSafeInteger(item.quantity) &&
        item.quantity > 0
        ? sum + unit * item.quantity
        : NaN;
    }, 0);
    if (
      !Number.isSafeInteger(cents) ||
      cents <= 0 ||
      !Number.isSafeInteger(total) ||
      total !== cents ||
      exactBrlCents(draft.total) !== cents
    )
      return clarify(
        'O valor informado não corresponde ao pedido salvo. Quais itens ou quantidades deseja conferir? Nenhuma nova cobrança foi criada.'
      );
    if (!draft.id || !Number.isSafeInteger(draft.version) || draft.version < 0)
      return clarify();
    const reference =
      draft.paymentReference || `TEXT-${draft.id}-${draft.version}`;
    const { data: order, error: orderError } = await db
      .from('orders')
      .select(
        'id, account_id, contact_id, external_reference, preference_id, payment_url, status, total, payment_fingerprint'
      )
      .eq('account_id', scope.accountId)
      .eq('contact_id', scope.contactId)
      .eq('external_reference', reference)
      .maybeSingle();
    if (
      orderError ||
      !order?.id ||
      order.account_id !== scope.accountId ||
      order.contact_id !== scope.contactId ||
      order.external_reference !== reference ||
      order.status !== 'pending' ||
      !order.preference_id ||
      !order.payment_url ||
      exactBrlCents(order.total) !== cents
    )
      return clarify();
    const fingerprint = openPaymentFingerprint({
      items: draft.items.map((item) => ({
        id: item.id,
        title: item.title,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        description: item.notes,
      })),
      delivery_kind: 'delivery',
      delivery_address: draft.deliveryAddress ?? '',
      observations: '',
    });
    if (!order.payment_fingerprint || order.payment_fingerprint !== fingerprint)
      return clarify();
    // A globally unique preference must resolve back to this exact tenant/order.
    const binding = await db
      .from('orders')
      .select('id, account_id')
      .eq('preference_id', order.preference_id)
      .maybeSingle();
    if (
      binding.error ||
      binding.data?.id !== order.id ||
      binding.data?.account_id !== scope.accountId
    )
      return clarify();
    const url = await getExistingPaymentLink(order);
    return { kind: 'payment', url, reference, cents };
  } catch {
    // A stale/expired/uncertain checkout never becomes a new checkout or silent handoff.
    return clarify();
  }
}
