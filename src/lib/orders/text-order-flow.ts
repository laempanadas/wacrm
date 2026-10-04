/**
 * src/lib/orders/text-order-flow.ts
 *
 * Gerencia o fluxo conversacional de pedidos por texto livre no WhatsApp:
 * 1. Processa itens enviados pelo cliente via parser determinístico.
 * 2. Solicita endereço (ou confirmação de endereço anterior) se não informado.
 * 3. Cria Deal no CRM ("Pedidos Delivery" -> "Novo Pedido") e pedido na tabela 'orders'.
 * 4. Gera link oficial do Mercado Pago (Pix/Cartão).
 * 5. Envia mensagem de confirmação com link do Mercado Pago e botão CTA.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseTextOrder,
  extractAddressFromText,
  isAddressConfirmation,
} from './text-order-parser';
import { createOrderWithMercadoPago } from './create-order-with-mercado-pago';
import {
  STANDARD_DELIVERY_CUSTOM_FIELDS,
  type StandardDeliveryCustomField,
  type ContactOrderFieldsInput,
  parseAddressComponents,
  getSavedCustomerAddress,
  saveContactOrderFields,
} from './custom-fields';

export {
  STANDARD_DELIVERY_CUSTOM_FIELDS,
  type StandardDeliveryCustomField,
  type ContactOrderFieldsInput,
  parseAddressComponents,
  getSavedCustomerAddress,
  saveContactOrderFields,
};

export interface TextOrderFlowContext {
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  contactRecord: { id: string; name?: string | null; phone: string };
  contactName: string;
  senderPhone: string;
  conversationId: string;
  inboundText: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface TextOrderFlowResult {
  handled: boolean;
  outcome?: 'order_created' | 'address_requested';
  error?: string;
}

/**
 * Envia mensagem do WhatsApp (botão CTA com fallback garantido de texto)
 */
async function sendPaymentMessageWithFallback(params: {
  phoneNumberId: string;
  accessToken: string;
  toPhone: string;
  headerText: string;
  bodyText: string;
  footerText: string;
  buttonText: string;
  buttonUrl: string;
}): Promise<{ messageId: string | null; formattedText: string }> {
  const label = (params.buttonText || '💳 Pagar Agora').trim().substring(0, 20);

  // 1. Tenta CTA Url
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${params.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: params.toPhone,
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            header: { type: 'text', text: params.headerText },
            body: { text: params.bodyText },
            footer: { text: params.footerText },
            action: {
              name: 'cta_url',
              parameters: { display_text: label, url: params.buttonUrl },
            },
          },
        }),
      }
    );
    const data = await res.json();
    if (data?.messages?.[0]?.id) {
      return {
        messageId: data.messages[0].id,
        formattedText: `${params.bodyText}\n[Botão: ${label}]`,
      };
    }
  } catch (e) {
    console.warn(
      '[sendPaymentMessageWithFallback] CTA Button failed, trying text fallback:',
      e
    );
  }

  // 2. Fallback de texto
  const fallbackText =
    `${params.bodyText}\n\n` +
    `👉 *Link para pagamento (Pix ou Cartão):*\n${params.buttonUrl}\n\n` +
    `_${params.footerText}_`;

  try {
    const resText = await fetch(
      `https://graph.facebook.com/v21.0/${params.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: params.toPhone,
          type: 'text',
          text: { body: fallbackText },
        }),
      }
    );
    const dataText = await resText.json();
    return {
      messageId: dataText?.messages?.[0]?.id || null,
      formattedText: fallbackText,
    };
  } catch (err) {
    console.error(
      '[sendPaymentMessageWithFallback] Texto fallback falhou:',
      err
    );
    return { messageId: null, formattedText: fallbackText };
  }
}

/**
 * Envia mensagem simples de texto para o WhatsApp do cliente
 */
async function sendSimpleTextMessage(params: {
  phoneNumberId: string;
  accessToken: string;
  toPhone: string;
  text: string;
}): Promise<string | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${params.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: params.toPhone,
          type: 'text',
          text: { body: params.text },
        }),
      }
    );
    const data = await res.json();
    return data?.messages?.[0]?.id || null;
  } catch (err) {
    console.error('[sendSimpleTextMessage] Erro ao enviar texto simples:', err);
    return null;
  }
}

/**
 * Salva mensagem enviada pelo bot na tabela 'messages'
 */
async function recordBotMessage(
  supabase: SupabaseClient,
  conversationId: string,
  text: string,
  messageId: string | null
): Promise<void> {
  try {
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: text,
      message_id: messageId,
      status: 'sent',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[recordBotMessage] Erro ao registrar mensagem do bot:', err);
  }
}

/**
 * Orquestrador principal do fluxo de pedidos por texto livre.
 */
export async function processFreeTextOrderInbound(
  ctx: TextOrderFlowContext
): Promise<TextOrderFlowResult> {
  const {
    supabase,
    accountId,
    userId,
    contactRecord,
    contactName,
    senderPhone,
    conversationId,
    inboundText,
    phoneNumberId,
    accessToken,
  } = ctx;

  const customerName = contactRecord.name || contactName || 'Cliente';

  // ============================================================
  // CASO 1: O cliente enviou uma mensagem com ITENS de pedido
  // ============================================================
  const parsedOrder = parseTextOrder(inboundText);

  if (parsedOrder.hasItems && parsedOrder.total > 0) {
    console.log('[text-order-flow] Itens reconhecidos no texto livre:', {
      itemsCount: parsedOrder.items.length,
      total: parsedOrder.total,
    });

    const itemsFormattedList = parsedOrder.items
      .map((it) => `• ${it.quantity}x ${it.title}`)
      .join('\n');

    const deliveryAddress = parsedOrder.deliveryAddress;

    // Se o cliente não colocou o endereço na mesma mensagem, verifica se possui endereço salvo
    const savedAddress = await getSavedCustomerAddress(
      supabase,
      accountId,
      contactRecord.id
    );

    // Se já veio endereço na mesma mensagem:
    if (deliveryAddress && deliveryAddress.trim().length > 5) {
      console.log(
        '[text-order-flow] Pedido completo com endereço na mesma mensagem!'
      );

      const mpResult = await createOrderWithMercadoPago(
        { accountId, userId },
        {
          contactId: contactRecord.id,
          customerName,
          deliveryKind: 'delivery',
          deliveryAddress: deliveryAddress.trim(),
          items: parsedOrder.items.map((it) => ({
            title: it.title,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
          })),
          conversationId,
          payerPhone: senderPhone,
        }
      );

      if (mpResult.ok && mpResult.link_mercado_pago) {
        await saveContactOrderFields(supabase, accountId, contactRecord.id, {
          itens: parsedOrder.items
            .map((it) => `${it.quantity}x ${it.title}`)
            .join(', '),
          endereco: deliveryAddress.trim(),
          formaPagamento: 'Mercado Pago',
          nomeCliente: customerName,
        });

        const bodyText =
          `🫔 *Pedido Confirmado!*\n\n` +
          `${itemsFormattedList}\n\n` +
          `💵 *Total: ${parsedOrder.totalFormatted}*\n` +
          `📍 *Entrega:* ${deliveryAddress.trim()}\n\n` +
          `💳 *Pague pelo link seguro do Mercado Pago (Pix ou Cartão):*\n` +
          `${mpResult.link_mercado_pago}\n\n` +
          `Assim que o pagamento for aprovado, seu pedido entra automaticamente em preparo!`;

        const sendResult = await sendPaymentMessageWithFallback({
          phoneNumberId,
          accessToken,
          toPhone: senderPhone,
          headerText: '🥟 La Empanadas',
          bodyText,
          footerText: 'Mercado Pago • Produção imediata após confirmação',
          buttonText: '💳 Pagar Agora',
          buttonUrl: mpResult.link_mercado_pago,
        });

        await recordBotMessage(
          supabase,
          conversationId,
          sendResult.formattedText,
          sendResult.messageId
        );
        return { handled: true, outcome: 'order_created' };
      }
    }

    // Se NÃO tem endereço na mensagem, solicita o endereço:
    await saveContactOrderFields(supabase, accountId, contactRecord.id, {
      itens: parsedOrder.items
        .map((it) => `${it.quantity}x ${it.title}`)
        .join(', '),
      nomeCliente: customerName,
    });

    let askAddressMessage: string;
    if (savedAddress) {
      askAddressMessage =
        `🫔 *Pedido anotado:*\n` +
        `${itemsFormattedList}\n\n` +
        `💵 *Total: ${parsedOrder.totalFormatted}*\n\n` +
        `Para onde devemos entregar?\n` +
        `Por favor, envie seu *endereço completo* (Rua, Número e Bairro) ou responda *SIM* para entregar no endereço cadastrado:\n` +
        `📍 _${savedAddress}_`;
    } else {
      askAddressMessage =
        `🫔 *Pedido anotado:*\n` +
        `${itemsFormattedList}\n\n` +
        `💵 *Total: ${parsedOrder.totalFormatted}*\n\n` +
        `Para onde devemos entregar? Por favor, envie seu *endereço completo* (Rua, Número e Bairro).`;
    }

    const sentId = await sendSimpleTextMessage({
      phoneNumberId,
      accessToken,
      toPhone: senderPhone,
      text: askAddressMessage,
    });

    await recordBotMessage(supabase, conversationId, askAddressMessage, sentId);
    return { handled: true, outcome: 'address_requested' };
  }

  // ============================================================
  // CASO 2: O cliente está respondendo ao pedido anotado com endereço
  // ============================================================
  const { data: lastBotMessages } = await supabase
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .order('created_at', { ascending: false })
    .limit(3);

  const lastBotMsg = lastBotMessages?.find(
    (m: { content_text?: string | null }) =>
      m.content_text && m.content_text.includes('Pedido anotado:')
  );

  if (lastBotMsg && lastBotMsg.content_text) {
    console.log(
      '[text-order-flow] Detectada resposta a pedido anotado pendente de endereço!'
    );

    const pendingOrderParsed = parseTextOrder(lastBotMsg.content_text);

    if (pendingOrderParsed.hasItems && pendingOrderParsed.total > 0) {
      const savedAddress = await getSavedCustomerAddress(
        supabase,
        accountId,
        contactRecord.id
      );

      let confirmedAddress: string | null = null;

      if (isAddressConfirmation(inboundText) && savedAddress) {
        confirmedAddress = savedAddress;
      } else {
        const candidate = extractAddressFromText(inboundText);
        if (candidate) {
          confirmedAddress = candidate;
        } else if (
          inboundText.trim().length >= 8 &&
          !['oi', 'ola', 'boa noite', 'cardapio', 'menu'].includes(
            inboundText.toLowerCase().trim()
          )
        ) {
          confirmedAddress = inboundText.trim();
        }
      }

      if (confirmedAddress) {
        console.log('[text-order-flow] Endereço confirmado:', confirmedAddress);

        const mpResult = await createOrderWithMercadoPago(
          { accountId, userId },
          {
            contactId: contactRecord.id,
            customerName,
            deliveryKind: 'delivery',
            deliveryAddress: confirmedAddress,
            items: pendingOrderParsed.items.map((it) => ({
              title: it.title,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
            })),
            conversationId,
            payerPhone: senderPhone,
          }
        );

        if (mpResult.ok && mpResult.link_mercado_pago) {
          const itemsFormattedList = pendingOrderParsed.items
            .map((it) => `• ${it.quantity}x ${it.title}`)
            .join('\n');

          await saveContactOrderFields(supabase, accountId, contactRecord.id, {
            itens: pendingOrderParsed.items
              .map((it) => `${it.quantity}x ${it.title}`)
              .join(', '),
            endereco: confirmedAddress,
            formaPagamento: 'Mercado Pago',
            nomeCliente: customerName,
          });

          const bodyText =
            `🫔 *Pedido Confirmado!*\n\n` +
            `${itemsFormattedList}\n\n` +
            `💵 *Total: ${pendingOrderParsed.totalFormatted}*\n` +
            `📍 *Entrega:* ${confirmedAddress}\n\n` +
            `💳 *Pague pelo link seguro do Mercado Pago (Pix ou Cartão):*\n` +
            `${mpResult.link_mercado_pago}\n\n` +
            `Assim que o pagamento for aprovado, seu pedido entra automaticamente em preparo!`;

          const sendResult = await sendPaymentMessageWithFallback({
            phoneNumberId,
            accessToken,
            toPhone: senderPhone,
            headerText: '🥟 La Empanadas',
            bodyText,
            footerText: 'Mercado Pago • Produção imediata após confirmação',
            buttonText: '💳 Pagar Agora',
            buttonUrl: mpResult.link_mercado_pago,
          });

          await recordBotMessage(
            supabase,
            conversationId,
            sendResult.formattedText,
            sendResult.messageId
          );
          return { handled: true, outcome: 'order_created' };
        }
      }
    }
  }

  return { handled: false };
}
