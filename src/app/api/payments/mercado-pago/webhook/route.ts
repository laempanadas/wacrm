import { NextRequest, NextResponse } from 'next/server';
import mercadopago from 'mercadopago';
import { getSession } from '@/lib/auth';
import { sendTemplateMessage } from '@/lib/whatsapp/send-message'; // Assuming this function exists or will be added
import { db } from '@/lib/db'; // Assuming your Prisma/DB client is named 'db'

mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN!,
});

export async function POST(req: NextRequest) {
  try {
    // 1. Validate signature (HMAC-SHA256)
    const signature = req.headers.get('x-signature');
    const body = await req.text(); // Read body as text for signature validation
    
    // Mercado Pago SDK's validateWebhook requires raw body and signature header
    // Assuming 'mercadopago.configurations.validateWebhook' is available and correctly configured
    if (!signature || !mercadopago.configurations.validateWebhook(body, signature)) {
      console.warn('Invalid Mercado Pago webhook signature detected.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const data = JSON.parse(body); // Now parse the body
    
    // Only process payment updates
    if (data.action !== 'payment.updated') {
      console.log('Mercado Pago webhook: Ignored non-payment.updated action.');
      return new Response('Ignored', { status: 200 });
    }

    // Fetch full payment details from Mercado Pago API
    const payment = await mercadopago.payment.findById(data.data.id);
    const paymentStatus = payment.body.status;
    const externalReference = payment.body.external_reference; // This should be your order ID
    const paymentAmount = payment.body.transaction_amount;

    // Retrieve the order from your database
    const order = await db.order.findUnique({
      where: { id: externalReference }, // Assuming external_reference matches your order ID
    });

    if (!order) {
      console.error(`Mercado Pago webhook: Order not found for external_reference: ${externalReference}`);
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 2. Validate transaction_amount against order.total
    if (paymentAmount !== order.total) {
      console.warn(`Mercado Pago webhook: Amount mismatch for order ${order.id}. Paid: ${paymentAmount}, Expected: ${order.total}`);
      // Consider logging this or flagging the order for manual review
      return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 400 });
    }

    // 3. Process if payment is approved
    if (paymentStatus === 'approved') {
      // Update order status in your database
      await db.order.update({
        where: { id: order.id },
        data: { status: 'PAID' }, // Assuming 'PAID' is the status for approved payments
      });

      // Get the contact associated with the order to send WhatsApp confirmation
      const contact = await db.contact.findUnique({
        where: { id: order.contactId }, // Assuming order has a contactId
      });

      if (contact && contact.phone) {
        // Send WhatsApp confirmation message
        // You'll need to define 'payment_confirmed_template' in your Meta Business Manager
        // and ensure sendTemplateMessage is correctly implemented in '@/lib/whatsapp/send-message'
        await sendTemplateMessage({
          phone: contact.phone,
          template: 'payment_confirmed_template', // Name of your approved WhatsApp template
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: order.id }, // Example: pass order ID
                { type: 'text', text: paymentAmount.toFixed(2) }, // Example: pass amount
              ],
            },
            // Add other components if your template requires them (e.g., buttons, header)
          ],
        });
        console.log(`WhatsApp confirmation sent for order ${order.id} to ${contact.phone}`);
      } else {
        console.warn(`Mercado Pago webhook: Could not send WhatsApp confirmation for order ${order.id}. Contact or phone missing.`);
      }
    } else {
      console.log(`Mercado Pago webhook: Payment status for order ${order.id} is ${paymentStatus}. No confirmation sent.`);
      // Optionally update order status for other statuses like 'pending', 'rejected'
      await db.order.update({
        where: { id: order.id },
        data: { status: paymentStatus.toUpperCase() }, // Update with MP status
      });
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Mercado Pago webhook processing error:', error);
    // Respond with 500 but avoid leaking sensitive error details
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
