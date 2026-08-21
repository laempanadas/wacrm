import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { createPaymentLink } from '@/lib/payments/mercado-pago'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  order?: {
    catalog_id?: string
    text?: string
    product_items?: Array<{
      product_retailer_id: string
      quantity: number
      item_price: number
      currency?: string
    }>
  }
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // ignora token invalido
      }
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
      }
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError || !configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      const config = configRows[0]
      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          config.account_id,
          config.user_id,
          decryptedAccessToken,
          phoneNumberId
        )
      }
    }
  }
}

// Status transitions
const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent'
  if (current === 'failed') return false
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recipient && isValidStatusTransition(recipient.status, status.status)) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)
  }

  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    if (conv?.account_id) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        conv.account_id,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (!recs || recs.length === 0) return

    await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id)
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  return data?.id ?? null
}

async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) return

  if (!reaction.emoji) {
    await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    return
  }

  await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
}

/**
 * ⚠️ [CORREÇÃO]: Parser monetário resiliente (suporta 14.00, 14,00, 1.400,00)
 */
function parseCurrencyString(raw: string): number {
  if (!raw) return 0
  const cleaned = raw.trim().replace(/[^\d.,]/g, '')
  if (!cleaned) return 0

  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0
    }
    return parseFloat(cleaned.replace(/,/g, '')) || 0
  }

  if (cleaned.includes(',')) {
    return parseFloat(cleaned.replace(',', '.')) || 0
  }

  if (cleaned.includes('.')) {
    const parts = cleaned.split('.')
    if (parts.length === 2 && parts[1].length <= 2) {
      return parseFloat(cleaned) || 0
    }
    return parseFloat(cleaned.replace(/\./g, '')) || 0
  }

  return parseFloat(cleaned) || 0
}

/**
 * 🥟 Parser para pedidos enviados a partir do site laempanadas.com.br
 */
function parseWebsiteOrder(text: string) {
  if (!text || !text.toUpperCase().includes('LA EMPANADAS - NOVO PEDIDO')) {
    return null
  }

  // Extração flexível (com ou sem asteriscos *)
  const clienteMatch = text.match(/(?:\*?Cliente:\*?)\s*([^\n\r*]+)/i)
  const cliente = clienteMatch ? clienteMatch[1].trim() : 'Cliente'

  const enderecoMatch = text.match(/(?:\*?Entregar em:\*?)\s*([^\n\r*]+)/i)
  const endereco = enderecoMatch ? enderecoMatch[1].trim() : ''

  const totalMatch = text.match(/(?:\*?Total(?: Estimado)?:\*?)\s*R\$\s*([\d.,]+)/i)
  const total = totalMatch ? parseCurrencyString(totalMatch[1]) : 0

  const items: Array<{ title: string; quantity: number; unitPrice: number }> = []
  const itemRegex = /(?:-\s*)?(\d+)x\s*([^[—\n\r]+)(?:\[([^\]]+)\])?/gi
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(text)) !== null) {
    const quantity = parseInt(match[1], 10) || 1
    const title = match[2].trim()
    items.push({ title, quantity, unitPrice: 0 })
  }

  if (items.length > 0 && total > 0) {
    const totalQty = items.reduce((acc, it) => acc + it.quantity, 0)
    const unitAvg = total / (totalQty || 1)
    items.forEach((it) => (it.unitPrice = Number(unitAvg.toFixed(2))))
  } else if (items.length === 0 && total > 0) {
    items.push({ title: 'Pedido de Empanadas', quantity: 1, unitPrice: total })
  }

  return {
    cliente,
    endereco,
    total,
    totalFormatado: `R$ ${total.toFixed(2).replace('.', ',')}`,
    items,
  }
}

/**
 * 🌟 [CORREÇÃO]: Envia Mensagem com BOTÃO OFICIAL (CTA Button) no WhatsApp
 */
async function sendWhatsAppCtaButtonMessage(params: {
  phoneNumberId: string
  accessToken: string
  toPhone: string
  headerText: string
  bodyText: string
  footerText: string
  buttonText: string
  buttonUrl: string
}) {
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
            header: {
              type: 'text',
              text: params.headerText,
            },
            body: {
              text: params.bodyText,
            },
            footer: {
              text: params.footerText,
            },
            action: {
              name: 'cta_url',
              parameters: {
                display_text: params.buttonText,
                url: params.buttonUrl,
              },
            },
          },
        }),
      }
    )
    const data = await res.json()
    return data?.messages?.[0]?.id || null
  } catch (error) {
    console.error('[WhatsApp CTA Button Error]:', error)
    return null
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  phoneNumberId: string
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  const { contentText, mediaUrl, interactiveReplyId, order } =
    await parseMessageContent(message, accessToken)

  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
  }

  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : 'text'

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Salva mensagem recebida no banco
  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // ⚡ PEDIDO VINDO DO SITE (laempanadas.com.br) COM BOTÃO CTA
  // ============================================================
  const siteOrder = parseWebsiteOrder(contentText || '')
  if (siteOrder && siteOrder.total > 0) {
    console.log('[webhook] Pedido site detectado. Total correto:', siteOrder.total)

    const externalRef = `SITE-${Date.now()}-${contactRecord.id.substring(0, 5)}`

    // Gera o link do Mercado Pago com o total correto
    const paymentResult = await createPaymentLink({
      items: siteOrder.items,
      externalReference: externalRef,
      payerName: siteOrder.cliente,
      payerPhone: senderPhone,
      deliveryKind: 'delivery',
      deliveryAddress: siteOrder.endereco,
    })

    if (paymentResult.paymentUrl) {
      const bodyText =
        `Olá, *${siteOrder.cliente}*! Recebemos seu pedido! ✨\n\n` +
        `📍 *Entrega em:* ${siteOrder.endereco || 'A combinar'}\n` +
        `💵 *Total:* ${siteOrder.totalFormatado}\n\n` +
        `Clique no botão abaixo para pagar com segurança via Pix (aprovação imediata) ou Cartão:`

      // Envia com Botão Nativo CTA (sem link feio no texto)
      const sentMsgId = await sendWhatsAppCtaButtonMessage({
        phoneNumberId,
        accessToken,
        toPhone: senderPhone,
        headerText: '🥟 La Empanadas',
        bodyText,
        footerText: 'Mercado Pago • Produção após confirmação',
        buttonText: '💳 Pagar Agora (Pix/Cartão)',
        buttonUrl: paymentResult.paymentUrl,
      })

      if (sentMsgId) {
        await supabaseAdmin().from('messages').insert({
          conversation_id: conversation.id,
          sender_type: 'bot',
          content_type: 'interactive',
          content_text: `${bodyText}\n[Botão: Pagar Agora]`,
          message_id: sentMsgId,
          status: 'sent',
          created_at: new Date().toISOString(),
        })
      }
    }

    return
  }

  // ============================================================
  // 🔄 FLUXOS NORMAIS (Catálogo Meta / Menus)
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      order
        ? {
            kind: 'catalog_order',
            text: contentText ?? '',
            total: order.total,
            items: order.items,
            meta_message_id: message.id,
          }
        : interactiveReplyId
          ? {
              kind: 'interactive_reply',
              reply_id: interactiveReplyId,
              reply_title: contentText ?? '',
              meta_message_id: message.id,
            }
          : {
              kind: 'text',
              text: contentText ?? message.text?.body ?? '',
              meta_message_id: message.id,
            },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []

  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }

  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
  order: {
    total: number
    items: Array<{ retailer_id: string; quantity: number; unit_price: number }>
  } | null
}> {
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
    order: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    case 'order': {
      const productItems = message.order?.product_items ?? []
      const items = productItems.map((it) => ({
        retailer_id: it.product_retailer_id,
        quantity: it.quantity,
        unit_price: it.item_price,
      }))
      const total = items.reduce(
        (sum, it) => sum + it.quantity * it.unit_price,
        0
      )
      const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`
      const lines = items.map(
        (it) =>
          `• ${it.quantity}x ${it.retailer_id} — ${fmt(it.quantity * it.unit_price)}`
      )
      const summary = [
        '🛒 Novo pedido pelo catálogo:',
        ...lines,
        `Total: ${fmt(total)}`,
      ].join('\n')
      return {
        ...empty,
        contentText: summary,
        order: { total, items },
      }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return { conversation: existing, created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
