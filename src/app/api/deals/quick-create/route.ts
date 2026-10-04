import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  resolvePipeline,
  resolveStage,
  PIPELINE_STAGES,
} from '@/lib/orders/pipeline-stages';

/**
 * POST /api/deals/quick-create
 *
 * Cria um deal rápido com valor inicial (sem order record).
 * Útil para o painel lateral criar pedidos on-the-fly.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      contact_id?: unknown;
      value?: unknown;
      title?: unknown;
    } | null;

    const contactId =
      typeof body?.contact_id === 'string' ? body.contact_id : null;
    const value = typeof body?.value === 'number' ? body.value : null;
    const title = typeof body?.title === 'string' ? body.title : 'Novo Pedido';

    if (!contactId || value === null || value < 0) {
      return NextResponse.json(
        { error: 'contact_id e value (>= 0) são obrigatórios' },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();

    // Resolve pipeline e stage
    const pipelineResult = await resolvePipeline(db, ctx.accountId, ctx.userId);
    const stageResult = await resolveStage(
      db,
      pipelineResult.id,
      PIPELINE_STAGES.NEW_ORDER
    );

    if (!stageResult) {
      return NextResponse.json(
        { error: 'Could not resolve stage' },
        { status: 500 }
      );
    }

    // Cria deal
    const { data: deal, error: dealErr } = await db
      .from('deals')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        pipeline_id: pipelineResult.id,
        stage_id: stageResult.id,
        contact_id: contactId,
        title,
        value,
        currency: 'BRL',
        status: 'open',
        notes: 'Criado rapidamente pelo painel lateral',
      })
      .select('id')
      .single();

    if (dealErr) {
      console.error('[quick-create] deal error:', dealErr);
      return NextResponse.json(
        { error: 'Failed to create deal' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      dealId: deal.id,
      pipelineId: pipelineResult.id,
      stageId: stageResult.id,
    });
  } catch (err) {
    console.error('[quick-create] error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
