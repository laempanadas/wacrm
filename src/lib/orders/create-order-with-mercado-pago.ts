/**
 * src/lib/orders/create-order-with-mercado-pago.ts
 *
 * Orquestrador que:
 *  1) cria o deal no CRM (createOrderDeal) com paidOnline = false;
 *  2) chama o endpoint POST /api/payments/mercado-pago passando externalReference = dealId;
 *  3) em caso de falha na criação do link, anota o deal e retorna erro ao chamador.
 *
 * Requisitos:
 * - createOrderDeal exportado em src/lib/orders/create-order.ts
 * - Variável de ambiente NEXT_PUBLIC_APP_BASE_URL ou NEXT_PUBLIC_VERCEL_URL apontando para a aplicação
 * - Endpoint /api/payments/mercado-pago existente e capaz de aceitar externalReference
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrderDeal } from './create-order';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function supabaseAdmin(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

export type Item = { title: string; quantity: number; unitPrice: number; description?: string };

export interface CreateOrderWithMpInput {
  contactId: string;
  customerName: string;
  deliveryKind: 'delivery' | 'retirada';
  deliveryAddress?: string;
  items: Item[];
  conversationId?: string;
  payerPhone?: string;
}

export interface CreateOrderWithMpResult {
  ok: boolean;
  dealId?: string;
  link_mercado_pago?: string;
  preferenceId?: string;
  error?: string;
}

/**
 * Orquestra a criação do deal e do link Mercado Pago.
 * ctx: { accountId, userId }
 */
export async function createOrderWithMercadoPago(
  ctx: { accountId: string; userId: string },
  input: CreateOrderWithMpInput
): Promise<CreateOrderWithMpResult> {
  const admin = supabaseAdmin();
  let dealId: string | undefined;

  try {
    // calcula total
    const total = input.items.reduce((s, it) => s + (it.unitPrice || 0) * (it.quantity || 0), 0);

    // 1) cria o deal no CRM (paidOnline = false)
    const createInput = {
      contactId: input.contactId,
      customerName: input.customerName,
      deliveryKind: input.deliveryKind,
      paymentMethod: 'mercado_pago' as const,
      total,
      deliveryAddress: input.deliveryAddress,
      paidOnline: false,
      conversationId: input.conversationId,
    };

    const createRes = await createOrderDeal(admin, ctx, createInput);
    dealId = createRes.dealId;

    // 2) chama endpoint interno de pagamentos para gerar link
    const base =
      process.env.NEXT_PUBLIC_APP_BASE_URL ||
      process.env.NEXT_PUBLIC_VERCEL_URL ||
      'http://localhost:3000';
    const paymentEndpoint = `${base.replace(/\/$/, '')}/api/payments/mercado-pago`;

    const resp = await fetch(paymentEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: input.items.map((it) => ({
          title: it.title,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          description: it.description,
        })),
        externalReference: dealId,
        payerName: input.customerName,
        payerPhone: input.payerPhone,
        deliveryKind: input.deliveryKind,
        deliveryAddress: input.deliveryAddress,
        contactId: input.contactId,
      }),
    });

    const body = await resp.json().catch(() => null);

    if (!resp.ok || !body || !body.paymentUrl) {
      // registra nota no deal para rastrear o problema
      try {
        if (dealId) {
          await admin
            .from('deals')
            .update({
              notes:
                (createInput.customerName || '') +
                '\n\n[Erro ao gerar link MP] ' +
                (body?.error || 'sem resposta'),
            })
            .eq('id', dealId);
        }
      } catch (e) {
        console.error('Falha ao atualizar notes do deal após erro MP', e);
      }

      return {
        ok: false,
        dealId,
        error: body?.error || 'Erro ao criar link de pagamento no Mercado Pago',
      };
    }

    // Sucesso
    return {
      ok: true,
      dealId,
      link_mercado_pago: body.paymentUrl,
      preferenceId: body.preferenceId,
    };
  } catch (err: any) {
    // em caso de erro inesperado, registra no deal se tivermos dealId
    try {
      const message = err?.message ?? String(err);
      if (typeof dealId === 'string' && dealId.length > 0) {
        await admin
          .from('deals')
          .update({
            notes: `Erro interno ao criar link MP: ${message}`,
          })
          .eq('id', dealId);
      } else {
        console.error('Erro interno ao criar link MP (sem dealId):', message);
      }
    } catch (e) {
      console.error('Erro ao anotar deal em catch', e);
    }

    return { ok: false, error: err?.message ?? String(err) };
  }
}