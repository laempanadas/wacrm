import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  moveDealToStage,
  PIPELINE_STAGES,
  type PipelineStage,
} from '@/lib/orders/pipeline-stages';
import { sendStageNotification } from '@/lib/deals/stage-notifications';

/**
 * POST /api/deals/[id]/move-stage
 *
 * Move um deal para um novo stage do pipeline e sincroniza order.status.
 * Requer role 'agent' ou superior.
 *
 * Body: { stage: "Na Cozinha" | "Pronto para Entrega" | "Entregue" | ... }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: dealId } = await params;
    const ctx = await requireRole('agent');
    const admin = supabaseAdmin();

    const body = (await request.json().catch(() => null)) as {
      stage?: unknown;
    } | null;
    const targetStage = body?.stage as string | undefined;

    if (
      !targetStage ||
      !Object.values(PIPELINE_STAGES).includes(targetStage as PipelineStage)
    ) {
      return NextResponse.json(
        {
          error:
            'Invalid stage. Valid stages: ' +
            Object.values(PIPELINE_STAGES).join(', '),
        },
        { status: 400 }
      );
    }

    const result = await moveDealToStage(admin, {
      accountId: ctx.accountId,
      dealId,
      targetStage: targetStage as PipelineStage,
    });

    if (!result.moved) {
      return NextResponse.json(
        { error: `Could not move deal: ${result.reason}` },
        { status: 400 }
      );
    }

    // Enviar notificação automática no WhatsApp (best-effort)
    try {
      const { data: deal } = await admin
        .from('deals')
        .select('contact_id')
        .eq('id', dealId)
        .maybeSingle();

      if (deal?.contact_id) {
        await sendStageNotification({
          db: admin,
          accountId: ctx.accountId,
          dealId,
          contactId: deal.contact_id,
          newStage: targetStage as PipelineStage,
        });
      }
    } catch (err) {
      console.warn('[move-stage] notification failed (non-blocking):', err);
    }

    return NextResponse.json({ ok: true, moved: true, stage: targetStage });
  } catch (err) {
    return toErrorResponse(err);
  }
}
