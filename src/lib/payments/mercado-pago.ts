/**
 * Mercado Pago — Módulo Seguro de Pagamentos (Checkout Pro & Webhooks).
 *
 * ⚠️ SERVER-SIDE ONLY. Este módulo acessa `process.env.MP_ACCESS_TOKEN`
 * e só deve ser executado no backend (API Routes, Server Actions e Webhooks).
 *
 * Usa o SDK oficial `mercadopago` (Checkout Pro / Preferences).
 */

import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

// ============================================================
// Tipagens
// ============================================================

export interface PaymentLinkItem {
  /** Descrição / Nome do item */
  title: string;
  /** Quantidade */
  quantity: number;
  /** Preço unitário em BRL (número decimal, ex: 14.00) */
  unitPrice: number;
}

export type DeliveryKind = 'delivery' | 'retirada';

export interface CreatePaymentLinkParams {
  /** Itens do pedido */
  items: PaymentLinkItem[];
  /** Referência externa única (ex: PED-12345) */
  externalReference?: string;
  /** Nome do pagador */
  payerName?: string;
  /** Telefone do pagador */
  payerPhone?: string;
  /** Tipo de recebimento */
  deliveryKind?: DeliveryKind;
  /** Endereço de entrega */
  deliveryAddress?: string;
}

export interface PaymentLinkResult {
  ok: boolean;
  preferenceId: string;
  paymentUrl: string;
  sandboxUrl: string | null;
}

export type PaymentStatus =
  | 'pending'
  | 'in_process'
  | 'approved'
  | 'rejected'
  | 'unknown';

export interface PaymentStatusResult {
  ok: boolean;
  status: PaymentStatus;
  rawStatus: string | null;
  paymentId: string | null;
  paidAmount?: number;
}

// ============================================================
// Constantes e Utilitários de Segurança
// ============================================================

/** ⚠️ [CORREÇÃO]: Exportação exigida pelas rotas de status e API */
export const MP_NOT_CONFIGURED_MESSAGE =
  'Mercado Pago não configurado. Adicione MP_ACCESS_TOKEN nas variáveis de ambiente (Vercel → Settings → Environment Variables) e faça um redeploy. Veja docs/vercel-deploy.md.';

/** Indica se as credenciais do Mercado Pago estão configuradas no ambiente */
export function isMercadoPagoConfigured(): boolean {
  const token = process.env.MP_ACCESS_TOKEN;
  return Boolean(token && token.trim().length > 10);
}

/** Cria um client do SDK autenticado com o Access Token */
function getClient(): MercadoPagoConfig {
  const accessToken = process.env.MP_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error(MP_NOT_CONFIGURED_MESSAGE);
  }
  return new MercadoPagoConfig({ accessToken });
}

/** Normaliza status bruto retornado pelo Mercado Pago */
export function normalizePaymentStatus(
  raw: string | null | undefined
): PaymentStatus {
  switch (raw?.toLowerCase()) {
    case 'approved':
    case 'authorized':
      return 'approved';
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

// ============================================================
// Criação de Link de Pagamento (Checkout Pro)
// ============================================================

/**
 * Cria uma preferência de pagamento no Mercado Pago e devolve a URL
 * pronta para envio no WhatsApp.
 */
export async function createPaymentLink(
  params: CreatePaymentLinkParams
): Promise<PaymentLinkResult> {
  if (!params.items.length) {
    throw new Error('Informe ao menos um item para gerar o link de pagamento.');
  }

  const client = getClient();
  const preference = new Preference(client);

  const validItems = params.items
    .filter((item) => item.quantity > 0 && item.unitPrice > 0)
    .map((item, index) => ({
      id: String(index + 1),
      title: item.title.trim().substring(0, 250),
      quantity: Number(item.quantity),
      unit_price: Number(item.unitPrice),
      currency_id: 'BRL' as const,
    }));

  if (validItems.length === 0) {
    throw new Error('Nenhum item com preço válido informado.');
  }

  const metadata: Record<string, unknown> = {};
  if (params.deliveryKind) metadata.delivery_kind = params.deliveryKind;
  if (params.deliveryAddress) metadata.delivery_address = params.deliveryAddress;
  if (params.payerPhone) metadata.payer_phone = params.payerPhone;

  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://wacrm-eta-ten.vercel.app';

  const extRef =
    params.externalReference?.trim() ||
    `PED-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  const result = await preference.create({
    body: {
      items: validItems,
      external_reference: extRef,
      payer: params.payerName ? { name: params.payerName } : undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
      notification_url: `${appBaseUrl}/api/webhooks/mercadopago`,
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

// ============================================================
// Consulta e Verificação de Status
// ============================================================

/**
 * Consulta status de pagamento direto por ID do Mercado Pago.
 */
export async function getPaymentById(
  paymentId: string | number
): Promise<PaymentStatusResult> {
  try {
    const client = getClient();
    const payment = new Payment(client);
    const result = await payment.get({ id: String(paymentId) });

    return {
      ok: true,
      status: normalizePaymentStatus(result.status),
      rawStatus: result.status ?? null,
      paymentId: String(result.id),
      paidAmount: result.transaction_amount,
    };
  } catch (error) {
    console.error('[MercadoPago Error] Falha ao consultar payment ID:', paymentId, error);
    return { ok: false, status: 'unknown', rawStatus: null, paymentId: String(paymentId) };
  }
}

/**
 * Consulta status de pagamento associado a uma external_reference (ID do pedido).
 */
export async function getPaymentStatusByExternalReference(
  externalReference: string
): Promise<PaymentStatusResult> {
  try {
    const client = getClient();
    const payment = new Payment(client);

    const search = await payment.search({
      options: {
        external_reference: externalReference,
        sort: 'date_created',
        criteria: 'desc',
        limit: 1,
      },
    });

    const results = (search.results ?? []) as Array<{
      id?: number | string;
      status?: string;
      transaction_amount?: number;
    }>;

    if (!results.length) {
      return { ok: true, status: 'pending', rawStatus: null, paymentId: null };
    }

    const latest = results[0];
    return {
      ok: true,
      status: normalizePaymentStatus(latest.status),
      rawStatus: latest.status ?? null,
      paymentId: latest.id != null ? String(latest.id) : null,
      paidAmount: latest.transaction_amount,
    };
  } catch (error) {
    console.error('[MercadoPago Error] Falha ao buscar external_reference:', externalReference, error);
    return { ok: false, status: 'unknown', rawStatus: null, paymentId: null };
  }
}
