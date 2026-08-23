import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';

export const dynamic = 'force-dynamic';

let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    _adminClient = createClient(url, key);
  }
  return _adminClient;
}

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    const { data: pendingOrders, error: ordersError } = await supabaseAdmin()
      .from('orders')
      .select('*')
      .eq('status', 'pending')
      .lte('created_at', fifteenMinutesAgo)
      .gte('created_at', twoHoursAgo)
      .is('reminded_at', null);

    if (ordersError) {
      console.error('[Cron Reminder] Erro ao consultar pedidos:', ordersError);
      return NextResponse.json({ error: 'Database query failed' }, { status: 500 });
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      return NextResponse.json({
        message: 'Nenhum pedido pendente para envio de lembrete.',
        processed: 0,
      });
    }

    console.log(`[Cron Reminder] ${pendingOrders.length} pedido(s) pendentes encontrados.`);
    let remindersSent = 0;

    for (const order of pendingOrders) {
      if (!order.payer_phone || !order.payment_url) continue;

      const { data: configRows } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', order.account_id)
        .limit(1);

      if (!configRows || configRows.length === 0) {
        continue;
      }

      const config = configRows[0];
      const accessToken = decrypt(config.access_token);
      const phoneNumberId = config.phone_number_id;

      const valorFormatado = Number(order.total || 0).toFixed(2).replace('.', ',');
      const nomeCliente = order.payer_name || 'Cliente';

      const reminderText =
        `Oi, *${nomeCliente}*! Tudo bem? 😊\n\n` +
        `Passando para lembrar que o seu pedido de *R$ ${valorFormatado}* ainda está aguardando confirmação.\n\n` +
        `Para garantir que suas empanadas saiam quentinhas do forno no horário, você pode concluir o pagamento pelo link abaixo via Pix ou Cartão:\n\n` +
        `👉 ${order.payment_url}\n\n` +
        `Se precisar de alguma alteração no pedido ou ajuda, basta responder aqui! 🥟✨`;

      try {
        const res = await fetch(
          `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: order.payer_phone,
              type: 'text',
              text: { body: reminderText },
            }),
          }
        );

        const resData = await res.json();

        if (resData?.messages?.[0]?.id) {
          await supabaseAdmin()
            .from('orders')
            .update({
              reminded_at: new Date().toISOString(),
            })
            .eq('id', order.id);

          remindersSent++;
        }
      } catch (sendError) {
        console.error('[Cron Reminder] Falha no envio:', sendError);
      }
    }

    return NextResponse.json({
      success: true,
      remindersSent,
      totalEligible: pendingOrders.length,
    });
  } catch (error) {
    console.error('[Cron Reminder Global Error]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
