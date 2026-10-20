import { parseTextOrder } from './text-order-parser';
import type { OrderDraft } from './order-draft';

export function isExplicitNewOrder(text: string): boolean {
  return /^(?:novo pedido|outro pedido|quero (?:fazer )?(?:um )?novo pedido)\s*[:,-]?\s*/i.test(
    text.trim()
  );
}

export function newOrderText(text: string): string {
  return isExplicitNewOrder(text)
    ? text
        .trim()
        .replace(
          /^(?:novo pedido|outro pedido|quero (?:fazer )?(?:um )?novo pedido)\s*[:,-]?\s*/i,
          ''
        )
    : text;
}

export function shouldStartNewDraft(
  draft: OrderDraft,
  text: string,
  paymentStatus: string | null,
  lastCartActivity: number,
  now = Date.now()
): boolean {
  if (
    paymentStatus === 'checkout_processing' ||
    paymentStatus === 'checkout_uncertain'
  )
    return false;
  if (!hasFreshOrderIntent(text)) return false;
  if (isExplicitNewOrder(text)) return true;
  if (
    paymentStatus &&
    ['paid', 'payment_approved', 'completed', 'cancelled'].includes(
      paymentStatus
    )
  )
    return true;
  if (paymentStatus || draft.stage === 'payment_created') return false;
  return (
    Number.isFinite(lastCartActivity) &&
    now - lastCartActivity >= 24 * 60 * 60 * 1000
  );
}

export function hasFreshOrderIntent(text: string): boolean {
  const clean = newOrderText(text).trim();
  return (
    /^(?:quero|vou querer|gostaria(?: de)?|manda|envia|\d+)\b/i.test(clean) &&
    parseTextOrder(clean).hasItems
  );
}
