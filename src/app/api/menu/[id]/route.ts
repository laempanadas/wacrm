// ============================================================
// /api/menu/[id] — update or delete a menu item
//
// PATCH:  Update fields (e.g. toggle availability, change price/name).
// DELETE: Delete an item from the menu.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole('agent');

    const body = (await request.json().catch(() => null)) as {
      is_available?: unknown;
      name?: unknown;
      price?: unknown;
      category?: unknown;
      description?: unknown;
      emoji?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Corpo da requisição inválido.' },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = {};

    if (body.is_available !== undefined) {
      updates.is_available = Boolean(body.is_available);
    }

    if (typeof body.name === 'string') {
      const trimmed = body.name.trim();
      if (!trimmed) {
        return NextResponse.json(
          { error: 'Nome não pode ser vazio.' },
          { status: 400 }
        );
      }
      updates.name = trimmed;
    }

    if (body.price !== undefined) {
      const priceNum =
        typeof body.price === 'number'
          ? body.price
          : typeof body.price === 'string'
            ? parseFloat(body.price.replace(',', '.'))
            : NaN;
      if (isNaN(priceNum) || priceNum < 0) {
        return NextResponse.json(
          { error: 'Preço inválido.' },
          { status: 400 }
        );
      }
      updates.price = priceNum;
    }

    if (typeof body.category === 'string') {
      const cat = body.category.trim();
      if (!cat) {
        return NextResponse.json(
          { error: 'Categoria não pode ser vazia.' },
          { status: 400 }
        );
      }
      updates.category = cat;
    }

    if (body.description !== undefined) {
      updates.description =
        typeof body.description === 'string' ? body.description.trim() || null : null;
    }

    if (body.emoji !== undefined) {
      updates.emoji =
        typeof body.emoji === 'string' ? body.emoji.trim() || '🥟' : '🥟';
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'Nenhum campo para atualizar informado.' },
        { status: 400 }
      );
    }

    const { data: updated, error } = await supabase
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('*')
      .single();

    if (error) {
      console.error('[PATCH /api/menu/[id]] error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json(
        { error: 'Item não encontrado.' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      item: {
        ...updated,
        price: Number(updated.price),
        is_available: Boolean(updated.is_available),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole('agent');

    const { error } = await supabase
      .from('menu_items')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) {
      console.error('[DELETE /api/menu/[id]] error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
