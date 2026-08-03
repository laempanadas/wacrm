/**
 * Mercado Pago — geração de link de pagamento e consulta de status.
 *
 * ⚠️ SERVER-SIDE ONLY. Este módulo usa `process.env.MP_ACCESS_TOKEN`
 * (segredo) e NUNCA deve ser importado em componentes de cliente. Só
 * pode ser usado dentro de API routes / Server Actions do Next.js.
 *
 * Integração opcional: só funciona quando `MP_ACCESS_TOKEN` está
 * configurado no ambiente (veja docs/vercel-deploy.md e
 * docs/mercado-pago-setup.md). Enquanto a credencial não estiver
 * disponível, `isMercadoPagoConfigured()` retorna false e a UI mostra
 * um aviso amigável em vez de quebrar.
 *
 * Usa o SDK oficial `mercadopago` (Checkout Pro / Preferences).
 */

import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

export interface PaymentLinkItem {
  /** Descrição do item (ex.: "Combo 12 empanadas"). */
  title: string;
  /** Quantidade. */
  quantity: number;
  /** Preço unitário em reais (BRL). */
  unitPrice: number;
}

/** Tipo de recebimento do pedido. */
export type DeliveryKind = 'delivery' | 'retirada';

export interface CreatePaymentLinkParams {
  /** Itens do pedido. */
  items: PaymentLinkItem[];
  /** Referência externa opcional (ex.: número/ID do pedido). */
  externalReference?: string;
  /** Nome do pagador, apenas para exibição na preferência. */
  payerName?: string;
  /** Tipo de recebimento (informativo). */
  deliveryKind?: DeliveryKind;
  /** Endereço de entrega (apenas delivery, informativo). */
  deliveryAddress?: string;
}

export interface PaymentLinkResult {
  /** ID da preferência criada no Mercado Pago. */
  preferenceId: string;
  /** URL de pagamento em produção (init_point). */
  paymentUrl: string;
  /** URL de pagamento no sandbox (sandbox_init_point). */
  sandboxUrl: string | null;
}

/** Status normalizado do pagamento para exibição na UI. */
export type PaymentStatus =
  'pending' | 'in_process' | 'approved' | 'rejected' | 'unknown';

export interface PaymentStatusResult {
  status: PaymentStatus;
  /** Status bruto retornado pelo Mercado Pago (para diagnóstico). */
  rawStatus: string | null;
  /** ID do pagamento no Mercado Pago, quando encontrado. */
  paymentId: string | null;
}

/** Mensagem padrão quando a integração não está configurada. */
export const MP_NOT_CONFIGURED_MESSAGE =
  'Mercado Pago não configurado. Adicione MP_ACCESS_TOKEN nas variáveis de ambiente (Vercel → Settings → Environment Variables) e faça um redeploy. Veja docs/vercel-deploy.md.';

/** Indica se as credenciais do Mercado Pago estão configuradas. */
export function isMercadoPagoConfigured(): boolean {
  return Boolean(process.env.MP_ACCESS_TOKEN);
}

/**
 * Cria um client do SDK autenticado com o Access Token do ambiente.
 * @throws Error quando `MP_ACCESS_TOKEN` não está configurado.
 */
function getClient(): MercadoPagoConfig {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(MP_NOT_CONFIGURED_MESSAGE);
  }
  return new MercadoPagoConfig({ accessToken });
}

/**
 * Normaliza o status bruto do Mercado Pago para um dos valores que a
 * UI conhece.
 */
export function normalizePaymentStatus(
  raw: string | null | undefined
): PaymentStatus {
  switch (raw) {
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

/**
 * Cria uma preferência de pagamento (Checkout Pro) e devolve a URL de
 * pagamento pronta para enviar ao cliente pelo WhatsApp.
 *
 * @throws Error quando `MP_ACCESS_TOKEN` não está configurado ou a API
 * do Mercado Pago retorna erro.
 */
export async function createPaymentLink(
  params: CreatePaymentLinkParams
): Promise<PaymentLinkResult> {
  if (!params.items.length) {
    throw new Error('Informe ao menos um item para gerar o link de pagamento.');
  }

  const client = getClient();
  const preference = new Preference(client);

  // Descrição do recebimento anexada como metadata (informativo).
  const metadata: Record<string, unknown> = {};
  if (params.deliveryKind) metadata.delivery_kind = params.deliveryKind;
  if (params.deliveryAddress)
    metadata.delivery_address = params.deliveryAddress;

  const result = await preference.create({
    body: {
      items: params.items.map((item, index) => ({
        id: String(index + 1),
        title: item.title,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        currency_id: 'BRL',
      })),
      external_reference: params.externalReference,
      payer: params.payerName ? { name: params.payerName } : undefined,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    },
  });

  if (!result.id || !result.init_point) {
    throw new Error('Mercado Pago não retornou um link de pagamento válido.');
  }

  return {
    preferenceId: result.id,
    paymentUrl: result.init_point,
    sandboxUrl: result.sandbox_init_point ?? null,
  };
}

/**
 * Consulta o status de pagamento associado a uma `external_reference`
 * (o ID do pedido). Busca o pagamento mais recente que corresponde à
 * referência.
 *
 * @throws Error quando `MP_ACCESS_TOKEN` não está configurado.
 */
export async function getPaymentStatusByExternalReference(
  externalReference: string
): Promise<PaymentStatusResult> {
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
  }>;

  if (!results.length) {
    return { status: 'pending', rawStatus: null, paymentId: null };
  }

  const latest = results[0];
  return {
    status: normalizePaymentStatus(latest.status),
    rawStatus: latest.status ?? null,
    paymentId: latest.id != null ? String(latest.id) : null,
  };
}
