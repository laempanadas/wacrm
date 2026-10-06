// ============================================================
// /api/menu — CRM internal menu items management
//
// GET:  List items for the current account (auto-seeds default if empty).
// POST: Create a new item (agent+).
// ============================================================

import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { MENU } from '@/lib/cardapio/menu';

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
      console.error('[GET /api/menu] database error:', selectError);
      return NextResponse.json({ error: selectError.message }, { status: 500 });
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
          emoji: item.emoji ?? null,
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
    }));

    return NextResponse.json({ items });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      price?: unknown;
      category?: unknown;
      description?: unknown;
      emoji?: unknown;
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
    const emoji =
      typeof body?.emoji === 'string' && body.emoji.trim()
        ? body.emoji.trim()
        : '🥟';
    const is_available = body?.is_available !== false;

    const { data: item, error } = await supabase
      .from('menu_items')
      .insert({
        account_id: accountId,
        name,
        price: priceNum,
        category,
        description,
        emoji,
        is_available,
      })
      .select('*')
      .single();

    if (error) {
      console.error('[POST /api/menu] insert error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      {
        item: {
          ...item,
          price: Number(item.price),
          is_available: Boolean(item.is_available),
        },
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
