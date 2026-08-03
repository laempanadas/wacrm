/**
 * Mercado Pago — geração de link de pagamento.
 *
 * Integração opcional: só funciona quando `MP_ACCESS_TOKEN` está
 * configurado no ambiente (veja docs/mercado-pago-setup.md). Enquanto
 * a credencial não estiver disponível, `isMercadoPagoConfigured()`
 * retorna false e a UI mostra um aviso amigável em vez de quebrar.
 *
 * Usa a API de Preferences do Checkout Pro. Retornamos o
 * `init_point` (URL de pagamento) que pode ser enviado ao cliente
 * pelo WhatsApp.
 */

const MP_API_BASE = 'https://api.mercadopago.com';

export interface PaymentLinkItem {
  /** Descrição do item (ex.: "Combo 12 empanadas"). */
  title: string;
  /** Quantidade. */
  quantity: number;
  /** Preço unitário em reais (BRL). */
  unitPrice: number;
}

export interface CreatePaymentLinkParams {
  /** Itens do pedido. */
  items: PaymentLinkItem[];
  /** Referência externa opcional (ex.: número/ID do pedido). */
  externalReference?: string;
  /** Nome do pagador, apenas para exibição na preferência. */
  payerName?: string;
}

export interface PaymentLinkResult {
  /** ID da preferência criada no Mercado Pago. */
  preferenceId: string;
  /** URL de pagamento em produção (init_point). */
  paymentUrl: string;
  /** URL de pagamento no sandbox (sandbox_init_point). */
  sandboxUrl: string | null;
}

/** Indica se as credenciais do Mercado Pago estão configuradas. */
export function isMercadoPagoConfigured(): boolean {
  return Boolean(process.env.MP_ACCESS_TOKEN);
}

/**
 * Cria uma preferência de pagamento no Mercado Pago e devolve a URL
 * de pagamento pronta para ser enviada ao cliente.
 *
 * @throws Error quando `MP_ACCESS_TOKEN` não está configurado ou a
 * API do Mercado Pago retorna erro.
 */
export async function createPaymentLink(
  params: CreatePaymentLinkParams
): Promise<PaymentLinkResult> {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      'Mercado Pago não configurado. Defina MP_ACCESS_TOKEN no ambiente. Veja docs/mercado-pago-setup.md.'
    );
  }

  if (!params.items.length) {
    throw new Error('Informe ao menos um item para gerar o link de pagamento.');
  }

  const body = {
    items: params.items.map((item, index) => ({
      id: String(index + 1),
      title: item.title,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      currency_id: 'BRL',
    })),
    external_reference: params.externalReference,
    payer: params.payerName ? { name: params.payerName } : undefined,
  };

  const response = await fetch(`${MP_API_BASE}/checkout/preferences`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Falha ao criar link de pagamento no Mercado Pago (HTTP ${response.status}). ${detail}`
    );
  }

  const data = (await response.json()) as {
    id: string;
    init_point: string;
    sandbox_init_point?: string;
  };

  return {
    preferenceId: data.id,
    paymentUrl: data.init_point,
    sandboxUrl: data.sandbox_init_point ?? null,
  };
}
