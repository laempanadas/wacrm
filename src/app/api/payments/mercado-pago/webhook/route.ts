import { NextRequest, NextResponse } from 'next/server';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { sendPaymentConfirmationWhatsApp } from '@/lib/whatsapp/send-message';
import { createClient } from '@/lib/supabase/server';
import * as crypto from 'crypto';

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN!,
});
const paymentService = new Payment(client);

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
      .select('id, total, contactId:contact_id, account_id')
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
