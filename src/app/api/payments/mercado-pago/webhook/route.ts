import { NextRequest, NextResponse } from 'next/server';
import {
  createClient as createAdminClient,
  SupabaseClient,
} from '@supabase/supabase-js';
import { sendPaymentConfirmationWhatsApp } from '@/lib/whatsapp/send-message';
import { engineSendText } from '@/lib/flows/meta-send';
import { getPaymentById } from '@/lib/payments/mercado-pago';
import { paymentMatchesOrder } from '@/lib/payments/payment-identity';
import { markContactPaymentConfirmed } from '@/lib/orders/create-order';
import { saveContactOrderFields } from '@/lib/orders/custom-fields';
import { resolveStage, PIPELINE_STAGES } from '@/lib/orders/pipeline-stages';
import {
  ORDER_STATUS_PAID,
  extractPaymentId,
  isOrderPaid,
  isValidMercadoPagoSignature,
} from '@/lib/payments/mercado-pago-webhook';

/**
 * Cliente com service-role: o Mercado Pago chama o webhook sem sessão de
 * usuário, então o cliente com cookies (RLS) não enxerga orders/contacts.
 */
let _mpAdminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_mpAdminClient) {
    _mpAdminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _mpAdminClient;
}

const formatBRL = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

/**
 * Confirma o pagamento ao cliente. Texto livre primeiro (o cliente acabou
 * de conversar com o bot, então a janela de 24h está aberta) e registrado
 * na conversa do inbox; se falhar, tenta o template aprovado.
 * Best-effort: nunca derruba o webhook.
 */
async function notifyCustomer(order: {
  id: string;
  account_id: string;
  contact_id: string;
  delivery_address: string | null;
  amount: number;
}): Promise<void> {
  const db = supabaseAdmin();
  const lines = [
    '✅ *Pagamento aprovado!*',
    '',
    `Recebemos ${formatBRL(order.amount)}. Seu pedido já foi para a cozinha 🔥`,
  ];
  if (order.delivery_address?.trim()) {
    lines.push('', `🛵 Entrega em: _${order.delivery_address.trim()}_`);
  }
  lines.push('', 'Obrigado pela preferência! 🥟');

  try {
    const { data: conversation, error: conversationError } = await db
      .from('conversations')
      .select('id, user_id')
      .eq('account_id', order.account_id)
      .eq('contact_id', order.contact_id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversation) throw new Error('conversation not found');

    await engineSendText({
      accountId: order.account_id,
      userId: conversation.user_id ?? '',
      conversationId: conversation.id,
      contactId: order.contact_id,
      text: lines.join('\n'),
    });
    return;
  } catch (err) {
    console.warn(
      '[mp-webhook] Texto de confirmação falhou, tentando template:',
      err instanceof Error ? err.message : err
    );
  }

  try {
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('phone')
      .eq('id', order.contact_id)
      .eq('account_id', order.account_id)
      .maybeSingle();
    if (contactError) throw contactError;
    if (!contact?.phone) throw new Error('contact phone not found');
    await sendPaymentConfirmationWhatsApp(
      db,
      order.account_id,
      contact.phone,
      order.id,
      order.amount
    );
  } catch (err) {
    console.error(
      '[mp-webhook] Não foi possível confirmar o pagamento ao cliente:',
      err
    );
  }
}

/** Payment follow-up must not use moveDealToStage: its legacy order sync
 * overwrites paid with payment_approved and lets duplicate webhooks notify twice.
 * Validate pipeline ownership, then update only the account-bound deal. */
async function updatePaidDeal(
  db: SupabaseClient,
  accountId: string,
  dealId: string,
  paidAmount: number
) {
  const deal = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('account_id', accountId)
    .eq('id', dealId)
    .maybeSingle();
  if (deal.error) throw deal.error;
  if (!deal.data) throw new Error('Linked deal missing');
  const pipeline = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', deal.data.pipeline_id)
    .maybeSingle();
  if (pipeline.error) throw pipeline.error;
  if (!pipeline.data) throw new Error('Linked pipeline missing');
  const stage = await resolveStage(
    db,
    pipeline.data.id,
    PIPELINE_STAGES.COOKING
  );
  if (!stage) throw new Error('Cooking stage missing');
  const saved = await db
    .from('deals')
    .update({
      value: paidAmount,
      stage_id: stage.id,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
    .eq('id', dealId)
    .select('id')
    .maybeSingle();
  if (saved.error) throw saved.error;
  if (!saved.data?.id) throw new Error('Deal payment update not persisted');
}

/** Tag "Confirmado" on the contact. Best-effort. */
async function tagContactConfirmed(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<void> {
  try {
    // tags.user_id is required; the contact's owner is the natural author.
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('user_id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (contactError) throw contactError;
    if (!contact?.user_id) throw new Error('Contact owner missing');
    await markContactPaymentConfirmed(
      db,
      { accountId, userId: (contact?.user_id as string | undefined) ?? '' },
      contactId
    );
  } catch (err) {
    console.error('[mp-webhook] Erro ao aplicar tag Confirmado:', err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    let body: unknown = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    const query = req.nextUrl.searchParams;

    const paymentId = extractPaymentId(body, query);
    if (!paymentId) {
      // merchant_order, testes do painel etc. — nada a fazer.
      return new Response('Ignored', { status: 200 });
    }

    // A assinatura é defesa extra: o pagamento é sempre reconsultado na API
    // do Mercado Pago abaixo, então um id forjado não marca nada como pago.
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim();
    if (secret) {
      const valid = isValidMercadoPagoSignature({
        xSignature: req.headers.get('x-signature'),
        xRequestId: req.headers.get('x-request-id'),
        dataId: query.get('data.id') ?? paymentId,
        secret,
      });
      if (!valid) {
        console.warn('[mp-webhook] Assinatura inválida rejeitada', {
          paymentId,
        });
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 401 }
        );
      }
    } else {
      console.warn(
        '[mp-webhook] MERCADO_PAGO_WEBHOOK_SECRET não configurado — assinatura não validada'
      );
    }

    const payment = await getPaymentById(paymentId);
    if (!payment.ok) {
      // 500 faz o Mercado Pago reenviar a notificação mais tarde.
      return NextResponse.json(
        { error: 'Could not fetch payment' },
        { status: 500 }
      );
    }

    const externalReference = payment.externalReference;
    if (!externalReference || !payment.preferenceId) {
      return NextResponse.json(
        {
          error:
            payment.identityError ??
            'Unlinked payment; reconciliation required',
        },
        { status: 409 }
      );
    }

    const db = supabaseAdmin();
    const { data: order, error: orderError } = await db
      .from('orders')
      .select(
        'id, total, status, contact_id, deal_id, account_id, preference_id, external_reference, items, delivery_address, payer_name, created_at, payment_conversation_id'
      )
      .eq('preference_id', payment.preferenceId)
      .maybeSingle();

    if (orderError) {
      console.error('[mp-webhook] Erro ao buscar pedido:', orderError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (
      !order ||
      !order.account_id ||
      order.external_reference !== externalReference
    ) {
      console.warn(
        '[mp-webhook] Pedido não encontrado para external_reference:',
        externalReference
      );
      return NextResponse.json(
        { error: 'Unknown payment binding; reconciliation required' },
        { status: 409 }
      );
    }

    // Check identity, exact amount and BRL BEFORE any status mutation,
    // including rejections. Missing gateway data never defaults to order.total.
    if (!paymentMatchesOrder(payment, order)) {
      return NextResponse.json(
        { error: 'Payment does not match order' },
        { status: 409 }
      );
    }

    // Service-role FK integrity is not implied by a payment preference.
    // Corrupt/foreign links must fail BEFORE order status or contact/deal writes.
    if (order.contact_id) {
      const contact = await db
        .from('contacts')
        .select('id')
        .eq('account_id', order.account_id)
        .eq('id', order.contact_id)
        .maybeSingle();
      if (contact.error) throw contact.error;
      if (!contact.data)
        return NextResponse.json(
          { error: 'Invalid contact ownership; reconciliation required' },
          { status: 409 }
        );
    }
    if (order.deal_id) {
      const deal = await db
        .from('deals')
        .select('id, contact_id, pipeline_id')
        .eq('account_id', order.account_id)
        .eq('id', order.deal_id)
        .maybeSingle();
      if (deal.error) throw deal.error;
      if (
        !deal.data ||
        (order.contact_id && deal.data.contact_id !== order.contact_id)
      ) {
        return NextResponse.json(
          { error: 'Invalid deal ownership; reconciliation required' },
          { status: 409 }
        );
      }
      const pipeline = await db
        .from('pipelines')
        .select('id')
        .eq('account_id', order.account_id)
        .eq('id', deal.data.pipeline_id)
        .maybeSingle();
      if (pipeline.error) throw pipeline.error;
      if (!pipeline.data)
        return NextResponse.json(
          { error: 'Invalid pipeline ownership; reconciliation required' },
          { status: 409 }
        );
    }

    // O Mercado Pago manda várias notificações por pagamento.
    if (isOrderPaid(order.status)) {
      return new Response('OK', { status: 200 });
    }

    if (payment.status !== 'approved') {
      if (payment.status === 'rejected' || payment.status === 'in_process') {
        const changed = await db
          .from('orders')
          .update({ status: payment.status })
          .eq('account_id', order.account_id)
          .eq('preference_id', payment.preferenceId)
          .eq('external_reference', externalReference)
          .eq('id', order.id)
          .or(`status.is.null,status.neq.${ORDER_STATUS_PAID}`)
          .select('id');
        if (changed.error) throw changed.error;
        if (!changed.data?.length) {
          const current = await db
            .from('orders')
            .select('status')
            .eq('account_id', order.account_id)
            .eq('id', order.id)
            .maybeSingle();
          if (current.error) throw current.error;
          if (!current.data || !isOrderPaid(current.data.status))
            throw new Error('Order status update not persisted');
        }
      }
      console.log(
        `[mp-webhook] Pedido ${order.id}: pagamento ${payment.rawStatus}`
      );
      return new Response('OK', { status: 200 });
    }

    const paidAmount = payment.paidAmount!;
    // Contact fields/tags and inbox closure describe the CURRENT purchase, not
    // whichever historical preference happened to settle last. Unknown legacy
    // timestamps are ambiguous: settle the bound order but leave the contact.
    let hasNewerOpenOrder = false;
    if (order.contact_id) {
      const others = await db
        .from('orders')
        .select('id, created_at')
        .eq('account_id', order.account_id)
        .eq('contact_id', order.contact_id)
        .neq('id', order.id)
        .or('status.is.null,status.neq.paid');
      if (others.error) throw others.error;
      if (!others.data)
        throw new Error('Could not verify current contact purchase');
      const paidCreatedAt = Date.parse(order.created_at ?? '');
      hasNewerOpenOrder = others.data.some((other) => {
        const otherCreatedAt = Date.parse(other.created_at ?? '');
        return (
          !Number.isFinite(paidCreatedAt) ||
          !Number.isFinite(otherCreatedAt) ||
          otherCreatedAt >= paidCreatedAt
        );
      });
    }

    // Só quem efetivamente muda o status confirma ao cliente — duas
    // notificações simultâneas não geram duas mensagens.
    const { data: transitioned, error: updateError } = await db
      .from('orders')
      .update({ status: ORDER_STATUS_PAID })
      .eq('account_id', order.account_id)
      .eq('preference_id', payment.preferenceId)
      .eq('external_reference', externalReference)
      .eq('id', order.id)
      .or(`status.is.null,status.neq.${ORDER_STATUS_PAID}`)
      .select('id');

    if (updateError) {
      console.error(
        '[mp-webhook] Erro ao atualizar status do pedido:',
        updateError
      );
      return NextResponse.json(
        { error: 'Database update error' },
        { status: 500 }
      );
    }
    if (!transitioned?.length) {
      const current = await db
        .from('orders')
        .select('status')
        .eq('account_id', order.account_id)
        .eq('id', order.id)
        .maybeSingle();
      if (current.error) throw current.error;
      if (!current.data || !isOrderPaid(current.data.status))
        throw new Error('Paid transition not persisted');
      return new Response('OK', { status: 200 });
    }
    console.log(`[mp-webhook] Pedido ${order.id} pago (${externalReference})`);

    if (order.deal_id) {
      try {
        await updatePaidDeal(db, order.account_id, order.deal_id, paidAmount);
      } catch (error) {
        console.warn(
          '[mp-webhook] Payment persisted; deal follow-up needs reconciliation:',
          error
        );
      }
    }

    if (order.account_id && order.contact_id && !hasNewerOpenOrder) {
      await tagContactConfirmed(db, order.account_id, order.contact_id);

      await notifyCustomer({
        id: order.id,
        account_id: order.account_id,
        contact_id: order.contact_id,
        delivery_address: order.delivery_address,
        amount: paidAmount,
      });

      // Preenche/atualiza os campos personalizados do contato após o
      // pagamento aprovado. Best-effort: nunca interrompe o fluxo principal.
      let itensPedido: string | undefined;
      try {
        const rawItems = order.items;
        const parsedItems =
          typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
        if (Array.isArray(parsedItems) && parsedItems.length > 0) {
          itensPedido = parsedItems
            .map(
              (it: {
                quantity?: number;
                qty?: number;
                title?: string;
                name?: string;
              }) => {
                const qty = it.quantity ?? it.qty ?? 1;
                const title = it.title ?? it.name ?? 'Item';
                return `${qty}x ${title}`;
              }
            )
            .join(', ');
        }
      } catch {
        itensPedido = undefined;
      }

      await saveContactOrderFields(db, order.account_id, order.contact_id, {
        formaPagamento: 'Pago ✅ Mercado Pago',
        enderecoCompleto: order.delivery_address ?? undefined,
        nomeCliente: order.payer_name ?? undefined,
        itensUltimoPedido: itensPedido,
      });

      // Legacy orders have no originating conversation: do not guess the
      // current inbox or close every conversation belonging to the contact.
      if (order.payment_conversation_id) {
        const { error: closeError } = await db
          .from('conversations')
          .update({ status: 'closed', updated_at: new Date().toISOString() })
          .eq('account_id', order.account_id)
          .eq('contact_id', order.contact_id)
          .eq('id', order.payment_conversation_id);
        if (closeError) {
          console.error(
            '[mp-webhook] Erro ao fechar conversa após pagamento:',
            closeError
          );
        }
      }
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[mp-webhook] Erro interno:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
