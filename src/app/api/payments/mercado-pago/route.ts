// ============================================================
// /api/payments/mercado-pago
//
//   GET  — informa se a integração Mercado Pago está configurada
//          (usado pela UI para exibir aviso quando faltam credenciais).
//   POST — cria um link de pagamento (Checkout Pro) para um pedido,
//          grava o pedido na tabela 'orders' no Supabase e
//          devolve a URL pronta para enviar ao cliente pelo WhatsApp.
//
// Requer sessão autenticada (contexto de conta). As credenciais do
// Mercado Pago ficam no ambiente (MP_ACCESS_TOKEN) — nunca no cliente.
// ============================================================

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  createPaymentLink,
  isMercadoPagoConfigured,
  MP_NOT_CONFIGURED_MESSAGE,
  type DeliveryKind,
  type PaymentLinkItem,
} from '@/lib/payments/mercado-pago';

// Instância com Service Role para gravação segura na tabela 'orders'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

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
    // 1. Garante sessão válida e obtém o contexto da conta
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accountContext: any = await getCurrentAccount();
    const accountId = accountContext.accountId || accountContext.id || accountContext.account_id;

    if (!isMercadoPagoConfigured()) {
      return NextResponse.json(
        { error: MP_NOT_CONFIGURED_MESSAGE },
        { status: 503 }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      items?: unknown;
      externalReference?: unknown;
      payerName?: unknown;
      payerPhone?: unknown;
      deliveryKind?: unknown;
      deliveryAddress?: unknown;
      contactId?: unknown;
    } | null;

    const rawItems = Array.isArray(body?.items) ? body!.items : [];
    const items: PaymentLinkItem[] = rawItems
      .map((raw) => {
        const it = raw as Record<string, unknown>;
        const title = typeof it.title === 'string' ? it.title.trim() : '';
        const quantity = Number(it.quantity);
        const unitPrice = Number(it.unitPrice);
        const description = typeof it.description === 'string' ? it.description.trim() : undefined;
        return { title, quantity, unitPrice, description };
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
          error: 'Informe ao menos um item válido (title, quantity, unitPrice).',
        },
        { status: 400 }
      );
    }

    const payerName =
      typeof body?.payerName === 'string' && body.payerName.trim().length > 0
        ? body.payerName.trim()
        : 'Cliente';

    const payerPhone =
      typeof body?.payerPhone === 'string' ? body.payerPhone.trim() : '';

    const deliveryKind =
      body?.deliveryKind === 'delivery' || body?.deliveryKind === 'retirada'
        ? (body.deliveryKind as DeliveryKind)
        : 'delivery';

    const deliveryAddress =
      typeof body?.deliveryAddress === 'string'
        ? body.deliveryAddress.trim()
        : '';

    const contactId =
      typeof body?.contactId === 'string' && body.contactId.trim().length > 0
        ? body.contactId.trim()
        : null;

    // Gera um externalReference único e rastreável
    const externalReference =
      typeof body?.externalReference === 'string' && body.externalReference.trim().length > 0
        ? body.externalReference.trim()
        : `PED-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // Calcula o valor total do pedido (server-side)
    const totalAmount = items.reduce((acc, it) => acc + it.quantity * it.unitPrice, 0);

    // --- IDENTITY / IDEMPOTENCY: tentar reusar pedido pendente existente quando externalReference for fornecido
    if (externalReference) {
      try {
        const { data: existingOrders, error: findErr } = await supabaseAdmin()
          .from('orders')
          .select('*')
          .eq('external_reference', externalReference)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1);

        if (findErr) {
          console.error('[Mercado Pago] Erro ao consultar orders por external_reference', { externalReference, err: findErr });
        } else if (existingOrders && existingOrders.length > 0) {
          const existing = existingOrders[0] as any;
          const createdAt = new Date(existing.created_at);
          const ageMin = (Date.now() - createdAt.getTime()) / 60000;
          if (ageMin <= 30 && existing.preference_id && existing.payment_url) {
            console.log(`[Mercado Pago] Reutilizando preferência existente para externalReference=${externalReference}, orderId=${existing.id}`);
            // Retornar no mesmo formato que o cliente espera (compatível)
            return NextResponse.json({
              ok: true,
              paymentUrl: existing.payment_url,
              preferenceId: existing.preference_id,
              reused: true,
              orderId: existing.id,
            });
          }
        }
      } catch (qe) {
        console.error('[Mercado Pago] Falha ao verificar order existente', { externalReference, err: qe });
        // Continua — fallback é criar nova preferência
      }
    }

    // 2. Cria o link de pagamento no Mercado Pago (mesma função utilitária usada hoje)
    const result = await createPaymentLink({
      items,
      externalReference,
      payerName,
      payerPhone,
      deliveryKind,
      deliveryAddress,
    });

    // 3. 🛡️ Salva o pedido na tabela 'orders' para permitir lembretes e confirmação de pagamento
    if (result.ok && result.paymentUrl) {
      try {
        const insertPayload: any = {
          account_id: accountId,
          contact_id: contactId,
          external_reference: externalReference,
          preference_id: result.preferenceId,
          payment_url: result.paymentUrl,
          total: totalAmount,
          items: items,
          delivery_address: deliveryAddress,
          payer_phone: payerPhone,
          payer_name: payerName,
          status: 'pending',
        };
        // se externalReference vier do orquestrador como dealId, gravar também deal_id
        if (externalReference) {
          insertPayload.deal_id = externalReference;
        }

        const { error: insertErr } = await supabaseAdmin().from('orders').insert(insertPayload);
        if (insertErr) {
          // Logamos a falha mas não impedimos a resposta ao cliente (mantemos compatibilidade)
          console.error('[Mercado Pago] Erro ao gravar pedido na tabela orders:', insertErr, { payload: insertPayload });
        } else {
          console.log(`[Mercado Pago] Pedido ${externalReference} gravado com sucesso na tabela orders.`);
        }
      } catch (dbError) {
        console.error('[Mercado Pago] Erro ao gravar pedido na tabela orders (catch):', dbError);
      }
    }

    // Retorna o resultado original (compatível) e enriquece com flags úteis
    const responsePayload: any = { ...result, reused: false };
    return NextResponse.json(responsePayload);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Mercado Pago')) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}