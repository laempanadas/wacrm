import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sanitizeTagsAndCustomFields } from '@/lib/orders/sanitize-tags';

/**
 * POST /api/admin/sanitize-tags
 *
 * Higieniza tags e custom fields da conta do usuário autenticado:
 * - Funde 'aguardando_pagamento' em 'Aguardando Pagamento'
 * - Remove tags de variáveis de flow e etapas do Kanban
 * - Garante custom fields oficiais de Delivery
 * - Migra dados legados
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const admin = supabaseAdmin();

    const stats = await sanitizeTagsAndCustomFields(admin, ctx.accountId);

    return NextResponse.json({
      ok: true,
      stats,
      message:
        'Higienização de tags e campos customizados concluída com sucesso.',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
