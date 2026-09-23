import { NextRequest, NextResponse } from 'next/server';
import mercadopago from 'mercadopago';
import { sendPaymentConfirmationWhatsApp } from '@/lib/whatsapp/send-message'; // Importa a nova função
import { createClient } from '@/lib/supabase/server'; // Importa o createClient do Supabase

mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN!,
});

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient(); // Cria a instância do cliente Supabase

    // 1. Validate signature (HMAC-SHA256)
    const signature = req.headers.get('x-signature');
    const body = await req.text();

    if (!signature || !mercadopago.configurations.validateWebhook(body, signature)) {
      console.warn('Invalid Mercado Pago webhook signature detected.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const data = JSON.parse(body);

    // Only process payment updates
    if (data.action !== 'payment.updated') {
      console.log('Mercado Pago webhook: Ignored non-payment.updated action.');
      return new Response('Ignored', { status: 200 });
    }

    // Fetch full payment details from Mercado Pago API
    const payment = await mercadopago.payment.findById(data.data.id);
    const paymentStatus = payment.body.status;
    const externalReference = payment.body.external_reference;
    const paymentAmount = payment.body.transaction_amount;

    // Retrieve the order from your database using Supabase client
    const { data: order, error: orderError } = await supabase
      .from('orders') // Assumindo o nome da tabela como 'orders'
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

    // 2. Validate transaction_amount against order.total
    if (paymentAmount !== order.total) {
      console.warn(`Mercado Pago webhook: Amount mismatch for order ${order.id}. Paid: ${paymentAmount}, Expected: ${order.total}`);
      return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 400 });
    }

    // 3. Process if payment is approved
    if (paymentStatus === 'approved') {
      // Update order status in your database using Supabase client
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: 'PAID' }) // Assumindo 'PAID' é o status para pagamentos aprovados
        .eq('id', order.id);

      if (updateError) {
        console.error(`Supabase error updating order status:`, updateError);
        return NextResponse.json({ error: 'Database update error' }, { status: 500 });
      }

      // Get the contact associated with the order to send WhatsApp confirmation
      const { data: contact, error: contactError } = await supabase
        .from('contacts') // Assumindo o nome da tabela como 'contacts'
        .select('phone, account_id') // Adicionado account_id
        .eq('id', order.contactId)
        .maybeSingle();

      if (contactError) {
        console.error(`Supabase error fetching contact:`, contactError);
        // Continue processing even if contact fetch fails, as order status was updated
      }

      if (contact && contact.phone && contact.account_id) {
        // Usa a nova função
        await sendPaymentConfirmationWhatsApp({
          supabase: supabase,
          accountId: contact.account_id,
          contactPhone: contact.phone,
          orderId: order.id,
          paymentAmount: paymentAmount,
        });
        console.log(`WhatsApp confirmation sent for order ${order.id} to ${contact.phone}`);
      } else {
        console.warn(`Mercado Pago webhook: Could not send WhatsApp confirmation for order ${order.id}. Contact, phone, or account_id missing.`);
      }
    } else {
      console.log(`Mercado Pago webhook: Payment status for order ${order.id} is ${paymentStatus}. No confirmation sent.`);
      // Optionally update order status for other statuses like 'pending', 'rejected'
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
