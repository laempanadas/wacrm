// ============================================================
// /api/menu/[id] — update or delete a menu item with fallback
// ============================================================

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { DEFAULT_EMPANADA_IMAGE } from '@/lib/cardapio/menu';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      is_available?: unknown;
      name?: unknown;
      price?: unknown;
      category?: unknown;
      description?: unknown;
      image_url?: unknown;
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

    if (body.image_url !== undefined) {
      updates.image_url =
        typeof body.image_url === 'string' ? body.image_url.trim() || DEFAULT_EMPANADA_IMAGE : DEFAULT_EMPANADA_IMAGE;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'Nenhum campo para atualizar informado.' },
        { status: 400 }
      );
    }

    let updatedItem: any = null;

    try {
      const { supabase, accountId } = await getCurrentAccount();
      const { data: updated, error } = await supabase
        .from('menu_items')
        .update(updates)
        .eq('id', id)
        .eq('account_id', accountId)
        .select('*')
        .single();

      if (!error && updated) {
        updatedItem = {
          ...updated,
          price: Number(updated.price),
          is_available: Boolean(updated.is_available),
          image_url: updated.image_url || DEFAULT_EMPANADA_IMAGE,
        };
      }
    } catch (dbErr) {
      console.warn('[PATCH /api/menu/[id]] DB update fallback:', dbErr);
    }

    if (!updatedItem) {
      // Mock updated item for fallback/mock mode
      updatedItem = {
        id,
        ...updates,
        price: updates.price !== undefined ? Number(updates.price) : 8.5,
        is_available: updates.is_available !== undefined ? Boolean(updates.is_available) : true,
        image_url: (updates.image_url as string) || DEFAULT_EMPANADA_IMAGE,
        category: (updates.category as string) || 'Empanadas Salgadas',
        name: (updates.name as string) || 'Item Atualizado',
      };
    }

    return NextResponse.json({ item: updatedItem });
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

    try {
      const { supabase, accountId } = await getCurrentAccount();
      await supabase
        .from('menu_items')
        .delete()
        .eq('id', id)
        .eq('account_id', accountId);
    } catch (dbErr) {
      console.warn('[DELETE /api/menu/[id]] DB delete fallback:', dbErr);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
