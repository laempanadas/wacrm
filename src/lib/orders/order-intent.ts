import {
  parseCatalogOrder,
  type ProductCatalogEntry,
} from './text-order-parser';

/** Routing priority is narrower than broad conversational/purchase intent.
 * A parser-inferred default quantity must never supersede a human pause. */
export function hasValidatedQuantifiedOrderIntent(
  text: string,
  catalog: ProductCatalogEntry[]
): boolean {
  const parsed = parseCatalogOrder(text, catalog);
  return (
    !parsed.unresolved?.length &&
    parsed.items.some((item) => {
      const requested = (item.requestedText ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      return /^(?:\d+\s*(?:x\s*)?|(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|meia\s+duzia|uma\s+duzia)\b)/i.test(
        requested
      );
    })
  );
}
