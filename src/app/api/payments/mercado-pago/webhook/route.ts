import { NextRequest, NextResponse } from 'next/server';
// Importa as classes necessárias do SDK do Mercado Pago
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { sendPaymentConfirmationWhatsApp } from '@/lib/whatsapp/send-message';
import { createClient } from '@/lib/supabase/server'; // Importa o createClient do Supabase
import * as crypto from 'crypto'; // Importa o módulo crypto para validação manual de assinatura

// Instancia o cliente do Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN!,
});
// Instancia o serviço de pagamentos com o cliente configurado
const paymentService = new Payment(client);

// Função auxiliar para validar a assinatura do webhook (implementação manual)
function validateMercadoPagoWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const [signatureId, signatureValue] = signatureHeader.split(',').map(s => s.trim().split('='));
  if (signatureId[0] !== 'id' || signatureValue[0] !== 'v1') {
    return false; // Assinatura em formato inesperado
  }

  const hmac = crypto.createHmac('sha256', webhookSecret);
  hmac.update(`id:${signatureId[1]}:${rawBody}`);
  const expectedSignature = hmac.digest('hex');

  return expectedSignature === signatureValue[1];
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const signature = req.headers.get('x-signature');
    const rawBody = await req.text(); // Lê o corpo como texto para validação da assinatura

    // Validação da assinatura manual
    if (!process.env.MERCADO_PAGO_WEBHOOK_SECRET) {
      console.error('MERCADO_PAGO_WEBHOOK_SECRET is not defined in environment variables.');
      return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
    }
    if (!validateMercadoPagoWebhookSignature(rawBody, signature, process.env.MERCADO_PAGO_WEBHOOK_SECRET)) {
      console.warn('Invalid Mercado Pago webhook signature detected.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const data = JSON.parse(rawBody); // Agora faz o parse do corpo

    // Only process payment updates
    if (data.action !== 'payment.updated') {
      console.log('Mercado Pago webhook: Ignored non-payment.updated action.');
      return new Response('Ignored', { status: 200 });
    }

    // Fetch full payment details from Mercado Pago API using the new service instance
    // A correção está aqui: removemos o .body
    const payment = await paymentService.get({ id: data.data.id });
    const paymentStatus = payment.status; // Corrigido
    const externalReference = payment.external_reference; // Corrigido
    const paymentAmount = payment.transaction_amount; // Corrigido

    // Retrieve the order from your database using Supabase client
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', externalReference)
      .maybeSingle();

    if (orderError) {
      console.error(`Supabase error fetching order:`, orderError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    if (!order) {
      console.error(`Mercado Pago webhook: Order not found for external_reference: ${externalReference}`);
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Validate transaction_amount against order.total
    if (paymentAmount !== order.total) {
      console.warn(`Mercado Pago webhook: Amount mismatch for order ${order.id}. Paid: ${paymentAmount}, Expected: ${order.total}`);
      return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 400 });
    }

    // Process if payment is approved
    if (paymentStatus === 'approved') {
      // Update order status in your database using Supabase client
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: 'PAID' })
        .eq('id', order.id);

      if (updateError) {
        console.error(`Supabase error updating order status:`, updateError);
        return NextResponse.json({ error: 'Database update error' }, { status: 500 });
      }

      // Get the contact associated with the order to send WhatsApp confirmation
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('phone, account_id')
        .eq('id', order.contactId)
        .maybeSingle();

      if (contactError) {
        console.error(`Supabase error fetching contact:`, contactError);
      }

      if (contact && contact.phone && contact.account_id) {
        await sendPaymentConfirmationWhatsApp(
          supabase,
          contact.account_id,
          contact.phone,
          order.id,
          paymentAmount
        );
        console.log(`WhatsApp confirmation sent for order ${order.id} to ${contact.phone}`);
      } else {
        console.warn(`Mercado Pago webhook: Could not send WhatsApp confirmation for order ${order.id}. Contact, phone, or account_id missing.`);
      }
    } else {
      console.log(`Mercado Pago webhook: Payment status for order ${order.id} is ${paymentStatus}. No confirmation sent.`);
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: paymentStatus.toUpperCase() })
        .eq('id', order.id);
      
      if (updateError) {
        console.error(`Supabase error updating order status for non-approved payment:`, updateError);
      }
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Mercado Pago webhook processing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
