/**
 * Formatador e Sanitizador de Mensagens de Saída do WhatsApp.
 *
 * Responsável por:
 * 1. Sanitizar mensagens removendo marcadores de simulação de botões como `[Botão: ...]`
 * 2. Detectar links de checkout do Mercado Pago (mercadopago.com.br/checkout...)
 * 3. Transformar mensagens com link em objetos interativos CTA URL (WhatsApp Cloud API)
 * 4. Prover fallback de envio em texto puro com o link no final, sem simulação de botões.
 */

export const BUTTON_SIMULATION_REGEX =
  /(?:\\)?\[\s*bot[ãa]o\s*:[^\]]*?(?:\\)?\]/gi;

export const MERCADO_PAGO_CHECKOUT_REGEX =
  /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)*mercadopago\.(?:com\.br|com)\/checkout[^\s)\]>"'*,;]*/i;

export interface WhatsAppInteractiveCtaUrlActionParameters {
  display_text: string;
  url: string;
}

export interface WhatsAppInteractiveCtaUrlPayload {
  type: 'interactive';
  interactive: {
    type: 'cta_url';
    header?: { type: 'text'; text: string };
    body: { text: string };
    footer?: { text: string };
    action: {
      name: 'cta_url';
      parameters: WhatsAppInteractiveCtaUrlActionParameters;
    };
  };
}

export interface WhatsAppTextPayload {
  type: 'text';
  text: {
    body: string;
  };
}

export interface FormattedOutgoingWhatsAppMessage {
  isInteractive: boolean;
  paymentUrl: string | null;
  bodyText: string;
  fallbackText: string;
  interactivePayload: WhatsAppInteractiveCtaUrlPayload | null;
  textPayload: WhatsAppTextPayload;
}

export interface FormatOutgoingWhatsAppOptions {
  headerText?: string;
  footerText?: string;
  buttonText?: string;
}

/**
 * Remove qualquer texto simulando botões no formato `[Botão: ...]` ou `\[Botão: ...\]`.
 * Limpa espaços extras e linhas vazias redundantes.
 */
export function sanitizeOutgoingText(text: string): string {
  if (!text) return '';
  return text
    .replace(BUTTON_SIMULATION_REGEX, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extrai a URL de checkout do Mercado Pago contida na mensagem, se houver.
 * Retorna a URL normalizada e o texto sem a URL.
 */
export function extractMercadoPagoCheckoutUrl(text: string): {
  url: string;
  textWithoutUrl: string;
} | null {
  if (!text) return null;
  const match = text.match(MERCADO_PAGO_CHECKOUT_REGEX);
  if (!match) return null;

  const rawUrl = match[0];
  let cleanUrl = rawUrl.replace(/[.,;:!?]+$/, '');
  if (!/^https?:\/\//i.test(cleanUrl)) {
    cleanUrl = `https://${cleanUrl}`;
  }

  const textWithoutUrl = text
    .replace(rawUrl, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    url: cleanUrl,
    textWithoutUrl,
  };
}

/**
 * Formata a mensagem de saída para o WhatsApp Cloud API:
 * - Detecta e remove qualquer `[Botão: ...]`
 * - Se houver URL do Mercado Pago, cria objeto interativo cta_url
 * - Prepara fallback em texto puro com a URL no final e sem texto de botão
 */
export function formatOutgoingWhatsAppMessage(
  text: string,
  options?: FormatOutgoingWhatsAppOptions
): FormattedOutgoingWhatsAppMessage {
  const sanitized = sanitizeOutgoingText(text);
  const checkout = extractMercadoPagoCheckoutUrl(sanitized);

  if (!checkout) {
    return {
      isInteractive: false,
      paymentUrl: null,
      bodyText: sanitized,
      fallbackText: sanitized,
      interactivePayload: null,
      textPayload: {
        type: 'text',
        text: { body: sanitized },
      },
    };
  }

  const paymentUrl = checkout.url;
  const displayText = (options?.buttonText || '💳 Pagar Agora')
    .trim()
    .slice(0, 20);

  // Meta exige body.text não-vazio (1-1024 caracteres)
  const bodyText =
    checkout.textWithoutUrl || 'Clique no botão abaixo para realizar o pagamento:';

  // Fallback: mensagem limpa com a URL no final, sem botões simulados
  const fallbackText = checkout.textWithoutUrl
    ? `${checkout.textWithoutUrl}\n\n${paymentUrl}`
    : paymentUrl;

  const interactive: WhatsAppInteractiveCtaUrlPayload['interactive'] = {
    type: 'cta_url',
    body: { text: bodyText },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: displayText,
        url: paymentUrl,
      },
    },
  };

  if (options?.headerText) {
    interactive.header = { type: 'text', text: options.headerText };
  }
  if (options?.footerText) {
    interactive.footer = { text: options.footerText };
  }

  return {
    isInteractive: true,
    paymentUrl,
    bodyText,
    fallbackText,
    interactivePayload: {
      type: 'interactive',
      interactive,
    },
    textPayload: {
      type: 'text',
      text: { body: fallbackText },
    },
  };
}
