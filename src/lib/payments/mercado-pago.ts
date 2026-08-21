/**
 * Mercado Pago — Módulo Seguro de Pagamentos (Checkout Pro & Webhooks).
 *
 * ⚠️ SERVER-SIDE ONLY. Este módulo acessa `process.env.MP_ACCESS_TOKEN`
 * e só deve ser executado no backend (API Routes, Server Actions e Runners de Flow).
 *
 * Blindagem contra falhas:
 * - Funções retornam flags de sucesso/erro sem interromper a execução do Next.js.
 * - Suporta pedidos do Catálogo da Meta e do Cardápio Web (laempanadas.com.br).
 */

import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

// ============================================================
// Tipagens
// ============================================================

export interface PaymentLinkItem {
  /** Nome / Descrição do item */
  title: string;
  /** Quantidade solicitada */
  quantity: number;
  /** Preço unitário em BRL (formato numérico, ex: 14.50) */
  unitPrice: number;
}

export type DeliveryKind = 'delivery' | 'retirada';

export interface CreatePaymentLinkParams {
  /** Lista de itens do pedido */
  items: PaymentLinkItem[];
  /** Referência externa única (ex: ID do deal ou PED-123456) */
  externalReference: string;
  /** Nome do cliente para identificação */
  payerName?: string;
  /** Telefone do cliente (opcional) */
  payerPhone?: string;
  /** Tipo de entrega */
  deliveryKind?: DeliveryKind;
  /** Endereço completo para entrega */
  deliveryAddress?: string;
}

export interface PaymentLinkSuccessResult {
  ok: true;
  preferenceId: string;
  paymentUrl: string;
  sandboxUrl: string | null;
}

export interface PaymentLinkErrorResult {
  ok: false;
  errorMessage: string;
}

export type PaymentLinkResponse = PaymentLinkSuccessResult | PaymentLinkErrorResult;

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
// Funções Auxiliares de Segurança
// ============================================================

/** Verifica se a credencial do Mercado Pago está presente no ambiente */
export function isMercadoPagoConfigured(): boolean {
  const token = process.env.MP_ACCESS_TOKEN;
  return Boolean(token && token.trim().length > 10);
}

/** Cria instância segura do client Mercado Pago */
function getClient(): MercadoPagoConfig | null {
  const accessToken = process.env.MP_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  return new MercadoPagoConfig({ accessToken });
}

/** Normaliza status da API para padrões simples do CRM */
export function normalizePaymentStatus(raw: string | null | undefined): PaymentStatus {
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
 * Cria a preferência de pagamento no Mercado Pago.
 * Nunca lança erros não tratados (retorna { ok: false, errorMessage } em caso de falha).
 */
export async function createPaymentLink(
  params: CreatePaymentLinkParams
): Promise<PaymentLinkResponse> {
  try {
    const client = getClient();
    if (!client) {
      console.warn('[MercadoPago] MP_ACCESS_TOKEN não configurado nas variáveis de ambiente.');
      return {
        ok: false,
        errorMessage: 'Mercado Pago não configurado no servidor.',
      };
    }

    // Sanitização e validação dos itens
    const validItems = params.items
      .filter((item) => item.quantity > 0 && item.unitPrice > 0)
      .map((item, idx) => ({
        id: `item-${idx + 1}`,
        title: item.title.trim().substring(0, 250),
        quantity: Number(item.quantity),
        unit_price: Number(item.unitPrice),
        currency_id: 'BRL' as const,
      }));

    if (validItems.length === 0) {
      return {
        ok: false,
        errorMessage: 'Nenhum item com valor válido foi informado.',
      };
    }

    const appBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://wacrm-eta-ten.vercel.app';

    const preference = new Preference(client);

    const preferenceData = {
      body: {
        items: validItems,
        external_reference: params.externalReference,
        payer: {
          name: params.payerName?.trim() || 'Cliente',
        },
        metadata: {
          delivery_kind: params.deliveryKind || 'delivery',
          delivery_address: params.deliveryAddress || '',
          payer_phone: params.payerPhone || '',
        },
        notification_url: `${appBaseUrl}/api/webhooks/mercadopago`,
        back_urls: {
          success: 'https://www.laempanadas.com.br/',
          failure: 'https://www.laempanadas.com.br/',
          pending: 'https://www.laempanadas.com.br/',
        },
        auto_return: 'approved' as const,
        statement_descriptor: 'LA EMPANADAS',
      },
    };

    const result = await preference.create(preferenceData);

    if (!result.id || !result.init_point) {
      return {
        ok: false,
        errorMessage: 'Resposta inválida recebida da API do Mercado Pago.',
      };
    }

    return {
      ok: true,
      preferenceId: result.id,
      paymentUrl: result.init_point,
      sandboxUrl: result.sandbox_init_point || null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido ao gerar link.';
    console.error('[MercadoPago Error] Falha ao criar preferência:', message);
    return {
      ok: false,
      errorMessage: message,
    };
  }
}

// ============================================================
// Consulta e Verificação de Status
// ============================================================

/**
 * Consulta status de pagamento direto por ID do Mercado Pago (para Webhooks).
 */
export async function getPaymentById(paymentId: string | number): Promise<PaymentStatusResult> {
  try {
    const client = getClient();
    if (!client) {
      return { ok: false, status: 'unknown', rawStatus: null, paymentId: null };
    }

    const payment = new Payment(client);
    const result = await payment.get({ id: String(paymentId) });

    return {
      ok: true,
      status: normalizePaymentStatus(result.status),
      rawStatus: result.status || null,
      paymentId: String(result.id),
      paidAmount: result.transaction_amount,
    };
  } catch (error) {
    console.error('[MercadoPago Error] Falha ao consultar payment ID:', paymentId, error);
    return { ok: false, status: 'unknown', rawStatus: null, paymentId: String(paymentId) };
  }
}

/**
 * Consulta status de pagamento por externalReference (ID do pedido).
 */
export async function getPaymentStatusByExternalReference(
  externalReference: string
): Promise<PaymentStatusResult> {
  try {
    const client = getClient();
    if (!client) {
      return { ok: false, status: 'pending', rawStatus: null, paymentId: null };
    }

    const payment = new Payment(client);
    const search = await payment.search({
      options: {
        external_reference: externalReference,
        sort: 'date_created',
        criteria: 'desc',
        limit: 1,
      },
    });

    const results = (search.results || []) as Array<{
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
      rawStatus: latest.status || null,
      paymentId: latest.id != null ? String(latest.id) : null,
      paidAmount: latest.transaction_amount,
    };
  } catch (error) {
    console.error('[MercadoPago Error] Falha ao consultar external_reference:', externalReference, error);
    return { ok: false, status: 'unknown', rawStatus: null, paymentId: null };
  }
}
