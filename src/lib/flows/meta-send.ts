import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { supabaseAdmin } from './admin-client';
import { sendWhatsAppPaymentMessage } from '@/lib/whatsapp/payment-message';

interface SendPaymentEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttonUrl: string;
  buttonText?: string;
  effectKey: string;
}

/** Durable at-most-once payment delivery. Uncertain claims require reconciliation. */
export async function engineSendPayment(
  args: SendPaymentEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();
  if (!args.effectKey.trim()) throw new Error('Payment effect key required');
  const request = {
    conversationId: args.conversationId,
    contactId: args.contactId,
    bodyText: args.bodyText,
    buttonUrl: args.buttonUrl,
    buttonText: args.buttonText ?? 'Pagar pedido',
  };
  const { error: claimError } = await db.from('order_message_outbox').insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    effect_key: args.effectKey,
    status: 'sending',
    payload: { request },
  });
  if (claimError) {
    if (claimError.code !== '23505')
      throw new Error(`Payment claim failed: ${claimError.message}`);
    const { data: previous, error } = await db
      .from('order_message_outbox')
      .select('*')
      .eq('account_id', args.accountId)
      .eq('effect_key', args.effectKey)
      .maybeSingle();
    const storedRequest = previous?.payload?.request;
    if (
      error ||
      !previous ||
      !storedRequest ||
      !Object.entries(request).every(
        ([key, value]) => storedRequest[key] === value
      )
    )
      throw new Error('Payment claim replay unavailable or input changed');
    if (previous.status !== 'sent' || !previous.message_id)
      throw new Error(
        'Payment delivery pending or uncertain; reconcile before retry'
      );
    return { whatsapp_message_id: previous.message_id };
  }
  try {
    const { data: conversation, error: conversationError } = await db
      .from('conversations')
      .select('id')
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .maybeSingle();
    if (conversationError || !conversation)
      throw new Error('Conversation not found for this account/contact');
    const { data: contact, error: contactError } = await db
      .from('contacts')
      .select('id, phone')
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    if (contactError || !contact?.phone)
      throw new Error('Contact not found for this account');
    const phone = sanitizePhoneForMeta(contact.phone);
    if (!isValidE164(phone)) throw new Error('Invalid payment recipient phone');
    // Never use conversations.last_message_at: it also includes our own sends.
    const { data: inbound, error: inboundError } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', args.conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inboundError || !inbound?.created_at)
      throw new Error('Last customer timestamp unavailable');
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', args.accountId)
      .single();
    if (configError || !config)
      throw new Error('WhatsApp not configured for this account');
    const receipt = await sendWhatsAppPaymentMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      toPhone: phone,
      bodyText: args.bodyText,
      buttonUrl: args.buttonUrl,
      buttonText: request.buttonText,
      lastCustomerMessageAt: inbound.created_at,
    });
    if (!receipt.messageId) throw new Error('Payment delivery ambiguous');
    // Save the known receipt before secondary writes; retain it even if they fail.
    const { data: savedReceipt, error: receiptError } = await db
      .from('order_message_outbox')
      .update({
        status: 'uncertain',
        message_id: receipt.messageId,
        payload: { request, receipt },
      })
      .eq('account_id', args.accountId)
      .eq('effect_key', args.effectKey)
      .select('effect_key')
      .maybeSingle();
    if (receiptError || !savedReceipt)
      throw new Error('Payment receipt persistence failed');
    const { error: messageError } = await db.from('messages').insert({
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: receipt.contentType,
      content_text: receipt.formattedText,
      interactive_payload: receipt.interactivePayload ?? null,
      message_id: receipt.messageId,
      status: 'sent',
    });
    if (messageError) throw new Error('Payment message persistence failed');
    const { data: updatedConversation, error: updateError } = await db
      .from('conversations')
      .update({
        last_message_text: receipt.formattedText,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .select('id')
      .maybeSingle();
    if (updateError || !updatedConversation)
      throw new Error('Payment conversation persistence failed');
    const { data: completed, error: completedError } = await db
      .from('order_message_outbox')
      .update({ status: 'sent' })
      .eq('account_id', args.accountId)
      .eq('effect_key', args.effectKey)
      .select('effect_key')
      .maybeSingle();
    if (completedError || !completed)
      throw new Error('Payment completion persistence failed');
    return { whatsapp_message_id: receipt.messageId };
  } catch (error) {
    const { error: markError } = await db
      .from('order_message_outbox')
      .update({ status: 'uncertain' })
      .eq('account_id', args.accountId)
      .eq('effect_key', args.effectKey);
    if (markError)
      throw new Error(
        'Payment delivery failed and uncertainty could not be persisted; claim remains blocked',
        { cause: error }
      );
    throw error;
  }
}

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string;
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string;
  conversationId: string;
  contactId: string;
  text: string;
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account');
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single();
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account');
  }

  const accessToken = decrypt(config.access_token);

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: args.text,
    });
    return r.messageId;
  };

  const variants = phoneVariants(sanitized);
  let workingPhone = sanitized;
  let waMessageId = '';
  let lastError: unknown = null;
  for (const v of variants) {
    try {
      waMessageId = await attempt(v);
      workingPhone = v;
      lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;

  if (workingPhone !== sanitized) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
  });
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`);
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId);

  return { whatsapp_message_id: waMessageId };
}

interface SendMediaEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  kind: MediaKind;
  /** Public URL Meta fetches at send time. */
  link: string;
  caption?: string;
  /** Document-only; ignored by Meta for image/video. */
  filename?: string;
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account');
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single();
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account');
  }

  const accessToken = decrypt(config.access_token);

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    });
    return r.messageId;
  };

  const variants = phoneVariants(sanitized);
  let workingPhone = sanitized;
  let waMessageId = '';
  let lastError: unknown = null;
  for (const v of variants) {
    try {
      waMessageId = await attempt(v);
      workingPhone = v;
      lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;

  if (workingPhone !== sanitized) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`;
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  });
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`);
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId);

  return { whatsapp_message_id: waMessageId };
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttons: InteractiveButton[];
  headerText?: string;
  footerText?: string;
}

interface SendInteractiveListEngineArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  bodyText: string;
  buttonLabel: string;
  sections: InteractiveListSection[];
  headerText?: string;
  footerText?: string;
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' });
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' });
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' });

async function sendInteractiveViaMeta(
  input: SendInput
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin();

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account');
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single();
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account');
  }

  const accessToken = decrypt(config.access_token);

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      });
      return r.messageId;
    }
    const r = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    });
    return r.messageId;
  };

  // Same phone-variant retry as automations/meta-send.ts. Numbers
  // registered with/without a trunk 0 + Meta's sandbox quirks all
  // need this to reliably land a message.
  const variants = phoneVariants(sanitized);
  let workingPhone = sanitized;
  let waMessageId = '';
  let lastError: unknown = null;
  for (const v of variants) {
    try {
      waMessageId = await attempt(v);
      workingPhone = v;
      lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;

  if (workingPhone !== sanitized) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives.
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    message_id: waMessageId,
    status: 'sent',
  });
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`);
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId);

  return { whatsapp_message_id: waMessageId };
}
