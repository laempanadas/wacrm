import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { WhatsAppConfig } from '@/types';

export const dynamic = 'force-dynamic';

interface ReminderOrder {
  id: string;
  account_id: string | null;
  contact_id: string | null;
  payer_phone: string | null;
  payment_url: string | null;
  payer_name: string | null;
  total: number | string | null;
}

type ReminderConfig = Pick<
  WhatsAppConfig,
  'access_token' | 'phone_number_id'
> & {
  account_id: string;
};

function errorMessage(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : undefined;
}

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin() {
  if (!_adminClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    _adminClient = createClient(url, key);
  }
  return _adminClient;
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const expectedBuffer = Buffer.from(expected);
  if (
    supplied.length !== expectedBuffer.length ||
    !timingSafeEqual(supplied, expectedBuffer)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const forceTest = searchParams.get('force') === 'true';
    const customMinutes = parseInt(searchParams.get('minutes') || '15', 10);

    const minutesToWait = forceTest ? 0 : customMinutes;
    const targetDate = new Date(
      Date.now() - minutesToWait * 60 * 1000
    ).toISOString();
    const maxWindowDate = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();

    let query = supabaseAdmin()
      .from('orders')
      .select('*')
      .eq('status', 'pending')
      .lte('created_at', targetDate)
      .gte('created_at', maxWindowDate)
      .order('created_at', { ascending: false });

    if (!forceTest) {
      query = query.is('reminded_at', null);
    }

    const { data: pendingOrders, error: ordersError } =
      await query.returns<ReminderOrder[]>();

    if (ordersError) {
      console.error('[Cron Reminder] Erro ao consultar orders:', ordersError);
      return NextResponse.json(
        { error: 'Erro ao consultar tabela orders', details: ordersError },
        { status: 500 }
      );
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      const { count: totalPending } = await supabaseAdmin()
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');

      return NextResponse.json({
        message: 'Nenhum pedido pendente elegível.',
        pedidosPendentesNoBanco: totalPending || 0,
        criterioTempo: `Mais de ${minutesToWait} minutos atrás`,
      });
    }

    // Envia uma vez por telefone e conta em cada rodada (o pedido mais recente).
    const seenPhones = new Set<string>();

    const results: Array<{
      orderId: string;
      phone: string | null;
      status: string;
      messageId?: string;
      error?: unknown;
    }> = [];

    for (const order of pendingOrders) {
      if (!order.payer_phone || !order.payment_url) {
        results.push({
          orderId: order.id,
          phone: order.payer_phone,
          status: 'skipped_no_phone_or_url',
        });
        continue;
      }

      if (!order.account_id) {
        results.push({
          orderId: order.id,
          phone: order.payer_phone,
          status: 'skipped_no_account_config',
        });
        continue;
      }

      const { data: contact, error: contactError } = await supabaseAdmin()
        .from('contacts')
        .select('id, account_id, phone')
        .eq('id', order.contact_id)
        .eq('account_id', order.account_id)
        .maybeSingle();
      if (contactError || !contact) {
        results.push({
          orderId: order.id,
          phone: order.payer_phone,
          status: 'skipped_invalid_contact',
        });
        continue;
      }

      const rawPhone = normalizePhone(order.payer_phone);
      if (!rawPhone || rawPhone !== normalizePhone(contact.phone)) {
        results.push({
          orderId: order.id,
          phone: order.payer_phone,
          status: 'skipped_phone_mismatch',
        });
        continue;
      }

      // Invalid orders must not consume the recipient's deduplication slot.
      const key = JSON.stringify([order.account_id, rawPhone]);
      if (seenPhones.has(key)) continue;

      const { data: config, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('account_id, access_token, phone_number_id')
        .eq('account_id', order.account_id)
        .maybeSingle<ReminderConfig>();
      if (configError || !config) {
        results.push({
          orderId: order.id,
          phone: order.payer_phone,
          status: configError
            ? 'skipped_config_error'
            : 'skipped_no_account_config',
        });
        continue;
      }

      seenPhones.add(key);

      const accessToken = decrypt(config.access_token);
      const phoneNumberId = config.phone_number_id;

      const valorFormatado = Number(order.total || 0)
        .toFixed(2)
        .replace('.', ',');
      const nomeCliente = order.payer_name || 'Cliente';

      // Mensagem limpa: sem a URL no meio do texto, com o botão interativo direto
      const headerText = '🥟 La Empanadas';
      const bodyText =
        `Oi, *${nomeCliente}*! Tudo bem? 😊\n\n` +
        `Passando para lembrar que o seu pedido de *R$ ${valorFormatado}* ainda está aguardando confirmação.\n\n` +
        `Para garantir que suas empanadas saiam quentinhas do forno no horário, você pode concluir o pagamento pelo botão abaixo via Pix ou Cartão:`;
      const footerText = 'Mercado Pago • Produção imediata após confirmação';
      const buttonLabel = '💳 Pagar Agora';

      try {
        // 1. Tenta enviar como Botão Interativo Nativo CTA da Meta
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
              to: rawPhone,
              type: 'interactive',
              interactive: {
                type: 'cta_url',
                header: {
                  type: 'text',
                  text: headerText,
                },
                body: {
                  text: bodyText,
                },
                footer: {
                  text: footerText,
                },
                action: {
                  name: 'cta_url',
                  parameters: {
                    display_text: buttonLabel,
                    url: order.payment_url,
                  },
                },
              },
            }),
          }
        );

        let resData = await res.json();

        // 2. Se o botão falhar por restrição da Meta, usa o fallback de texto
        if (!resData?.messages?.[0]?.id) {
          console.warn(
            '[Cron Reminder] Botão CTA falhou, enviando fallback de texto:',
            resData
          );
          const fallbackText =
            `${bodyText}\n\n` +
            `👉 *Link para pagamento:*\n${order.payment_url}\n\n` +
            `_${footerText}_`;

          const fallbackRes = await fetch(
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
                to: rawPhone,
                type: 'text',
                text: { body: fallbackText },
              }),
            }
          );
          resData = await fallbackRes.json();
        }

        if (resData?.messages?.[0]?.id) {
          // Marca TODOS os pedidos pendentes anteriores desse mesmo telefone como lembrados
          await supabaseAdmin()
            .from('orders')
            .update({
              reminded_at: new Date().toISOString(),
            })
            .eq('payer_phone', order.payer_phone)
            .eq('account_id', order.account_id)
            .eq('status', 'pending');

          results.push({
            orderId: order.id,
            phone: rawPhone,
            status: 'sent',
            messageId: resData.messages[0].id,
          });
        } else {
          results.push({
            orderId: order.id,
            phone: rawPhone,
            status: 'failed_meta',
            error: resData,
          });
        }
      } catch (err: unknown) {
        results.push({
          orderId: order.id,
          phone: rawPhone,
          status: 'error',
          error: errorMessage(err),
        });
      }
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      details: results,
    });
  } catch (error: unknown) {
    console.error('[Cron Reminder Fatal Error]:', error);
    return NextResponse.json(
      { error: 'Internal Error', message: errorMessage(error) },
      { status: 500 }
    );
  }
}
