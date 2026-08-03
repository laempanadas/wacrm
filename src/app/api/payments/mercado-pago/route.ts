// ============================================================
// /api/payments/mercado-pago
//
//   GET  — informa se a integração Mercado Pago está configurada
//          (usado pela UI para exibir aviso quando faltam credenciais).
//   POST — cria um link de pagamento (Checkout Pro) para um pedido e
//          devolve a URL pronta para enviar ao cliente pelo WhatsApp.
//
// Requer sessão autenticada (contexto de conta). As credenciais do
// Mercado Pago ficam no ambiente (MP_ACCESS_TOKEN) — nunca no cliente.
// Veja docs/mercado-pago-setup.md.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  createPaymentLink,
  isMercadoPagoConfigured,
  MP_NOT_CONFIGURED_MESSAGE,
  type DeliveryKind,
  type PaymentLinkItem,
} from '@/lib/payments/mercado-pago';

export async function GET() {
  try {
    await getCurrentAccount();
    return NextResponse.json({ configured: isMercadoPagoConfigured() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    // Garante sessão válida antes de qualquer chamada externa.
    await getCurrentAccount();

    if (!isMercadoPagoConfigured()) {
      return NextResponse.json(
        { error: MP_NOT_CONFIGURED_MESSAGE },
        {
          status: 503,
        }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      items?: unknown;
      externalReference?: unknown;
      payerName?: unknown;
      deliveryKind?: unknown;
      deliveryAddress?: unknown;
    } | null;

    const rawItems = Array.isArray(body?.items) ? body!.items : [];
    const items: PaymentLinkItem[] = rawItems
      .map((raw) => {
        const it = raw as Record<string, unknown>;
        const title = typeof it.title === 'string' ? it.title.trim() : '';
        const quantity = Number(it.quantity);
        const unitPrice = Number(it.unitPrice);
        return { title, quantity, unitPrice };
      })
      .filter(
        (it) =>
          it.title.length > 0 &&
          Number.isFinite(it.quantity) &&
          it.quantity > 0 &&
          Number.isFinite(it.unitPrice) &&
          it.unitPrice > 0
      );

    if (!items.length) {
      return NextResponse.json(
        {
          error:
            'Informe ao menos um item válido (title, quantity, unitPrice).',
        },
        { status: 400 }
      );
    }

    const externalReference =
      typeof body?.externalReference === 'string'
        ? body.externalReference
        : undefined;
    const payerName =
      typeof body?.payerName === 'string' ? body.payerName : undefined;
    const deliveryKind =
      body?.deliveryKind === 'delivery' || body?.deliveryKind === 'retirada'
        ? (body.deliveryKind as DeliveryKind)
        : undefined;
    const deliveryAddress =
      typeof body?.deliveryAddress === 'string'
        ? body.deliveryAddress
        : undefined;

    const result = await createPaymentLink({
      items,
      externalReference,
      payerName,
      deliveryKind,
      deliveryAddress,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Mercado Pago')) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
