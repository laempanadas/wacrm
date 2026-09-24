import { NextRequest, NextResponse } from 'next/server';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { createClient as createAdminClient, SupabaseClient } from '@supabase/supabase-js';
import { sendPaymentConfirmationWhatsApp } from '@/lib/whatsapp/send-message';
import { createClient } from '@/lib/supabase/server';
import * as crypto from 'crypto';

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN!,
});
const paymentService = new Payment(client);

/**
 * Cliente com service-role para escrever em tabelas protegidas por RLS
 * (custom_fields / contact_custom_values) a partir do webhook, onde não há
 * sessão de usuário autenticado.
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

/**
 * Preenche/atualiza os campos personalizados do contato após o pagamento.
 * Best-effort: qualquer falha é apenas logada e não interrompe o webhook.
 * Os nomes dos campos são exatamente os exibidos na UI: 'Itens_pedido',
 * 'Endereco_entrega', 'Forma_pagamento', 'Nome_cliente'.
 */
async function saveOrderCustomFields(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
  fields: {
    itens?: string;
    endereco?: string;
    formaPagamento?: string;
    nomeCliente?: string;
  }
): Promise<void> {
  try {
    const byName: Record<string, string> = {};
    if (fields.itens && fields.itens.trim()) byName['Itens_pedido'] = fields.itens.trim();
    if (fields.endereco && fields.endereco.trim()) byName['Endereco_entrega'] = fields.endereco.trim();
    if (fields.formaPagamento && fields.formaPagamento.trim())
      byName['Forma_pagamento'] = fields.formaPagamento.trim();
    if (fields.nomeCliente && fields.nomeCliente.trim())
      byName['Nome_cliente'] = fields.nomeCliente.trim();

    const names = Object.keys(byName);
    if (names.length === 0) return;

    const { data: defs, error: defsErr } = await supabase
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId)
      .in('field_name', names);

    if (defsErr) {
      console.error('[mp-webhook][custom-fields] Erro ao buscar definições:', defsErr);
      return;
    }
    if (!defs || defs.length === 0) {
      console.warn('[mp-webhook][custom-fields] Nenhum campo encontrado para:', names.join(', '));
      return;
    }

    const rows = defs
      .filter((d: { id: string; field_name: string }) => byName[d.field_name] !== undefined)
      .map((d: { id: string; field_name: string }) => ({
        contact_id: contactId,
        custom_field_id: d.id,
        value: byName[d.field_name],
      }));

    if (rows.length === 0) return;

    const { error: upsertErr } = await supabase
      .from('contact_custom_values')
      .upsert(rows, { onConflict: 'contact_id,custom_field_id' });

    if (upsertErr) {
      console.error('[mp-webhook][custom-fields] Erro ao gravar valores:', upsertErr);
      return;
    }
    console.log(`[mp-webhook][custom-fields] Campos atualizados para contato ${contactId}`);
  } catch (err) {
    console.error('[mp-webhook][custom-fields] Falha inesperada:', err);
  }
}

/**
 * Valida a assinatura HMAC-SHA256 do webhook do Mercado Pago.
 * Formato do header x-signature: "id=<id>,v1=<hash>"
 */
function validateSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(s => s.trim().split('=') as [string, string])
  );

  if (!parts.id || !parts.v1) return false;

  const manifest = `id:${parts.id};ts:${parts.ts ?? ''};`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(manifest);
  const expected = hmac.digest('hex');

  return expected === parts.v1;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const signatureHeader = req.headers.get('x-signature');
    const rawBody = await req.text();

    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[mp-webhook] MERCADO_PAGO_WEBHOOK_SECRET não configurado');
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }

    if (!validateSignature(rawBody, signatureHeader, secret)) {
      console.warn('[mp-webhook] Assinatura inválida rejeitada');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const data = JSON.parse(rawBody);

    if (data.action !== 'payment.updated') {
      return new Response('Ignored', { status: 200 });
    }

    // SDK v3: payment.get() retorna PaymentResponse diretamente (sem .body)
    const payment = await paymentService.get({ id: String(data.data.id) });

    const paymentStatus = payment.status;
    const externalReference = payment.external_reference;
    const paymentAmount = payment.transaction_amount;

    if (!externalReference) {
      console.warn('[mp-webhook] external_reference ausente no pagamento', payment.id);
      return new Response('OK', { status: 200 });
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, total, contactId:contact_id, account_id, items, delivery_address, payer_name')
      .eq('external_reference', externalReference)
      .maybeSingle();

    if (orderError) {
      console.error('[mp-webhook] Erro ao buscar pedido:', orderError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!order) {
      console.warn('[mp-webhook] Pedido não encontrado para external_reference:', externalReference);
      return new Response('OK', { status: 200 });
    }

    // Validação do valor pago
    if (typeof paymentAmount === 'number' && Math.abs(paymentAmount - order.total) > 0.01) {
      console.warn(`[mp-webhook] Valor divergente: pago=${paymentAmount} esperado=${order.total}`);
      return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 400 });
    }

    if (paymentStatus === 'approved') {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: 'PAID' })
        .eq('id', order.id);

      if (updateError) {
        console.error('[mp-webhook] Erro ao atualizar status do pedido:', updateError);
        return NextResponse.json({ error: 'Database update error' }, { status: 500 });
      }

      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('phone, account_id')
        .eq('id', order.contactId)
        .maybeSingle();

      if (contactError) {
        console.error('[mp-webhook] Erro ao buscar contato:', contactError);
      }

      if (contact?.phone && contact?.account_id) {
        await sendPaymentConfirmationWhatsApp(
          supabase,
          contact.account_id,
          contact.phone,
          order.id,
          paymentAmount ?? order.total
        );
        console.log(`[mp-webhook] Confirmação WhatsApp enviada para pedido ${order.id}`);
      } else {
        console.warn(`[mp-webhook] Contato/phone/account_id ausente para pedido ${order.id}`);
      }

      // Preenche/atualiza os campos personalizados do contato após o pagamento
      // aprovado. Best-effort: nunca interrompe o fluxo principal.
      if (order.account_id && order.contactId) {
        let itensPedido: string | undefined;
        try {
          const rawItems = order.items;
          const parsedItems =
            typeof rawItems === 'string' ? JSON.parse(rawItems) : rawItems;
          if (Array.isArray(parsedItems) && parsedItems.length > 0) {
            itensPedido = parsedItems
              .map((it: { quantity?: number; qty?: number; title?: string; name?: string }) => {
                const qty = it.quantity ?? it.qty ?? 1;
                const title = it.title ?? it.name ?? 'Item';
                return `${qty}x ${title}`;
              })
              .join(', ');
          }
        } catch {
          itensPedido = undefined;
        }

        await saveOrderCustomFields(supabaseAdmin(), order.account_id, order.contactId, {
          formaPagamento: 'Pago ✅ Mercado Pago',
          endereco: order.delivery_address ?? undefined,
          nomeCliente: order.payer_name ?? undefined,
          itens: itensPedido,
        });
      }

      // Pedido pago = atendimento concluído: fecha a conversa do cliente.
      // A IA respeita conversas fechadas (ver src/lib/ai/auto-reply.ts) e para
      // de responder; a conversa reabre automaticamente se o cliente mandar
      // uma nova mensagem (ver src/app/api/whatsapp/webhook/route.ts).
      if (order.account_id && order.contactId) {
        const { error: closeError } = await supabase
          .from('conversations')
          .update({ status: 'closed', updated_at: new Date().toISOString() })
          .eq('account_id', order.account_id)
          .eq('contact_id', order.contactId);

        if (closeError) {
          console.error('[mp-webhook] Erro ao fechar conversa após pagamento:', closeError);
        } else {
          console.log(`[mp-webhook] Conversa do contato ${order.contactId} fechada após pagamento do pedido ${order.id}`);
        }
      }
    } else {
      const newStatus = (paymentStatus ?? 'unknown').toUpperCase();
      await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', order.id);

      console.log(`[mp-webhook] Pedido ${order.id} atualizado para status: ${newStatus}`);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[mp-webhook] Erro interno:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
