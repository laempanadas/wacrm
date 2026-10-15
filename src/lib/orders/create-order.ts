// src/lib/orders/create-order.ts
/**
 * create-order.ts
 *
 * Implementação idempotente e resistente a race-conditions para criar
 * deals/orders a partir do fluxo de pedidos.
 *
 * Estratégia:
 *  - Usa `external_reference` (preferido) como chave de idempotência.
 *  - Se external_reference não for fornecido, tenta usar conversationId.
 *  - Se external_reference existir: tenta localizar order existente e retorna imediatamente.
 *  - Ao criar: ON CONFLICT(account_id,external_reference) DO NOTHING mantém
 *    o snapshot canônico vencedor; falhas de persistência bloqueiam sucesso.
 *  - Todo novo pedido recebe deal próprio, inclusive chamadas legadas sem chave.
 *
 * Requisitos:
 *  - Supabase: tabela `orders` com coluna `external_reference` (opcional).
 *  - Tabela `deals`, `tags`, `contact_tags` conforme usado no projeto.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import { saveContactOrderFields } from './custom-fields';

export const ORDERS_PIPELINE_NAME = 'Pedidos Delivery';
export const ORDERS_INITIAL_STAGE_NAME = 'Novo Pedido';
export const ORDERS_PAID_STAGE_NAME = 'Pago';

export const TAG_CONFIRMADO = 'Confirmado';
export const TAG_AGUARDANDO = 'Aguardando Pagamento';
export const TAG_HUMANO = 'Precisa de Atendente';

/**
 * Variáveis internas do fluxo (flow_runs.vars) e etapas do Kanban (pipeline_stages)
 * que NUNCA devem ser salvas como tags de contato.
 */
export const FORBIDDEN_CONTACT_TAGS = new Set([
  // Variáveis internas de controle do flow
  'aguardando_tipo',
  'aguardando_nome',
  'aguardando_catalogo',
  'aguardando_catálogo',
  'aguardando_endereco',
  'aguardando_endereço',
  'aguardando_itens',
  'aguardando_telefone',
  'aguardando_pedido',
  'aguardando tipo',
  'aguardando nome',
  'aguardando catalogo',
  'aguardando catálogo',
  'aguardando endereco',
  'aguardando endereço',
  // Etapas de Kanban (pertencem à tabela pipeline_stages, não tags de contato)
  'em_preparo',
  'em preparo',
  'saiu_para_entrega',
  'saiu para entrega',
  'entregue',
  'novo_pedido',
  'novo pedido',
  'na_cozinha',
  'na cozinha',
  'pronto_para_entrega',
  'pronto para entrega',
  'pago',
]);

/**
 * Verifica se a tag informada é uma variável de controle ou etapa de kanban proibida.
 */
export function isForbiddenContactTag(tagName: string): boolean {
  if (!tagName) return false;
  const normalized = tagName.trim().toLowerCase();
  const underscore = normalized.replace(/[\s-]+/g, '_');
  return (
    FORBIDDEN_CONTACT_TAGS.has(normalized) ||
    FORBIDDEN_CONTACT_TAGS.has(underscore)
  );
}

/**
 * Normaliza o nome da tag para a constante oficial ou retorna null se for proibida.
 */
export function normalizeContactTagName(tagName: string): string | null {
  const trimmed = tagName.trim();
  const lower = trimmed.toLowerCase();

  // Redireciona variações de aguardando pagamento para a constante oficial
  if (lower === 'aguardando_pagamento' || lower === 'aguardando pagamento') {
    return TAG_AGUARDANDO;
  }
  if (lower === 'confirmado') {
    return TAG_CONFIRMADO;
  }
  if (
    lower === 'precisa de atendente' ||
    lower === 'precisa_de_atendente' ||
    lower === 'humano'
  ) {
    return TAG_HUMANO;
  }

  if (isForbiddenContactTag(trimmed)) {
    return null;
  }

  return trimmed;
}

export type OrderDeliveryKind = 'delivery' | 'retirada';
export type OrderPaymentMethod =
  'pix' | 'cartao' | 'dinheiro' | 'mercado_pago' | 'na_retirada';

/** Keep legacy text/unpriced lines readable, without synthesizing prices. */
export interface OrderItemSnapshot {
  id?: string;
  title?: string;
  name?: string;
  quantity?: number;
  unitPrice?: number;
  description?: string;
}

export interface CreateOrderInput {
  contactId: string;
  customerName: string;
  deliveryKind: OrderDeliveryKind;
  paymentMethod?: OrderPaymentMethod;
  total: number;
  deliveryAddress?: string;
  paidOnline?: boolean;
  conversationId?: string;
  external_reference?: string | null;
  items?: string | OrderItemSnapshot[];
  observations?: string;
  /**
   * Only create the deal + tag. For callers that write their own `orders`
   * row (the catalog order flow), so the order isn't recorded twice.
   */
  skipOrderRecord?: boolean;
  /** The caller holds a durable checkout claim and owns order persistence.
   * Always insert a dedicated deal; never adopt an open conversation deal. */
  checkoutOwned?: boolean;
}

export interface CreateOrderResult {
  dealId: string;
  pipelineId: string;
  stageId: string;
  tagName: string;
  orderId?: string;
  orderAlreadyExisted?: boolean;
}

const PAYMENT_LABELS: Record<OrderPaymentMethod, string> = {
  pix: 'Pix',
  cartao: 'Cartão (débito/crédito)',
  dinheiro: 'Dinheiro',
  mercado_pago: 'Mercado Pago (link online)',
  na_retirada: 'Na retirada (pagar na loja)',
};

const DELIVERY_LABELS: Record<OrderDeliveryKind, string> = {
  delivery: 'Delivery',
  retirada: 'Retirada no local',
};

export function buildOrderTitle(customerName: string): string {
  const name = (customerName || '').trim() || 'Cliente';
  return `Pedido - ${name}`;
}

export function paymentMethodLabel(method?: OrderPaymentMethod): string {
  return method ? (PAYMENT_LABELS[method] ?? method) : '(não informado)';
}

export function deliveryKindLabel(kind: OrderDeliveryKind): string {
  return DELIVERY_LABELS[kind] ?? kind;
}

export function selectStatusTagName(paidOnline: boolean): string {
  return paidOnline ? TAG_CONFIRMADO : TAG_AGUARDANDO;
}

export function buildOrderNotes(input: {
  deliveryKind: OrderDeliveryKind;
  paymentMethod?: OrderPaymentMethod;
  deliveryAddress?: string;
  items?: CreateOrderInput['items'];
  total?: number;
  observations?: string;
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
  if (typeof input.items === 'string') {
    lines.push('Itens:', input.items);
  } else if (Array.isArray(input.items)) {
    lines.push(
      'Itens:',
      ...input.items.map(
        (item) =>
          `${item.quantity ?? 1}x ${item.title ?? item.name ?? 'Item'}${item.id ? ` [${item.id}]` : ''}${item.unitPrice !== undefined ? ` - R$ ${item.unitPrice.toFixed(2)}` : ''}${item.description ? ` — ${item.description}` : ''}`
      )
    );
  }
  if (input.observations) lines.push(`Observações: ${input.observations}`);
  if (input.total !== undefined)
    lines.push(`Total: R$ ${input.total.toFixed(2)}`);
  return lines.join('\n');
}

/** BRL cents, constrained by deals.value NUMERIC(12,2); never replace bad
 * monetary input with zero or silently round a fractional cent. */
function moneyCents(value: number, label: string): number {
  const cents = Math.round(value * 100);
  const floatNoise = Number.EPSILON * Math.max(1, Math.abs(value * 100)) * 4;
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 9_999_999_999.99 ||
    !Number.isSafeInteger(cents) ||
    Math.abs(value * 100 - cents) > floatNoise
  ) {
    throw new Error(`Invalid order ${label}`);
  }
  return cents;
}

function validateOrderAmounts(input: CreateOrderInput): void {
  const totalCents = moneyCents(input.total, 'total');
  if (!Array.isArray(input.items)) return;
  let sum = 0;
  let fullyPriced = input.items.length > 0;
  for (const item of input.items) {
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      throw new Error('Invalid order item quantity');
    if (item.unitPrice === undefined) {
      fullyPriced = false;
      continue;
    }
    sum += moneyCents(item.unitPrice, 'item price') * quantity;
    if (!Number.isSafeInteger(sum)) throw new Error('Invalid order item total');
  }
  // Legacy unpriced lines/text keep their supplied total; no guessed pricing.
  if (fullyPriced && sum !== totalCents)
    throw new Error('Order total does not match items');
}

// Supabase admin singleton (service role)
let _adminClient: SupabaseClient | null = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient!;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertCanonicalIdentity(
  order: Record<string, unknown> | null,
  ctx: { accountId: string },
  contactId: string
): asserts order is Record<string, unknown> & {
  id: string;
  contact_id: string;
} {
  if (
    !order ||
    !validId(order.id) ||
    order.account_id !== ctx.accountId ||
    order.contact_id !== contactId
  )
    throw new Error('Canonical order identity does not match account/contact');
}

async function canonicalOrderResult(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  order: Record<string, unknown> | null,
  contactId: string
): Promise<CreateOrderResult> {
  assertCanonicalIdentity(order, ctx, contactId);
  if (!validId(order.deal_id))
    throw new Error('Canonical order has no deal id');
  const { data: deal, error } = await supabase
    .from('deals')
    .select('id, account_id, contact_id, pipeline_id, stage_id')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', contactId)
    .eq('id', order.deal_id)
    .maybeSingle();
  if (error) throw error;
  if (
    !deal ||
    deal.id !== order.deal_id ||
    deal.account_id !== ctx.accountId ||
    deal.contact_id !== contactId ||
    !validId(deal.pipeline_id) ||
    !validId(deal.stage_id)
  )
    throw new Error('Canonical order deal identity was not persisted');
  const tagName = selectStatusTagName(Boolean(order.paid_online));
  await applyContactTag(supabase, ctx, contactId, tagName);
  return {
    dealId: order.deal_id,
    pipelineId: deal.pipeline_id,
    stageId: deal.stage_id,
    tagName,
    orderId: order.id,
    orderAlreadyExisted: true,
  };
}

/**
 * Cria o deal + order de maneira idempotente quando possível.
 *
 * Observações:
 * - Se external_reference for fornecido, a função tentará reutilizar o pedido
 *   existente e retornar sem criar novos registros.
 * - Se external_reference não for fornecido, a função cria um novo deal+order.
 */
export async function createOrderDeal(
  supabaseClient: SupabaseClient | null,
  ctx: { accountId: string; userId: string },
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  // Freeze caller data before the first await: notes and rows share a snapshot.
  input = structuredClone(input);
  if (!ctx?.accountId) throw new Error('ctx.accountId is required');
  if (!input?.contactId) throw new Error('input.contactId is required');
  if (input.checkoutOwned && !input.skipOrderRecord)
    throw new Error(
      'Checkout-owned deals require caller-owned order persistence'
    );
  validateOrderAmounts(input);
  const supabase = supabaseClient ?? supabaseAdmin();

  // Normalize idempotency key
  const extRefRaw = (input.external_reference ?? input.conversationId) || null;
  const externalReference = extRefRaw ? String(extRefRaw).trim() : null;

  // 1) Resolve pipeline
  const { data: pipeline, error: pipelineErr } = await supabase
    .from('pipelines')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', ORDERS_PIPELINE_NAME)
    .maybeSingle();
  if (pipelineErr) throw pipelineErr;
  if (!pipeline) {
    throw new Error(
      `Pipeline "${ORDERS_PIPELINE_NAME}" not found for account ${ctx.accountId}`
    );
  }

  // 2) Resolve initial stage
  const { data: stage, error: stageErr } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .eq('name', ORDERS_INITIAL_STAGE_NAME)
    .maybeSingle();
  if (stageErr) throw stageErr;
  if (!stage) {
    throw new Error(
      `Stage "${ORDERS_INITIAL_STAGE_NAME}" not found in pipeline ${pipeline.id}`
    );
  }

  // 3) If externalReference provided — try to find existing order to be idempotent
  if (externalReference && !input.skipOrderRecord) {
    try {
      const { data: foundOrders, error: findErr } = await supabase
        .from('orders')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('external_reference', externalReference)
        .limit(1);

      if (findErr) throw findErr;

      if (foundOrders && foundOrders.length > 0) {
        const found = foundOrders[0];
        return canonicalOrderResult(supabase, ctx, found, input.contactId);
      }
    } catch (e) {
      // An unavailable lookup is not evidence that the canonical order is absent.
      throw e;
    }
  }

  // 4) Every new order gets a dedicated deal, including legacy/no-reference
  // callers. Never look up/reuse an open conversation deal: ledger ownership
  // may not yet be linked, and a lookup cannot atomically prove it is unowned.
  // Tradeoff: webhook-created zero-value auto-deals remain separate. Idempotent
  // reuse is permitted only via a persisted canonical order, above.
  let dealId: string | null = null;

  if (!dealId) {
    const dealPayload: Record<string, unknown> = {
      account_id: ctx.accountId,
      user_id: ctx.userId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: input.contactId,
      conversation_id: input.conversationId ?? null,
      title: buildOrderTitle(input.customerName),
      value: input.total,
      currency: 'BRL',
      notes: buildOrderNotes(input),
      status: 'open',
    };

    const { data: dealInsert, error: dealErr } = await supabase
      .from('deals')
      .insert(dealPayload)
      .select('id')
      .maybeSingle();

    if (dealErr) {
      console.error('create deal error', dealErr);
      throw dealErr;
    }

    dealId = dealInsert?.id;
  }

  if (!dealId) throw new Error('Failed to create deal (no id returned)');

  if (input.skipOrderRecord) {
    const tagName = selectStatusTagName(Boolean(input.paidOnline));
    await applyContactTag(supabase, ctx, input.contactId, tagName);
    return { dealId, pipelineId: pipeline.id, stageId: stage.id, tagName };
  }

  // 5) Prepare order payload
  const orderPayload: Record<string, unknown> = {
    account_id: ctx.accountId,
    contact_id: input.contactId,
    deal_id: dealId,
    external_reference: externalReference,
    total: input.total,
    items: input.items ?? null,
    total_amount: input.total,
    paid_online: Boolean(input.paidOnline),
    status: 'pending',
    delivery_kind: input.deliveryKind,
    delivery_address: input.deliveryAddress ?? null,
    payment_method: input.paymentMethod ?? 'mercado_pago',
    created_at: new Date().toISOString(),
  };

  // 6) Upsert or insert order
  let orderRecord: Record<string, unknown> | null = null;
  let orderAlreadyExisted = false;
  if (externalReference) {
    try {
      const { data: upserted, error: upsertErr } = await supabase
        .from('orders')
        .upsert(orderPayload, {
          onConflict: 'account_id,external_reference',
          ignoreDuplicates: true,
        })
        .select('*')
        .maybeSingle();

      if (upsertErr && upsertErr.code !== '23505') throw upsertErr;
      if (upsertErr || !upserted) {
        // DO NOTHING keeps the first canonical snapshot immutable. Read the
        // winning row only within the same account; never fabricate success.
        const { data: fetched, error: fetchedErr } = await supabase
          .from('orders')
          .select('*')
          .eq('account_id', ctx.accountId)
          .eq('external_reference', externalReference)
          .limit(1);
        if (fetchedErr) throw fetchedErr;
        orderRecord = fetched?.[0];
        orderAlreadyExisted = Boolean(orderRecord);
      } else {
        orderRecord = upserted;
      }
    } catch (e) {
      console.error('Failed to upsert/fetch order by external_reference', e);
      throw e;
    }
  } else {
    // no idempotency key — create a fresh order (caller should prefer to send external_reference)
    const { data: inserted, error: insertErr } = await supabase
      .from('orders')
      .insert(orderPayload)
      .select('*')
      .maybeSingle();
    if (insertErr) {
      console.error('Failed to insert order', insertErr);
      throw insertErr;
    }
    orderRecord = inserted;
  }

  if (!orderRecord?.id) throw new Error('Canonical order was not persisted');
  assertCanonicalIdentity(orderRecord, ctx, input.contactId);

  if (orderAlreadyExisted) {
    return canonicalOrderResult(supabase, ctx, orderRecord, input.contactId);
  }
  if (orderRecord.deal_id !== dealId)
    throw new Error(
      'Canonical order deal identity does not match inserted deal'
    );

  // 7) Apply tag
  const tagName = selectStatusTagName(Boolean(input.paidOnline));
  await applyContactTag(supabase, ctx, input.contactId, tagName);

  // 8) Salva campos personalizados padronizados do contato (delivery CRM)
  if (input.contactId && ctx.accountId) {
    try {
      await saveContactOrderFields(supabase, ctx.accountId, input.contactId, {
        enderecoCompleto: input.deliveryAddress,
        formaPagamento: input.paymentMethod
          ? paymentMethodLabel(input.paymentMethod)
          : undefined,
        itensUltimoPedido:
          typeof input.items === 'string'
            ? input.items
            : Array.isArray(input.items)
              ? input.items
                  .map(
                    (it) =>
                      `${it.quantity ?? 1}x ${it.title ?? it.name ?? 'Item'}`
                  )
                  .join(', ')
              : undefined,
      });
    } catch (cfErr) {
      console.warn(
        '[createOrderDeal] Falha não bloqueante ao salvar campos customizados:',
        cfErr
      );
    }
  }

  return {
    dealId,
    pipelineId: pipeline.id,
    stageId: stage.id,
    tagName,
    orderId: orderRecord?.id as string | undefined,
    orderAlreadyExisted: false,
  };
}

/**
 * Card for an order that was already written to `orders` (site and
 * AI-agent orders in the WhatsApp webhook). Creates the deal + tag and
 * links it via orders.deal_id, so the Mercado Pago webhook and the
 * "Marcar como Pago" button can move it to "Pago". Best-effort: returns
 * null and logs instead of throwing, so the payment message still goes
 * out when the pipeline isn't set up.
 */
export async function createDealForOrder(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  orderId: string | null,
  input: Omit<CreateOrderInput, 'skipOrderRecord'>
): Promise<CreateOrderResult | null> {
  try {
    if (!ctx?.accountId || !input?.contactId)
      throw new Error('Account/contact required');
    if (orderId !== null) {
      if (!validId(orderId)) throw new Error('Canonical order id required');
      // Preflight BEFORE deal/tag effects, even with an admin DB client.
      const { data: order, error } = await supabase
        .from('orders')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('id', orderId)
        .maybeSingle();
      if (error) throw error;
      assertCanonicalIdentity(order, ctx, input.contactId);
      if (order.deal_id !== null)
        return await canonicalOrderResult(
          supabase,
          ctx,
          order,
          input.contactId
        );
    }
    const result = await createOrderDeal(supabase, ctx, {
      ...input,
      skipOrderRecord: true,
    });
    if (orderId) {
      const { data: linked, error } = await supabase
        .from('orders')
        .update({ deal_id: result.dealId })
        .eq('account_id', ctx.accountId)
        .eq('id', orderId)
        .eq('contact_id', input.contactId)
        .is('deal_id', null)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!linked) {
        // CAS lost: never replace the winner's deal with this provisional deal.
        const { data: winner, error: readError } = await supabase
          .from('orders')
          .select('*')
          .eq('account_id', ctx.accountId)
          .eq('id', orderId)
          .maybeSingle();
        if (readError) throw readError;
        if (!winner?.deal_id)
          throw new Error('Order deal linkage was not persisted');
        return await canonicalOrderResult(
          supabase,
          ctx,
          winner,
          input.contactId
        );
      }
      assertCanonicalIdentity(linked, ctx, input.contactId);
      if (linked.id !== orderId || linked.deal_id !== result.dealId)
        throw new Error('Order deal linkage was not persisted');
      return { ...result, orderId };
    }
    return result;
  } catch (err) {
    console.error('[createDealForOrder] could not create deal:', err);
    return null;
  }
}

/**
 * Payment approved: tag the contact "Confirmado" and drop "Aguardando
 * Pagamento" so the two never show together.
 */
export async function markContactPaymentConfirmed(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  contactId: string
): Promise<void> {
  await applyContactTag(supabase, ctx, contactId, TAG_CONFIRMADO);

  // Remove a tag oficial TAG_AGUARDANDO
  const { data: waiting } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', TAG_AGUARDANDO)
    .maybeSingle();
  if (waiting?.id) {
    const { error } = await supabase
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag_id', waiting.id);
    if (error) {
      console.warn('Failed to remove waiting-payment tag', error);
    }
  }

  // Remove também a tag legada 'aguardando_pagamento' se ainda existir
  const { data: legacyWaiting } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', 'aguardando_pagamento')
    .maybeSingle();
  if (legacyWaiting?.id) {
    const { error } = await supabase
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag_id', legacyWaiting.id);
    if (error) {
      console.warn('Failed to remove legacy waiting-payment tag', error);
    }
  }
}

/**
 * Ensures tag existence and associates to contact idempotently.
 * Enforces hygiene: normalizes TAG_AGUARDANDO, TAG_CONFIRMADO, TAG_HUMANO
 * and blocks internal flow vars and kanban stages.
 */
export async function applyContactTag(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  contactId: string,
  tagName: string
): Promise<void> {
  const targetTagName = normalizeContactTagName(tagName);
  if (!targetTagName) {
    console.warn(
      `[applyContactTag] Ignorando tag de controle interno ou etapa de kanban: "${tagName}"`
    );
    return;
  }

  const { data: existing } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', targetTagName)
    .maybeSingle();

  let tagId = existing?.id as string | undefined;

  if (!tagId) {
    const color =
      targetTagName === TAG_CONFIRMADO
        ? '#22c55e'
        : targetTagName === TAG_HUMANO
          ? '#ef4444'
          : '#f59e0b';
    const { data: created, error: createErr } = await supabase
      .from('tags')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        name: targetTagName,
        color,
      })
      .select('id')
      .maybeSingle();
    if (createErr) throw createErr;
    tagId = created?.id;
  }

  if (!tagId) return;

  const { error: assocErr } = await supabase
    .from('contact_tags')
    .upsert(
      { contact_id: contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id' }
    );

  if (assocErr) {
    console.warn('Failed to upsert contact_tags', assocErr);
  }
}
