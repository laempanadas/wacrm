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
 *  - Ao criar: usa upsert (onConflict: 'external_reference') quando possível para
 *    evitar duplicação em concorrência.
 *
 * Requisitos:
 *  - Supabase: tabela `orders` com coluna `external_reference` (opcional).
 *  - Tabela `deals`, `tags`, `contact_tags` conforme usado no projeto.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';

export const ORDERS_PIPELINE_NAME = 'Pedidos Delivery';
export const ORDERS_INITIAL_STAGE_NAME = 'Novo Pedido';

export const TAG_CONFIRMADO = 'Confirmado';
export const TAG_AGUARDANDO = 'Aguardando Pagamento';

export type OrderDeliveryKind = 'delivery' | 'retirada';
export type OrderPaymentMethod = 'pix' | 'cartao' | 'dinheiro' | 'mercado_pago';

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
  return method ? PAYMENT_LABELS[method] ?? method : '(não informado)';
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
  const supabase = supabaseClient ?? supabaseAdmin();

  if (!ctx?.accountId) throw new Error('ctx.accountId is required');
  if (!input?.contactId) throw new Error('input.contactId is required');

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
    throw new Error(`Pipeline "${ORDERS_PIPELINE_NAME}" not found for account ${ctx.accountId}`);
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
    throw new Error(`Stage "${ORDERS_INITIAL_STAGE_NAME}" not found in pipeline ${pipeline.id}`);
  }

  // 3) If externalReference provided — try to find existing order to be idempotent
  if (externalReference) {
    try {
      const { data: foundOrders, error: findErr } = await supabase
        .from('orders')
        .select('*')
        .eq('external_reference', externalReference)
        .limit(1);

      if (findErr) throw findErr;

      if (foundOrders && foundOrders.length > 0) {
        const found = foundOrders[0];
        const tagName = selectStatusTagName(Boolean(found.paid_online));
        // ensure tag is applied (idempotent)
        try {
          await applyContactTag(supabase, ctx, input.contactId, tagName);
        } catch (tErr) {
          console.warn('applyContactTag failed while returning existing order', tErr);
        }

        return {
          dealId: found.deal_id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          tagName,
          orderId: found.id,
          orderAlreadyExisted: true,
        };
      }
    } catch (e) {
      console.warn('Failed to lookup existing order by external_reference — continuing to create', e);
    }
  }

  // 4) Create deal (always create new deal here; dedup handled by externalReference above)
  const dealPayload: any = {
    account_id: ctx.accountId,
    user_id: ctx.userId,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
    contact_id: input.contactId,
    conversation_id: input.conversationId ?? null,
    title: buildOrderTitle(input.customerName),
    value: Number.isFinite(input.total) && input.total > 0 ? input.total : 0,
    currency: 'BRL',
    notes: buildOrderNotes({
      deliveryKind: input.deliveryKind,
      paymentMethod: input.paymentMethod,
      deliveryAddress: input.deliveryAddress,
    }),
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

  const dealId = dealInsert?.id;
  if (!dealId) throw new Error('Failed to create deal (no id returned)');

  // 5) Prepare order payload
  const orderPayload: any = {
    account_id: ctx.accountId,
    contact_id: input.contactId,
    deal_id: dealId,
    external_reference: externalReference,
    total_amount: Number.isFinite(input.total) ? input.total : 0,
    paid_online: Boolean(input.paidOnline),
    status: 'pending',
    delivery_kind: input.deliveryKind,
    delivery_address: input.deliveryAddress ?? null,
    payment_method: input.paymentMethod ?? 'mercado_pago',
    created_at: new Date().toISOString(),
  };

  // 6) Upsert or insert order
  let orderRecord: any = null;
  if (externalReference) {
    try {
      const { data: upserted, error: upsertErr } = await supabase
        .from('orders')
        .upsert(orderPayload, { onConflict: 'external_reference' })
        .select('*')
        .maybeSingle();

      if (upsertErr) {
        console.warn('orders upsert error; attempting fetch', upsertErr);
        const { data: fetched, error: fetchedErr } = await supabase
          .from('orders')
          .select('*')
          .eq('external_reference', externalReference)
          .limit(1);
        if (fetchedErr) throw fetchedErr;
        orderRecord = fetched?.[0];
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

  // 7) Apply tag
  const tagName = selectStatusTagName(Boolean(input.paidOnline));
  await applyContactTag(supabase, ctx, input.contactId, tagName);

  return {
    dealId,
    pipelineId: pipeline.id,
    stageId: stage.id,
    tagName,
    orderId: orderRecord?.id,
    orderAlreadyExisted: false,
  };
}

/**
 * Ensures tag existence and associates to contact idempotently.
 */
async function applyContactTag(
  supabase: SupabaseClient,
  ctx: { accountId: string; userId: string },
  contactId: string,
  tagName: string
): Promise<void> {
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
      .maybeSingle();
    if (createErr) throw createErr;
    tagId = created?.id;
  }

  if (!tagId) return;

  const { error: assocErr } = await supabase
    .from('contact_tags')
    .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id' });

  if (assocErr) {
    console.warn('Failed to upsert contact_tags', assocErr);
  }
}