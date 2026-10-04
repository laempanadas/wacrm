/**
 * src/lib/orders/create-order-with-mercado-pago.ts
 *
 * Orquestrador que:
 *  1) cria o deal no CRM (createOrderDeal) com paidOnline = false;
 *  2) chama diretamente createPaymentLink do Mercado Pago passando externalReference = dealId;
 *  3) grava o pedido na tabela 'orders' com deal_id e preference_id;
 *  4) em caso de falha na criação do link, anota o deal e retorna erro ao chamador.
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrderDeal } from './create-order';
import { createPaymentLink, isMercadoPagoConfigured } from '@/lib/payments/mercado-pago';

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
 * Orquestra a criação do deal e do link Mercado Pago de forma direta e resiliente.
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
    const total = Number(
      input.items.reduce((s, it) => s + (it.unitPrice || 0) * (it.quantity || 0), 0).toFixed(2)
    );

    // 1) cria o deal no CRM (paidOnline = false) na etapa "Novo Pedido"
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

    if (!isMercadoPagoConfigured()) {
      return {
        ok: false,
        dealId,
        error: 'Mercado Pago não configurado. Adicione MP_ACCESS_TOKEN nas variáveis de ambiente.',
      };
    }

    // 2) Cria o link de pagamento no Mercado Pago direto (sem loopback HTTP)
    const paymentResult = await createPaymentLink({
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
    });

    if (!paymentResult.ok || !paymentResult.paymentUrl) {
      if (dealId) {
        await admin
          .from('deals')
          .update({
            notes: `${input.customerName || ''}\n\n[Erro ao gerar link MP] Falha ao criar preferência`,
          })
          .eq('id', dealId);
      }
      return {
        ok: false,
        dealId,
        error: 'Erro ao criar link de pagamento no Mercado Pago',
      };
    }

    // 3) Grava na tabela orders vinculada ao deal
    try {
      await admin.from('orders').insert({
        account_id: ctx.accountId,
        contact_id: input.contactId,
        deal_id: dealId,
        external_reference: dealId,
        preference_id: paymentResult.preferenceId,
        payment_url: paymentResult.paymentUrl,
        total,
        items: input.items,
        delivery_address: input.deliveryAddress || '',
        payer_phone: input.payerPhone || '',
        payer_name: input.customerName,
        status: 'pending',
      });
    } catch (orderErr) {
      console.error('[createOrderWithMercadoPago] Erro ao gravar order:', orderErr);
    }

    // 4) Sucesso
    return {
      ok: true,
      dealId,
      link_mercado_pago: paymentResult.paymentUrl,
      preferenceId: paymentResult.preferenceId,
    };
  } catch (err: unknown) {
    // em caso de erro inesperado, registra no deal se tivermos dealId
    try {
      const message = err instanceof Error ? err.message : String(err);
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

    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
