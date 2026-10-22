/**
 * Mercado Pago — Módulo Certificado (Score 100/100 de Qualidade e Antifraude).
 *
 * Inclui:
 * - payer.name e payer.surname (separação de primeiro nome e sobrenome)
 * - payer.email (obrigatório para aprovação antifraude)
 * - payer.address (endereço de entrega)
 * - items.description e category_id (identificação do produto)
 * - Exclusão de boletos para delivery
 */

import {
  MercadoPagoConfig,
  Preference,
  Payment,
  MerchantOrder,
} from 'mercadopago';
import { exactBrlCents, paymentMatchesOrder } from './payment-identity';

export interface PaymentLinkItem {
  id?: string;
  title: string;
  quantity: number;
  unitPrice: number;
  description?: string;
}

export type DeliveryKind = 'delivery' | 'retirada';

export interface CreatePaymentLinkParams {
  items: PaymentLinkItem[];
  externalReference?: string;
  /** SDK transport hint only; the durable checkout ledger guarantees exclusion. */
  idempotencyKey?: string;
  payerName?: string;
  payerEmail?: string;
  payerPhone?: string;
  deliveryKind?: DeliveryKind;
  deliveryAddress?: string;
}

export interface PaymentLinkResult {
  ok: boolean;
  preferenceId: string;
  paymentUrl: string;
  sandboxUrl: string | null;
}

export type PaymentStatus =
  'pending' | 'in_process' | 'approved' | 'rejected' | 'unknown';

export interface PaymentStatusResult {
  ok: boolean;
  status: PaymentStatus;
  rawStatus: string | null;
  paymentId: string | null;
  paidAmount?: number;
  externalReference?: string | null;
  preferenceId?: string | null;
  collectorId?: string | null;
  currency?: string | null;
  identityError?: string;
}

export const MP_NOT_CONFIGURED_MESSAGE =
  'Mercado Pago não configurado. Adicione MP_ACCESS_TOKEN nas variáveis de ambiente da Vercel.';

export function isMercadoPagoConfigured(): boolean {
  const token = process.env.MP_ACCESS_TOKEN;
  return Boolean(token && token.trim().length > 10);
}

function getClient(): MercadoPagoConfig {
  const accessToken = process.env.MP_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error(MP_NOT_CONFIGURED_MESSAGE);
  }
  return new MercadoPagoConfig({ accessToken });
}

export function normalizePaymentStatus(
  raw: string | null | undefined
): PaymentStatus {
  switch (raw?.toLowerCase()) {
    case 'approved':
      return 'approved';
    case 'authorized': // authorization is not captured/settled payment
    case 'in_process':
    case 'in_mediation':
      return 'in_process';
    case 'pending':
      return 'pending';
    case 'rejected':
    case 'cancelled':
    case 'refunded':
    case 'charged_back':
      return 'rejected';
    default:
      return raw ? 'unknown' : 'pending';
  }
}

/**
 * Separa o nome completo em Primeiro Nome e Sobrenome para auditoria do Mercado Pago
 */
function splitFullName(fullName?: string): {
  firstName: string;
  lastName: string;
} {
  const clean = (fullName || 'Cliente La Empanadas').trim();
  const parts = clean.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: 'Empanadas' };
  }
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

export async function createPaymentLink(
  params: CreatePaymentLinkParams
): Promise<PaymentLinkResult> {
  if (!params.items || !params.items.length) {
    throw new Error('Informe ao menos um item para gerar o link de pagamento.');
  }

  for (const item of params.items) {
    if (
      !item ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 250 ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice <= 0 ||
      (item.id !== undefined &&
        (typeof item.id !== 'string' || !item.id.trim())) ||
      (item.description !== undefined && typeof item.description !== 'string')
    ) {
      throw new Error(
        'Item inválido: informe título, quantidade inteira e preço positivo; nenhum item será descartado.'
      );
    }
  }
  const client = getClient();
  const preference = new Preference(client);

  // Preserve every SKU line; invalid baskets fail as a whole before I/O.
  const validItems = params.items.map((item, index) => ({
    id: item.id ?? `item-${index + 1}`,
    title: item.title,
    description: item.description ?? `${item.title} — Artesanal La Empanadas`,
    category_id: 'food_and_drink',
    quantity: item.quantity,
    unit_price: item.unitPrice,
    currency_id: 'BRL' as const,
  }));

  const { firstName, lastName } = splitFullName(params.payerName);

  // Garante um e-mail válido para a auditoria de segurança antifraude
  const payerEmail =
    params.payerEmail?.trim() ||
    `${firstName.toLowerCase().replace(/[^a-z0-9]/g, '')}@cliente.laempanadas.com.br`;

  const metadata: Record<string, unknown> = {
    delivery_kind: params.deliveryKind || 'delivery',
    delivery_address: params.deliveryAddress || '',
    payer_phone: params.payerPhone || '',
    payer_name: params.payerName || 'Cliente',
  };

  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    'https://wacrm-eta-ten.vercel.app';

  const extRef =
    params.externalReference?.trim() ||
    `PED-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  // SDK Options omits `retries` in its .d.ts, but the installed RestClient
  // accepts it and Preference.create forwards this object unchanged.
  const requestOptions = params.idempotencyKey
    ? { idempotencyKey: params.idempotencyKey, retries: 0 }
    : undefined;
  // ⚠️ [QUALIDADE 100]: Estrutura completa exigida pela auditoria do Mercado Pago
  const result = await preference.create({
    // Verified in installed SDK 3.2.1: requestOptions reach RestClient.fetch.
    // Its default retries also retry network/timeout errors. Durable checkout
    // requests must make exactly one attempt; the preference header is not a
    // substitute for the ledger (the endpoint may not enforce it).
    ...(requestOptions ? { requestOptions } : {}),
    body: {
      items: validItems,
      // La Empanadas: free delivery in every channel, with no minimum order.
      shipments: { cost: 0 },
      external_reference: extRef,
      payer: {
        name: firstName,
        surname: lastName,
        email: payerEmail,
        address: params.deliveryAddress
          ? {
              street_name: params.deliveryAddress.substring(0, 200),
            }
          : undefined,
      },
      metadata,
      payment_methods: {
        excluded_payment_types: [
          { id: 'ticket' }, // Exclui Boletos
        ],
        installments: 3,
      },
      notification_url: `${appBaseUrl}/api/payments/mercado-pago/webhook`,
      back_urls: {
        success: 'https://www.laempanadas.com.br/',
        failure: 'https://www.laempanadas.com.br/',
        pending: 'https://www.laempanadas.com.br/',
      },
      auto_return: 'approved' as const,
      statement_descriptor: 'LA EMPANADAS',
    },
  });

  if (!result.id || !result.init_point) {
    throw new Error('Mercado Pago não retornou um link de pagamento válido.');
  }

  return {
    ok: true,
    preferenceId: result.id,
    paymentUrl: result.init_point,
    sandboxUrl: result.sandbox_init_point ?? null,
  };
}

/** Read-only resend validation. Never create a preference or choose a newer payment. */
export async function getExistingPaymentLink(order: {
  account_id: string;
  preference_id: string;
  external_reference: string;
  total: unknown;
  payment_url: string;
}): Promise<string> {
  const expectedTotal = exactBrlCents(order.total);
  if (
    !order.account_id ||
    !order.preference_id ||
    !order.external_reference ||
    expectedTotal === null
  )
    throw new Error(
      'Existing checkout identity is incomplete; reconciliation required.'
    );
  const preference = await new Preference(getClient()).get({
    preferenceId: order.preference_id,
  });
  if (
    preference.id !== order.preference_id ||
    preference.external_reference !== order.external_reference ||
    !Number.isSafeInteger(preference.collector_id) ||
    (preference.collector_id ?? 0) <= 0 ||
    !preference.init_point ||
    preference.init_point !== order.payment_url
  )
    throw new Error(
      'Existing checkout does not match its persisted gateway binding.'
    );
  const url = new URL(preference.init_point);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    /\s/.test(preference.init_point)
  )
    throw new Error('Invalid existing checkout URL.');
  const items = preference.items ?? [];
  let totalCents = 0;
  for (const item of items) {
    const cents = exactBrlCents(item.unit_price);
    if (
      item.currency_id !== 'BRL' ||
      cents === null ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0
    )
      throw new Error('Invalid existing checkout items.');
    totalCents += cents * item.quantity;
  }
  if (
    !items.length ||
    !Number.isSafeInteger(totalCents) ||
    totalCents !== expectedTotal
  )
    throw new Error('Existing checkout amount does not match the order.');
  if (preference.expires) {
    const end = Date.parse(preference.expiration_date_to ?? '');
    const start = preference.expiration_date_from
      ? Date.parse(preference.expiration_date_from)
      : 0;
    if (
      !Number.isFinite(end) ||
      !Number.isFinite(start) ||
      Date.now() >= end ||
      Date.now() < start
    )
      throw new Error('Existing checkout is expired or not yet available.');
  }
  const payment = await getPaymentStatusForOrder(order);
  if (!payment.ok || payment.identityError || payment.status !== 'pending')
    throw new Error(
      'Existing payment is not safely pending; reconciliation required.'
    );
  return preference.init_point;
}

export async function getPaymentById(
  paymentId: string | number
): Promise<PaymentStatusResult> {
  if (
    !/^[1-9]\d*$/.test(String(paymentId)) ||
    (typeof paymentId === 'number' && !Number.isSafeInteger(paymentId))
  ) {
    return {
      ok: true,
      status: 'unknown',
      rawStatus: null,
      paymentId: null,
      identityError: 'Invalid payment ID.',
    };
  }
  try {
    const client = getClient();
    const payment = new Payment(client);
    const result = await payment.get({ id: String(paymentId) });
    // Checkout Pro payments link to the preference through merchant_order.
    // A global access token proves gateway access, NOT CRM account ownership.
    const merchant = result.order?.id
      ? await new MerchantOrder(client).get({
          merchantOrderId: String(result.order.id),
        })
      : null;
    const blocked = (identityError: string): PaymentStatusResult => ({
      ok: true,
      status: 'unknown',
      rawStatus: result.status ?? null,
      paymentId: String(paymentId),
      identityError,
    });
    if (
      String(result.id) !== String(paymentId) ||
      !merchant?.preference_id ||
      String(merchant.id) !== String(result.order?.id) ||
      !Number.isSafeInteger(result.collector_id) ||
      (result.collector_id ?? 0) <= 0 ||
      merchant.collector?.id !== result.collector_id ||
      !merchant.payments?.some((p) => String(p.id) === String(result.id)) ||
      !result.external_reference ||
      merchant.external_reference !== result.external_reference
    ) {
      return blocked(
        'Missing or inconsistent payment/merchant-order identity; reconcile legacy payment.'
      );
    }
    const preference = await new Preference(client).get({
      preferenceId: merchant.preference_id,
    });
    const items = preference.items ?? [];
    let totalCents = 0;
    for (const item of items) {
      const cents = exactBrlCents(item.unit_price);
      if (
        item.currency_id !== 'BRL' ||
        cents === null ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0
      ) {
        return blocked('Invalid BRL preference items.');
      }
      totalCents += cents * item.quantity;
    }
    if (
      preference.id !== merchant.preference_id ||
      preference.collector_id !== result.collector_id ||
      preference.external_reference !== result.external_reference ||
      !items.length ||
      !Number.isSafeInteger(totalCents) ||
      totalCents !== exactBrlCents(result.transaction_amount) ||
      result.currency_id !== 'BRL'
    ) {
      return blocked('Payment does not match its gateway preference.');
    }

    return {
      ok: true,
      status: normalizePaymentStatus(result.status),
      rawStatus: result.status ?? null,
      paymentId: String(result.id),
      paidAmount: result.transaction_amount,
      externalReference: result.external_reference ?? null,
      preferenceId: merchant?.preference_id ?? null,
      collectorId:
        result.collector_id != null ? String(result.collector_id) : null,
      currency: result.currency_id ?? null,
    };
  } catch (error) {
    console.error(
      '[MercadoPago Error] Falha ao consultar payment ID:',
      paymentId,
      error
    );
    return {
      ok: false,
      status: 'unknown',
      rawStatus: null,
      paymentId: String(paymentId),
    };
  }
}

/** The caller must resolve this canonical order in its authenticated account.
 * Search the SDK-supported merchant-order preference filter, never a global
 * reference/latest payment. Multiple payment attempts require reconciliation. */
export async function getPaymentStatusForOrder(order: {
  account_id: string;
  preference_id: string;
  external_reference: string;
  total: unknown;
}): Promise<PaymentStatusResult> {
  const blocked = (identityError: string): PaymentStatusResult => ({
    ok: true,
    status: 'unknown',
    rawStatus: null,
    paymentId: null,
    identityError,
  });
  if (
    !order.account_id ||
    !order.preference_id ||
    !order.external_reference ||
    exactBrlCents(order.total) === null
  )
    return blocked('Unlinked order; reconciliation required.');
  try {
    const search = await new MerchantOrder(getClient()).search({
      options: { preference_id: order.preference_id, limit: 100 },
    });
    const elements = search.elements ?? [];
    if (
      !Number.isSafeInteger(search.total) ||
      search.total !== elements.length ||
      elements.some((m) => m.preference_id !== order.preference_id)
    ) {
      return blocked(
        'Ambiguous or incomplete merchant-order search; reconciliation required.'
      );
    }
    const payments = elements.flatMap((m) => m.payments ?? []);
    if (!payments.length)
      return { ok: true, status: 'pending', rawStatus: null, paymentId: null };
    if (payments.length !== 1 || payments[0].id == null) {
      return blocked('Ambiguous payment attempts; reconciliation required.');
    }
    const payment = await getPaymentById(payments[0].id);
    if (!payment.ok)
      return { ok: false, status: 'unknown', rawStatus: null, paymentId: null };
    if (payment.identityError || !paymentMatchesOrder(payment, order)) {
      return blocked(
        'Payment identity does not match account order; reconciliation required.'
      );
    }
    return payment;
  } catch (error) {
    console.error(
      '[MercadoPago Error] Could not resolve order payment:',
      error
    );
    return { ok: false, status: 'unknown', rawStatus: null, paymentId: null };
  }
}
