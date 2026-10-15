import type { SupabaseClient } from '@supabase/supabase-js';
import {
  aliasesForCatalogName,
  type ProductCatalogEntry,
} from './text-order-parser';

interface CatalogRow {
  id: string;
  name: string;
  price: number | string;
  is_available: boolean;
}

export function catalogEntries(rows: CatalogRow[]): ProductCatalogEntry[] {
  const all = rows.map((row) => ({
    row,
    aliases: aliasesForCatalogName(row.name),
  }));
  const owners = new Map<string, Set<string>>();
  for (const entry of all)
    for (const alias of entry.aliases) {
      const ids = owners.get(alias) ?? new Set<string>();
      ids.add(entry.row.id);
      owners.set(alias, ids);
    }
  return all
    .filter(
      ({ row }) =>
        row.is_available &&
        Number.isFinite(Number(row.price)) &&
        Number(row.price) > 0
    )
    .map(({ row, aliases }) => ({
      id: row.id,
      nome: row.name,
      preco: Number(row.price),
      aliases: aliases.filter((alias) => owners.get(alias)?.size === 1),
    }));
}

export async function loadOrderCatalog(
  db: SupabaseClient,
  accountId: string
): Promise<ProductCatalogEntry[]> {
  const { data, error } = await db
    .from('menu_items')
    .select('id, name, price, is_available')
    .eq('account_id', accountId);
  if (error)
    throw new Error(`Não foi possível validar o catálogo: ${error.message}`);
  // No mock/static fallback for commerce: an empty catalog requires human help.
  return catalogEntries((data ?? []) as CatalogRow[]);
}
