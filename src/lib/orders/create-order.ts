/**
 * Criação automática de pedido no pipeline "Pedidos Delivery".
 *
 * Ao final do fluxo de pedidos (veja `src/lib/flows/pedido-empanadas-flow.ts`),
 * o frontend/automação chama `POST /api/orders` com os dados coletados na
 * conversa. Este módulo:
 *
 *   1. Resolve o pipeline "Pedidos Delivery" e o estágio "Novo Pedido"
 *      da conta (por nome).
 *   2. Cria a negociação (deal) com título "Pedido - {nome}", valor e
 *      as informações do pedido (tipo, endereço e forma de pagamento)
 *      no campo `notes`.
 *   3. Aplica ao contato a tag de status: "Confirmado" quando o
 *      pagamento já foi feito online (Mercado Pago aprovado) ou
 *      "Aguardando Pagamento" caso contrário — criando a tag se ainda
 *      não existir.
 *
 * As funções puras (`buildOrderTitle`, `buildOrderNotes`,
 * `selectStatusTagName`) ficam separadas do efeito no banco para
 * facilitar os testes unitários.
 *
 * ⚠️ SERVER-SIDE ONLY — usa o client Supabase com a sessão do usuário.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Nome do pipeline usado para os pedidos de delivery/retirada. */
export const ORDERS_PIPELINE_NAME = 'Pedidos Delivery';
/** Estágio inicial onde todo novo pedido entra. */
export const ORDERS_INITIAL_STAGE_NAME = 'Novo Pedido';

/** Tag aplicada quando o pagamento online já foi confirmado. */
export const TAG_CONFIRMADO = 'Confirmado';
/** Tag aplicada quando ainda aguardamos o pagamento. */
export const TAG_AGUARDANDO = 'Aguardando Pagamento';

export type OrderDeliveryKind = 'delivery' | 'retirada';
export type OrderPaymentMethod = 'pix' | 'cartao' | 'dinheiro' | 'mercado_pago';

export interface CreateOrderInput {
  /** Contato dono do pedido (obrigatório — deals.contact_id é NOT NULL). */
  contactId: string;
  /** Nome do cliente (para o título do card). */
  customerName: string;
  /** Tipo de recebimento. */
  deliveryKind: OrderDeliveryKind;
  /** Forma de pagamento escolhida. */
  paymentMethod: OrderPaymentMethod;
  /** Valor total do pedido em reais (BRL). */
  total: number;
  /** Endereço de entrega — obrigatório para delivery. */
  deliveryAddress?: string;
  /**
   * Indica se o pagamento já foi confirmado online (ex.: Mercado Pago
   * aprovado). Define a tag de status aplicada ao contato.
   */
  paidOnline?: boolean;
  /** Conversa de origem, opcional (para vincular o deal). */
  conversationId?: string;
}

export interface CreateOrderResult {
  dealId: string;
  pipelineId: string;
  stageId: string;
  tagName: string;
}

const PAYMENT_LABELS: Record<OrderPaymentMethod, string> = {
  pix: 'Pix',
  cartao: 'Cartão (débito/crédito)',
  dinheiro: 'Dinheiro',
  mercado_pago: 'Mercado Pago (link online)',
};

const DELIVERY_LABELS: Record<OrderDeliveryKind, string> = {
  delivery: 'Delivery',
  retirada: 'Retirada no local',
};

// ============================================================
// Funções puras (testáveis)
// ============================================================

/** Monta o título do card: "Pedido - {nome}". */
export function buildOrderTitle(customerName: string): string {
  const name = customerName.trim() || 'Cliente';
  return `Pedido - ${name}`;
}

/** Rótulo legível para a forma de pagamento. */
export function paymentMethodLabel(method: OrderPaymentMethod): string {
  return PAYMENT_LABELS[method] ?? method;
}

/** Rótulo legível para o tipo de recebimento. */
export function deliveryKindLabel(kind: OrderDeliveryKind): string {
  return DELIVERY_LABELS[kind] ?? kind;
}

/**
 * Escolhe a tag de status do pedido.
 * - Pagamento confirmado online → "Confirmado".
 * - Caso contrário → "Aguardando Pagamento".
 */
export function selectStatusTagName(paidOnline: boolean): string {
  return paidOnline ? TAG_CONFIRMADO : TAG_AGUARDANDO;
}

/**
 * Monta o texto de `notes` do deal com as informações do pedido.
 */
export function buildOrderNotes(input: {
  deliveryKind: OrderDeliveryKind;
  paymentMethod: OrderPaymentMethod;
  deliveryAddress?: string;
}): string {
  const lines = [
    `Tipo: ${deliveryKindLabel(input.deliveryKind)}`,
    `Forma de pagamento: ${paymentMethodLabel(input.paymentMethod)}`,
  ];
  if (input.deliveryKind === 'delivery') {
    lines.push(
      `Endereço: ${input.deliveryAddress?.trim() || '(não informado)'}`
    );
  }
  return lines.join('\n');
}

// ============================================================
// Efeito no banco
// ============================================================

/**
 * Cria a negociação do pedido e aplica a tag de status ao contato.
 *
 * @throws Error quando o pipeline "Pedidos Delivery" / estágio
 *   "Novo Pedido" não existem para a conta.
 */
export async function createOrderDeal(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  // 1. Resolve pipeline por nome (escopo da conta).
  const { data: pipeline, error: pipelineErr } = await supabase
    .from('pipelines')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', ORDERS_PIPELINE_NAME)
    .maybeSingle();

  if (pipelineErr) throw pipelineErr;
  if (!pipeline) {
    throw new Error(
      `Pipeline "${ORDERS_PIPELINE_NAME}" não encontrado. Crie o pipeline antes de registrar pedidos.`
    );
  }

  // 2. Resolve estágio inicial por nome.
  const { data: stage, error: stageErr } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .eq('name', ORDERS_INITIAL_STAGE_NAME)
    .maybeSingle();

  if (stageErr) throw stageErr;
  if (!stage) {
    throw new Error(
      `Estágio "${ORDERS_INITIAL_STAGE_NAME}" não encontrado no pipeline "${ORDERS_PIPELINE_NAME}".`
    );
  }

  // 3. Cria a negociação.
  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: input.contactId,
      conversation_id: input.conversationId ?? null,
      title: buildOrderTitle(input.customerName),
      value: Number.isFinite(input.total) && input.total > 0 ? input.total : 0,
      currency: 'BRL',
      notes: buildOrderNotes(input),
      status: 'open',
    })
    .select('id')
    .single();

  if (dealErr) throw dealErr;

  // 4. Aplica a tag de status ao contato (cria a tag se necessário).
  const tagName = selectStatusTagName(Boolean(input.paidOnline));
  await applyContactTag(supabase, ctx, input.contactId, tagName);

  return {
    dealId: deal.id,
    pipelineId: pipeline.id,
    stageId: stage.id,
    tagName,
  };
}

/**
 * Garante que a tag `tagName` exista para a conta e a associa ao
 * contato (idempotente — não duplica).
 */
async function applyContactTag(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  contactId: string,
  tagName: string
): Promise<void> {
  // Procura a tag existente na conta.
  const { data: existing } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', tagName)
    .maybeSingle();

  let tagId = existing?.id as string | undefined;

  if (!tagId) {
    const color = tagName === TAG_CONFIRMADO ? '#22c55e' : '#f59e0b';
    const { data: created, error: createErr } = await supabase
      .from('tags')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        name: tagName,
        color,
      })
      .select('id')
      .single();
    if (createErr) throw createErr;
    tagId = created.id;
  }

  // Associa a tag ao contato (UNIQUE(contact_id, tag_id) evita duplicação).
  await supabase
    .from('contact_tags')
    .upsert(
      { contact_id: contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id' }
    );
}
