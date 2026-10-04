import { NextRequest, NextResponse } from 'next/server';
import {
  createClient as createAdminClient,
  SupabaseClient,
} from '@supabase/supabase-js';
import { sendPaymentConfirmationWhatsApp } from '@/lib/whatsapp/send-message';
import { engineSendText } from '@/lib/flows/meta-send';
import { getPaymentById } from '@/lib/payments/mercado-pago';
import { markContactPaymentConfirmed } from '@/lib/orders/create-order';
import { saveContactOrderFields } from '@/lib/orders/custom-fields';
import { moveDealToStage, PIPELINE_STAGES } from '@/lib/orders/pipeline-stages';
import { updateDealWithPayment } from '@/lib/deals/auto-deal-lifecycle';
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
    const { data: conversation } = await db
      .from('conversations')
      .select('id, user_id')
      .eq('account_id', order.account_id)
      .eq('contact_id', order.contact_id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
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
    const { data: contact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', order.contact_id)
      .maybeSingle();
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

/**
 * Moves the order's pipeline card to "Na Cozinha" (MVP: payment_approved).
 * Separate query for deal_id so an orders table without that column
 * can't break the payment confirmation. Best-effort.
 */
async function moveDealToCookingStage(
  db: SupabaseClient,
  accountId: string,
  orderId: string
): Promise<void> {
  try {
    const { data, error } = await db
      .from('orders')
      .select('deal_id')
      .eq('id', orderId)
      .maybeSingle();
    const dealId = (data as { deal_id?: string | null } | null)?.deal_id;
    if (error || !dealId) {
      console.warn(
        `[mp-webhook] Pedido ${orderId} sem deal vinculado — card não movido`,
        error?.message ?? ''
      );
      return;
    }
    const result = await moveDealToStage(db, {
      accountId,
      dealId,
      targetStage: PIPELINE_STAGES.COOKING,
    });
    if (result.moved) {
      console.log(`[mp-webhook] Card ${dealId} movido para "Na Cozinha"`);
    } else {
      console.warn(
        `[mp-webhook] Card do pedido ${orderId} não movido: ${result.reason}`
      );
    }
  } catch (err) {
    console.error('[mp-webhook] Erro ao mover card para "Na Cozinha":', err);
  }
}

/** Tag "Confirmado" on the contact. Best-effort. */
async function tagContactConfirmed(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<void> {
  try {
    // tags.user_id is required; the contact's owner is the natural author.
    const { data: contact } = await db
      .from('contacts')
      .select('user_id')
      .eq('id', contactId)
      .maybeSingle();
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
    if (!externalReference) {
      console.warn(
        '[mp-webhook] external_reference ausente no pagamento',
        paymentId
      );
      return new Response('OK', { status: 200 });
    }

    const db = supabaseAdmin();
    const { data: order, error: orderError } = await db
      .from('orders')
      .select(
        'id, total, status, contact_id, account_id, items, delivery_address, payer_name'
      )
      .eq('external_reference', externalReference)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (orderError) {
      console.error('[mp-webhook] Erro ao buscar pedido:', orderError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (!order) {
      console.warn(
        '[mp-webhook] Pedido não encontrado para external_reference:',
        externalReference
      );
      return new Response('OK', { status: 200 });
    }

    // O Mercado Pago manda várias notificações por pagamento.
    if (isOrderPaid(order.status)) {
      return new Response('OK', { status: 200 });
    }

    if (payment.status !== 'approved') {
      if (payment.status === 'rejected' || payment.status === 'in_process') {
        await db
          .from('orders')
          .update({ status: payment.status })
          .eq('id', order.id)
          .neq('status', ORDER_STATUS_PAID);
      }
      console.log(
        `[mp-webhook] Pedido ${order.id}: pagamento ${payment.rawStatus}`
      );
      return new Response('OK', { status: 200 });
    }

    const paidAmount = payment.paidAmount ?? Number(order.total);
    if (Math.abs(paidAmount - Number(order.total)) > 0.01) {
      // Não marca como pago; 200 para o Mercado Pago não reenviar sem fim.
      console.error(
        `[mp-webhook] Valor divergente no pedido ${order.id}: pago=${paidAmount} esperado=${order.total}`
      );
      return new Response('OK', { status: 200 });
    }

    // Só quem efetivamente muda o status confirma ao cliente — duas
    // notificações simultâneas não geram duas mensagens.
    const { data: transitioned, error: updateError } = await db
      .from('orders')
      .update({ status: ORDER_STATUS_PAID })
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
      return new Response('OK', { status: 200 });
    }
    console.log(`[mp-webhook] Pedido ${order.id} pago (${externalReference})`);

    if (order.account_id) {
      // Move deal para "Na Cozinha" quando pagamento é aprovado
      await moveDealToCookingStage(db, order.account_id, order.id);

      // Atualiza deal com valor pago (automação de ciclo de vida)
      try {
        const { data: dealIdRow } = await db
          .from('orders')
          .select('deal_id')
          .eq('id', order.id)
          .maybeSingle();
        const dealId = (dealIdRow as { deal_id?: string | null } | null)
          ?.deal_id;
        if (dealId) {
          await updateDealWithPayment(db, {
            accountId: order.account_id,
            dealId,
            paidAmount,
          });
        }
      } catch (err) {
        console.warn(
          '[mp-webhook] failed to update deal with payment (non-blocking):',
          err
        );
      }
    }

    if (order.account_id && order.contact_id) {
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

      // Pedido pago = atendimento concluído: fecha a conversa do cliente.
      // A IA respeita conversas fechadas (ver src/lib/ai/auto-reply.ts) e para
      // de responder; a conversa reabre automaticamente se o cliente mandar
      // uma nova mensagem (ver src/app/api/whatsapp/webhook/route.ts).
      const { error: closeError } = await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', order.account_id)
        .eq('contact_id', order.contact_id);
      if (closeError) {
        console.error(
          '[mp-webhook] Erro ao fechar conversa após pagamento:',
          closeError
        );
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
