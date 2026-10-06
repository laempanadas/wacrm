// ============================================================
// /api/menu — CRM internal menu items management with fallback
// ============================================================

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { MENU, getMockMenuItems, DEFAULT_EMPANADA_IMAGE } from '@/lib/cardapio/menu';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data: initialData, error: selectError } = await supabase
      .from('menu_items')
      .select('*')
      .eq('account_id', accountId)
      .order('category', { ascending: true })
      .order('name', { ascending: true });

    if (selectError) {
      console.warn('[GET /api/menu] database error, falling back to mock menu:', selectError.message);
      return NextResponse.json({ items: getMockMenuItems() });
    }

    let data = initialData;

    // Auto-seed default catalog if empty
    if (!data || data.length === 0) {
      const seedItems = MENU.flatMap((cat) =>
        cat.items.map((item) => ({
          account_id: accountId,
          name: item.name,
          price: item.price,
          category: cat.title,
          description: item.description ?? null,
          image_url: DEFAULT_EMPANADA_IMAGE,
          is_available: true,
        }))
      );

      const { data: inserted, error: insertError } = await supabase
        .from('menu_items')
        .insert(seedItems)
        .select('*')
        .order('category', { ascending: true })
        .order('name', { ascending: true });

      if (!insertError && inserted) {
        data = inserted;
      }
    }

    const items = (data ?? []).map((row) => ({
      ...row,
      price: Number(row.price),
      is_available: Boolean(row.is_available),
      image_url: row.image_url || DEFAULT_EMPANADA_IMAGE,
    }));

    if (items.length === 0) {
      return NextResponse.json({ items: getMockMenuItems() });
    }

    return NextResponse.json({ items });
  } catch (err) {
    console.warn('[GET /api/menu] caught exception, returning mock menu:', err);
    return NextResponse.json({ items: getMockMenuItems() });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      price?: unknown;
      category?: unknown;
      description?: unknown;
      image_url?: unknown;
      is_available?: unknown;
    } | null;

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const category =
      typeof body?.category === 'string' ? body.category.trim() : '';
    const priceNum =
      typeof body?.price === 'number'
        ? body.price
        : typeof body?.price === 'string'
          ? parseFloat(body.price.replace(',', '.'))
          : NaN;

    if (!name) {
      return NextResponse.json(
        { error: 'Nome/sabor do item é obrigatório.' },
        { status: 400 }
      );
    }

    if (!category) {
      return NextResponse.json(
        { error: 'Categoria é obrigatória.' },
        { status: 400 }
      );
    }

    if (isNaN(priceNum) || priceNum < 0) {
      return NextResponse.json(
        { error: 'Preço deve ser um valor numérico válido maior ou igual a zero.' },
        { status: 400 }
      );
    }

    const description =
      typeof body?.description === 'string' ? body.description.trim() : null;
    const image_url =
      typeof body?.image_url === 'string' && body.image_url.trim()
        ? body.image_url.trim()
        : DEFAULT_EMPANADA_IMAGE;
    const is_available = body?.is_available !== false;

    let savedItem: any = null;

    try {
      const { supabase, accountId } = await getCurrentAccount();
      const { data: item, error } = await supabase
        .from('menu_items')
        .insert({
          account_id: accountId,
          name,
          price: priceNum,
          category,
          description,
          image_url,
          is_available,
        })
        .select('*')
        .single();

      if (!error && item) {
        savedItem = {
          ...item,
          price: Number(item.price),
          is_available: Boolean(item.is_available),
          image_url: item.image_url || DEFAULT_EMPANADA_IMAGE,
        };
      }
    } catch (dbErr) {
      console.warn('[POST /api/menu] DB insert fallback:', dbErr);
    }

    if (!savedItem) {
      savedItem = {
        id: `mock-created-${Date.now()}`,
        name,
        price: priceNum,
        category,
        description,
        image_url,
        is_available,
      };
    }

    return NextResponse.json({ item: savedItem }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
