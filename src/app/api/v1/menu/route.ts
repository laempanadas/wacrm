// ============================================================
// GET /api/v1/menu — public API menu items & availability.
//
// Authenticated via `Authorization: Bearer <API_KEY>`.
// Returns the products for the authenticated account with their
// availability status (`is_available`), allowing external sites
// (e.g. laempanadas.com.br) to disable buy buttons and tag out-of-stock items.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse, fail } from '@/lib/api/v1/respond';
import { MENU, DEFAULT_EMPANADA_IMAGE } from '@/lib/cardapio/menu';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request);

    const { data: initialData, error: selectError } = await ctx.supabase
      .from('menu_items')
      .select(
        'id, name, price, category, is_available, description, image_url, created_at, updated_at'
      )
      .eq('account_id', ctx.accountId)
      .order('category', { ascending: true })
      .order('name', { ascending: true });

    if (selectError) {
      console.error('[api/v1/menu] error querying menu items:', selectError);
      return fail('internal', 'Failed to retrieve menu items', 500);
    }

    let data = initialData;

    // Auto-seed from default catalog if table is empty for this account
    if (!data || data.length === 0) {
      const seedItems = MENU.flatMap((cat) =>
        cat.items.map((item) => ({
          account_id: ctx.accountId,
          name: item.name,
          price: item.price,
          category: cat.title,
          description: item.description ?? null,
          image_url: DEFAULT_EMPANADA_IMAGE,
          is_available: true,
        }))
      );

      const { data: inserted, error: insertError } = await ctx.supabase
        .from('menu_items')
        .insert(seedItems)
        .select(
          'id, name, price, category, is_available, description, image_url, created_at, updated_at'
        )
        .order('category', { ascending: true })
        .order('name', { ascending: true });

      if (!insertError && inserted) {
        data = inserted;
      }
    }

    const items = (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      price: Number(row.price),
      category: row.category,
      is_available: Boolean(row.is_available),
      description: row.description || null,
      image_url: row.image_url || DEFAULT_EMPANADA_IMAGE,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return ok(items);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
