import type { PaymentStatusResult } from './mercado-pago';

/** Exact BRL minor units: no tolerance, fallback, rounding or NaN coercion. */
export function exactBrlCents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Existing Checkout Pro writers create BRL-only preferences. Legacy rows
 * without a verified preference are deliberately NOT guessed by reference. */
export function paymentMatchesOrder(
  payment: PaymentStatusResult,
  order: {
    account_id?: string;
    preference_id?: string;
    external_reference?: string;
    total?: unknown;
  }
): boolean {
  const amount = exactBrlCents(payment.paidAmount);
  return Boolean(
    order.account_id &&
    payment.preferenceId &&
    payment.collectorId &&
    order.preference_id === payment.preferenceId &&
    order.external_reference === payment.externalReference &&
    payment.currency === 'BRL' &&
    amount !== null &&
    amount === exactBrlCents(order.total)
  );
}
