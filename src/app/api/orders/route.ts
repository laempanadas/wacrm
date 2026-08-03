// ============================================================
// /api/orders
//
//   POST — registra um pedido do fluxo do WhatsApp criando um card no
//          pipeline "Pedidos Delivery" (estágio "Novo Pedido") e
//          aplicando a tag de status ao contato.
//
// Chamado ao final do fluxo `pedido_empanadas` com os dados coletados
// na conversa. Requer sessão autenticada (contexto de conta).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  createOrderDeal,
  type OrderDeliveryKind,
  type OrderPaymentMethod,
} from '@/lib/orders/create-order';

const DELIVERY_KINDS: OrderDeliveryKind[] = ['delivery', 'retirada'];
const PAYMENT_METHODS: OrderPaymentMethod[] = [
  'pix',
  'cartao',
  'dinheiro',
  'mercado_pago',
];

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount();

    const body = (await request.json().catch(() => null)) as {
      contactId?: unknown;
      customerName?: unknown;
      deliveryKind?: unknown;
      paymentMethod?: unknown;
      total?: unknown;
      deliveryAddress?: unknown;
      paidOnline?: unknown;
      conversationId?: unknown;
    } | null;

    const contactId =
      typeof body?.contactId === 'string' ? body.contactId.trim() : '';
    if (!contactId) {
      return NextResponse.json(
        { error: 'Informe o contactId do cliente.' },
        { status: 400 }
      );
    }

    const deliveryKind = body?.deliveryKind as OrderDeliveryKind;
    if (!DELIVERY_KINDS.includes(deliveryKind)) {
      return NextResponse.json(
        { error: 'deliveryKind deve ser "delivery" ou "retirada".' },
        { status: 400 }
      );
    }

    const paymentMethod = body?.paymentMethod as OrderPaymentMethod;
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return NextResponse.json(
        {
          error:
            'paymentMethod deve ser "pix", "cartao", "dinheiro" ou "mercado_pago".',
        },
        { status: 400 }
      );
    }

    // Regra de negócio: delivery não aceita dinheiro.
    if (deliveryKind === 'delivery' && paymentMethod === 'dinheiro') {
      return NextResponse.json(
        { error: 'Delivery não aceita pagamento em dinheiro.' },
        { status: 400 }
      );
    }

    const customerName =
      typeof body?.customerName === 'string' ? body.customerName : '';
    const total = Number(body?.total);
    const deliveryAddress =
      typeof body?.deliveryAddress === 'string'
        ? body.deliveryAddress
        : undefined;
    const conversationId =
      typeof body?.conversationId === 'string'
        ? body.conversationId
        : undefined;
    const paidOnline = body?.paidOnline === true;

    const result = await createOrderDeal(
      supabase,
      { accountId, userId },
      {
        contactId,
        customerName,
        deliveryKind,
        paymentMethod,
        total: Number.isFinite(total) ? total : 0,
        deliveryAddress,
        paidOnline,
        conversationId,
      }
    );

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
