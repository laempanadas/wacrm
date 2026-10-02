/**
 * Currency — single source of truth for deal-value formatting and
 * the currency picker options.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 */

/** App-wide fallback when no account/deal currency is available. */
export const DEFAULT_CURRENCY = "BRL";

export interface CurrencyOption {
  /** ISO-4217 code, e.g. "USD". Stored verbatim in the DB. */
  code: string;
  /** Human label for the dropdown, e.g. "US Dollar". */
  label: string;
  /** Symbol for compact display, e.g. "$". */
  symbol: string;
}

/**
 * The currencies offered in pickers. Codes must be valid ISO-4217 so
 * `Intl.NumberFormat` renders the right symbol/grouping. Extend this
 * list to offer more — nothing else needs to change.
 */
export const CURRENCIES: CurrencyOption[] = [
  { code: "USD", label: "US Dollar", symbol: "$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British Pound", symbol: "£" },
  { code: "INR", label: "Indian Rupee", symbol: "₹" },
  { code: "AUD", label: "Australian Dollar", symbol: "A$" },
  { code: "CAD", label: "Canadian Dollar", symbol: "C$" },
  { code: "BRL", label: "Brazilian Real", symbol: "R$" },
  { code: "JPY", label: "Japanese Yen", symbol: "¥" },
  { code: "CNY", label: "Chinese Yuan", symbol: "¥" },
  { code: "AED", label: "UAE Dirham", symbol: "د.إ" },
  { code: "ZAR", label: "South African Rand", symbol: "R" },
  { code: "NGN", label: "Nigerian Naira", symbol: "₦" },
  { code: "SGD", label: "Singapore Dollar", symbol: "S$" },
  { code: "MXN", label: "Mexican Peso", symbol: "$" },
];

/**
 * Format a deal value as a currency string with locale-specific formatting.
 * For BRL (Brazilian Real), uses pt-BR locale to display "R$ 1.234,56".
 * For other currencies, uses their default locale representation.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carries
 * NO DB CHECK (only `accounts.default_currency` does), so legacy
 * rows, imports, or hand-edited data can hold malformed values like
 * "United States". We never let that crash a render — on a bad code
 * we fall back to "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  // Use pt-BR locale for Brazilian Real to display "R$ 1.234,56"
  // For other currencies, use undefined (browser default)
  const locale = code === "BRL" ? "pt-BR" : undefined;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)}`;
  }
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "R$ 1,2M" / "€34,5k" / "₹900". Uses the currency's symbol from
 * CURRENCIES, falling back to the code when we don't carry a symbol.
 * For Brazilian Real, uses comma as decimal separator (pt-BR locale).
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = CURRENCIES.find((c) => c.code === code)?.symbol ?? `${code} `;
  const v = Number(value || 0);
  // Use comma as decimal separator for pt-BR
  const decimalSeparator = code === "BRL" ? "," : ".";
  const toFixedValue = (num: number, digits: number) => {
    const fixed = num.toFixed(digits);
    if (code === "BRL") {
      return fixed.replace(".", ",");
    }
    return fixed;
  };
  if (v >= 1_000_000) return `${symbol}${toFixedValue(v / 1_000_000, 1)}M`;
  if (v >= 1_000) return `${symbol}${toFixedValue(v / 1_000, 1)}k`;
  return `${symbol}${toFixedValue(v, 0)}`;
}
