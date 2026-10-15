import type { MessageTemplate } from '@/types';
import {
  sanitizeOutgoingText,
  type WhatsAppInteractiveCtaUrlPayload,
} from './outgoing-formatter';

export interface WhatsAppPaymentMessageParams {
  phoneNumberId: string;
  accessToken: string;
  toPhone: string;
  bodyText: string;
  buttonUrl: string;
  buttonText?: string;
  lastCustomerMessageAt: string;
  /** Must come from a server-side lookup scoped to this WhatsApp account, never request input.
   * Only fully static, approved templates with one exact matching URL are supported.
   */
  template?: MessageTemplate;
}

export interface WhatsAppPaymentMessageResult {
  messageId: string;
  contentType: 'interactive' | 'text' | 'template';
  formattedText: string;
  /** Full interactive object as sent to Meta (not the envelope). */
  interactivePayload?: WhatsAppInteractiveCtaUrlPayload['interactive'];
}

export async function sendWhatsAppPaymentMessage(
  params: WhatsAppPaymentMessageParams
): Promise<WhatsAppPaymentMessageResult> {
  const lastInbound = Date.parse(params.lastCustomerMessageAt);
  const elapsed = Date.now() - lastInbound;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      params.lastCustomerMessageAt
    ) ||
    !Number.isFinite(lastInbound) ||
    elapsed < 0
  ) {
    throw new Error('Invalid last customer message timestamp');
  }
  const windowClosed = elapsed >= 24 * 60 * 60 * 1000;
  let url: URL;
  try {
    url = new URL(params.buttonUrl);
  } catch {
    throw new Error('Payment URL must be an absolute HTTPS URL');
  }
  if (
    !/^https:\/\//i.test(params.buttonUrl) ||
    /[\s\u0000-\u001f\u007f]/.test(params.buttonUrl) ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Payment URL must be an absolute HTTPS URL without credentials'
    );
  }
  const displayText = params.buttonText ?? 'Pagar pedido';
  if (!displayText.trim() || displayText.length > 20) {
    throw new Error('CTA button text must contain 1–20 characters');
  }
  const formattedText =
    sanitizeOutgoingText(params.bodyText.replace(/https?:\/\/\S+/gi, '')) ||
    'Clique no botão abaixo para realizar o pagamento.';
  if (formattedText.length > 1024)
    throw new Error('CTA body exceeds 1024 characters');
  const interactivePayload: WhatsAppInteractiveCtaUrlPayload['interactive'] = {
    type: 'cta_url',
    body: { text: formattedText },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: displayText,
        url: params.buttonUrl,
      },
    },
  };
  const envelope = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.toPhone,
  };
  const attempt = async (content: Record<string, unknown>) => {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${params.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...envelope, ...content }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const raw: unknown = await response.json();
    const data = asRecord(raw);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const id = asRecord(messages[0]).id;
    const messageId = typeof id === 'string' && id.trim() ? id : undefined;
    return { response, data, messageId };
  };
  if (windowClosed) {
    const template = params.template;
    const button = template?.buttons?.[0];
    if (
      !template ||
      template.status !== 'APPROVED' ||
      !/^[a-z0-9_]+$/.test(template.name) ||
      !template.language ||
      !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(template.language) ||
      !template.body_text?.trim() ||
      /{{|}}/.test(
        `${template.body_text} ${template.header_content ?? ''} ${template.footer_text ?? ''}`
      ) ||
      (template.header_type && template.header_type !== 'text') ||
      template.buttons?.length !== 1 ||
      button?.type !== 'URL' ||
      button.url !== params.buttonUrl
    ) {
      throw new Error(
        'Payment message blocked: customer service window closed; approved compatible static template required'
      );
    }
    const sent = await attempt({
      type: 'template',
      template: { name: template.name, language: { code: template.language } },
    });
    if (!sent.response.ok || sent.data.error || !sent.messageId) {
      throw new Error(
        'Payment template rejected or delivery ambiguous; no retry performed'
      );
    }
    return {
      messageId: sent.messageId,
      contentType: 'template',
      formattedText: template.body_text,
    };
  }
  const sent = await attempt({
    type: 'interactive',
    interactive: interactivePayload,
  });
  if (sent.response.ok && !sent.data.error && sent.messageId) {
    return {
      messageId: sent.messageId,
      contentType: 'interactive' as const,
      formattedText,
      interactivePayload,
    };
  }
  const error = asRecord(sent.data.error);
  const detail = `${typeof error.message === 'string' ? error.message : ''} ${String(asRecord(error.error_data).details ?? '')}`;
  const unsupported =
    error.code === 131051 ||
    (error.code === 100 &&
      /cta_url/i.test(detail) &&
      /unsupported|not supported/i.test(detail));
  const windowError = /window|re-engagement|reengagement|24.?hour/i.test(
    detail
  );
  if (
    sent.response.status !== 400 ||
    sent.messageId ||
    'messages' in sent.data ||
    error.is_transient === true ||
    windowError ||
    !unsupported
  ) {
    throw new Error(
      'Payment message rejected or delivery ambiguous; no retry performed'
    );
  }
  // The customer-service window may have closed while the CTA request was in flight.
  if (Date.now() - lastInbound >= 24 * 60 * 60 * 1000) {
    throw new Error(
      'Payment text fallback blocked: customer service window closed'
    );
  }
  const fallbackText = `${formattedText}\n\n${params.buttonUrl}`;
  const fallback = await attempt({
    type: 'text',
    text: { body: fallbackText, preview_url: false },
  });
  if (!fallback.response.ok || fallback.data.error || !fallback.messageId) {
    throw new Error(
      'Payment text fallback rejected or delivery ambiguous; no retry performed'
    );
  }
  return {
    messageId: fallback.messageId,
    contentType: 'text' as const,
    formattedText: fallbackText,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
