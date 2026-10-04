import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  ORDERS_PIPELINE_NAME,
  markContactPaymentConfirmed,
} from '@/lib/orders/create-order';
import { markDealPaid } from '@/lib/orders/mark-deal-paid';
import { ORDER_STATUS_PAID } from '@/lib/payments/mercado-pago-webhook';

/**
 * POST /api/deals/[id]/mark-paid
 *
 * "Marcar como Pago" no card. Marca o deal como won e, se for um pedido
 * (pipeline "Pedidos Delivery"), faz o mesmo que o webhook do Mercado
 * Pago faz num pagamento online: move o card para "Pago", aplica a tag
 * "Confirmado" e fecha o pedido em `orders` para o lembrete de pagamento
 * parar. É o caminho da retirada, paga na loja.
 *
 * Roda no servidor porque criar a etapa "Pago" exige admin no RLS e
 * quem marca o pagamento no balcão costuma ser agent.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const admin = supabaseAdmin();

    const { data: deal, error: dealErr } = await admin
      .from('deals')
      .select('id, contact_id, pipeline_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (dealErr) {
      console.error('[mark-paid] deal lookup error:', dealErr);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
    if (!deal)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { data: pipeline } = await admin
      .from('pipelines')
      .select('name')
      .eq('id', deal.pipeline_id)
      .maybeSingle();

    if (pipeline?.name !== ORDERS_PIPELINE_NAME) {
      const { error } = await admin
        .from('deals')
        .update({ status: 'won', updated_at: new Date().toISOString() })
        .eq('id', deal.id);
      if (error) {
        console.error('[mark-paid] deal update error:', error);
        return NextResponse.json(
          { error: 'Internal server error' },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, moved: false });
    }

    const result = await markDealPaid(admin, {
      accountId: ctx.accountId,
      dealId: deal.id,
    });
    if (!result.moved) {
      console.error('[mark-paid] could not move deal:', result.reason);
      return NextResponse.json(
        { error: 'Could not move deal to "Pago"' },
        { status: 500 }
      );
    }

    // Best-effort: o card já está em "Pago"; falhas aqui só vão para o log.
    try {
      await markContactPaymentConfirmed(
        admin,
        { accountId: ctx.accountId, userId: ctx.userId },
        deal.contact_id
      );
    } catch (err) {
      console.error('[mark-paid] tag error:', err);
    }

    const { error: orderErr } = await admin
      .from('orders')
      .update({ status: ORDER_STATUS_PAID })
      .eq('account_id', ctx.accountId)
      .eq('deal_id', deal.id);
    if (orderErr) {
      console.warn('[mark-paid] orders update skipped:', orderErr.message);
    }

    return NextResponse.json({
      ok: true,
      moved: true,
      stageId: result.stageId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
