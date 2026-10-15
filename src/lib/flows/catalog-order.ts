import type { ProductCatalogEntry } from '@/lib/orders/text-order-parser';
import type { Item } from '@/lib/orders/create-order-with-mercado-pago';

interface CatalogLine {
  retailer_id: string;
  name?: string;
  quantity: number;
  unit_price: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Never trust Meta's price or synthesize a generic line. */
export function groundCatalogOrder(
  lines: CatalogLine[],
  catalog: ProductCatalogEntry[],
  notes?: string
): { items: Item[]; total: number } {
  if (!lines.length || notes?.trim())
    throw new Error('Pedido exige revisão humana: itens ou observações.');
  const items = lines.map((line) => {
    // A UUID is an authoritative identifier: never repair a wrong UUID by name.
    const normalize = (value: string) =>
      value.trim().toLocaleLowerCase('pt-BR');
    const name = normalize(line.name ?? line.retailer_id);
    const matches = catalog.filter((entry) =>
      uuid.test(line.retailer_id)
        ? entry.id === line.retailer_id
        : [entry.nome, ...entry.aliases].some(
            (alias) => normalize(alias) === name
          )
    );
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0
    )
      throw new Error('Item não validado no catálogo da conta.');
    const entry = matches[0];
    if (!Number.isFinite(entry.preco) || entry.preco <= 0)
      throw new Error('Preço inválido.');
    return {
      id: entry.id,
      title: entry.nome,
      description: entry.nome,
      quantity: line.quantity,
      unitPrice: entry.preco,
    };
  });
  return {
    items,
    total:
      items.reduce(
        (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
        0
      ) / 100,
  };
}
