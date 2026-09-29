/**
 * Helpers puros do webhook do Mercado Pago — sem I/O, para testar.
 *
 * Referência: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 */

import * as crypto from 'crypto';

/**
 * Extrai o id do pagamento de uma notificação. Aceita os dois formatos:
 *  - Webhooks:  body { type: 'payment', action: 'payment.updated', data: { id } }
 *               e query `?data.id=...&type=payment`
 *  - IPN antigo: query `?topic=payment&id=...`
 * Retorna null quando a notificação não é de pagamento (ex.: merchant_order).
 */
export function extractPaymentId(
  body: unknown,
  query: URLSearchParams
): string | null {
  const b = (body && typeof body === 'object' ? body : {}) as {
    type?: string;
    topic?: string;
    action?: string;
    data?: { id?: string | number };
  };

  const topic = b.type ?? b.topic ?? query.get('type') ?? query.get('topic');
  const isPayment =
    topic === 'payment' || (typeof b.action === 'string' && b.action.startsWith('payment.'));
  if (!isPayment) return null;

  const id = b.data?.id ?? query.get('data.id') ?? query.get('id');
  return id === undefined || id === null || id === '' ? null : String(id);
}

/**
 * Valida o header `x-signature` ("ts=<ts>,v1=<hmac>").
 *
 * O Mercado Pago assina o manifest
 *   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * com HMAC-SHA256 usando a "assinatura secreta" do painel. O `data.id`
 * vem da query string e vai em minúsculas quando é alfanumérico; partes
 * ausentes são omitidas do manifest.
 */
export function isValidMercadoPagoSignature(args: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string;
}): boolean {
  if (!args.xSignature) return false;

  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of args.xSignature.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=').trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (!ts || !v1) return false;

  let manifest = '';
  if (args.dataId) manifest += `id:${args.dataId.toLowerCase()};`;
  if (args.xRequestId) manifest += `request-id:${args.xRequestId};`;
  manifest += `ts:${ts};`;

  const expected = crypto.createHmac('sha256', args.secret).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Status que o resto do sistema lê em `orders.status` (sempre minúsculo). */
export const ORDER_STATUS_PAID = 'paid';

export function isOrderPaid(status: unknown): boolean {
  return typeof status === 'string' && status.toLowerCase() === ORDER_STATUS_PAID;
}
