import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildOrderNotes, createOrderDeal } from './create-order';
import {
  matchOpenPayment,
  openPaymentFingerprint,
} from '@/lib/payments/open-payment-identity';
import { exactBrlCents } from '@/lib/payments/payment-identity';
import {
  createPaymentLink,
  isMercadoPagoConfigured,
} from '@/lib/payments/mercado-pago';

export type Item = {
  id?: string;
  title: string;
  quantity: number;
  unitPrice: number;
  description?: string;
};

export interface CreateOrderWithMpInput {
  contactId: string;
  customerName: string;
  deliveryKind: 'delivery' | 'retirada';
  deliveryAddress?: string;
  items: Item[];
  conversationId?: string;
  payerPhone?: string;
  /** Required for text-flow drafts (TEXT-${draft.id}-${version}).
   * Legacy engine callers may omit it only when conversationId is present. */
  externalReference?: string;
  observations?: string;
}

export interface CreateOrderWithMpResult {
  ok: boolean;
  externalReference?: string;
  dealId?: string;
  orderId?: string;
  link_mercado_pago?: string;
  preferenceId?: string;
  error?: string;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error)
    return String(error.message);
  return String(error);
}

/** A unique durable claim precedes any CRM/gateway side effect. Never steal a
 * claim, even after a crash: processing/failed/uncertain require reconciliation.
 * The preference API's idempotency behavior is NOT relied upon. */
export async function createOrderWithMercadoPago(
  ctx: { accountId: string; userId: string },
  input: CreateOrderWithMpInput,
  database?: SupabaseClient
): Promise<CreateOrderWithMpResult> {
  let admin: SupabaseClient | undefined;
  let checkoutId: string | undefined;
  let dealId: string | undefined;
  let orderId: string | undefined;
  let preferenceId: string | undefined;
  let paymentUrl: string | undefined;
  let gatewayStarted = false;
  let externalReference = '';
  try {
    if (!ctx?.accountId || !ctx.userId || !input?.contactId)
      throw new Error('Account, user and contact are required.');
    if (input.deliveryKind !== 'delivery' && input.deliveryKind !== 'retirada')
      throw new Error('Invalid delivery kind.');
    if (
      input.externalReference !== undefined &&
      (typeof input.externalReference !== 'string' ||
        !input.externalReference ||
        input.externalReference !== input.externalReference.trim())
    ) {
      throw new Error(
        'Invalid externalReference; use the exact draft/version reference.'
      );
    }
    if (input.externalReference === undefined && !input.conversationId?.trim())
      throw new Error(
        'Legacy checkout requires conversationId. Text flow must supply externalReference.'
      );
    if (!Array.isArray(input.items) || input.items.length === 0)
      throw new Error('At least one item is required.');
    for (const item of input.items) {
      if (
        !item ||
        typeof item.title !== 'string' ||
        !item.title.trim() ||
        item.title.length > 250 ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 ||
        !Number.isFinite(item.unitPrice) ||
        item.unitPrice <= 0 ||
        !Number.isSafeInteger(
          Math.round((item.unitPrice + Number.EPSILON) * 100)
        ) ||
        Math.round((item.unitPrice + Number.EPSILON) * 100) <= 0 ||
        (item.id !== undefined &&
          (typeof item.id !== 'string' || !item.id.trim())) ||
        (item.description !== undefined && typeof item.description !== 'string')
      ) {
        throw new Error(
          'Invalid checkout item; no lines can be silently discarded.'
        );
      }
    }
    const snapshot = {
      contactId: input.contactId,
      customerName: input.customerName,
      deliveryKind: input.deliveryKind,
      deliveryAddress: input.deliveryAddress ?? '',
      conversationId: input.conversationId ?? '',
      payerPhone: input.payerPhone ?? '',
      observations: input.observations ?? '',
      items: input.items.map((item) => ({
        ...(item.id !== undefined ? { id: item.id } : {}),
        title: item.title,
        quantity: item.quantity,
        unitPrice: Math.round((item.unitPrice + Number.EPSILON) * 100) / 100,
        ...(item.description !== undefined
          ? { description: item.description }
          : {}),
      })),
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex');
    externalReference = input.externalReference ?? `LEGACY-${fingerprint}`;
    const totalCents = snapshot.items.reduce(
      (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
      0
    );
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0)
      throw new Error('Invalid checkout total in cents.');
    const total = totalCents / 100;
    admin =
      database ??
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
    // Service-role bypasses RLS: validate CRM ownership before claims/effects.
    const contact = await admin
      .from('contacts')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('id', input.contactId)
      .maybeSingle();
    if (contact.error) throw contact.error;
    if (!contact.data) throw new Error('Contact does not belong to account.');
    if (input.conversationId) {
      const conversation = await admin
        .from('conversations')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', input.contactId)
        .eq('id', input.conversationId)
        .maybeSingle();
      if (conversation.error) throw conversation.error;
      if (!conversation.data)
        throw new Error('Conversation does not belong to account/contact.');
    }
    const canonical = await admin
      .from('orders')
      .select('*')
      .eq('account_id', ctx.accountId)
      .eq('external_reference', externalReference)
      .maybeSingle();
    if (canonical.error) throw canonical.error;
    const paymentFingerprint = openPaymentFingerprint({
      items: snapshot.items,
      observations: snapshot.observations,
      delivery_kind: snapshot.deliveryKind,
      delivery_address: snapshot.deliveryAddress,
    });
    if (!canonical.data) {
      const open = await admin
        .from('orders')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', input.contactId)
        .or('status.is.null,status.neq.paid');
      if (open.error) throw open.error;
      if (!open.data) throw new Error('Open payment lookup missing.');
      const matched = await matchOpenPayment(
        open.data,
        paymentFingerprint,
        admin,
        ctx.accountId
      );
      if (matched.ambiguous)
        throw new Error('Ambiguous open payment; reconciliation required.');
      const existingOpen = matched.match;
      if (existingOpen) {
        const priorClaim = await admin
          .from('order_checkouts')
          .select('id')
          .eq('account_id', ctx.accountId)
          .eq('external_reference', externalReference)
          .maybeSingle();
        if (priorClaim.error) throw priorClaim.error;
        if (priorClaim.data)
          throw new Error(
            'Checkout reference already reserved; reconciliation required.'
          );
        if (
          existingOpen.status !== 'pending' ||
          !existingOpen.id ||
          !existingOpen.preference_id ||
          !existingOpen.payment_url ||
          !existingOpen.external_reference ||
          exactBrlCents(existingOpen.total) !== totalCents
        )
          throw new Error(
            'Open payment requires reconciliation; no new checkout was started.'
          );
        return {
          ok: true,
          orderId: existingOpen.id,
          dealId: existingOpen.deal_id,
          preferenceId: existingOpen.preference_id,
          link_mercado_pago: existingOpen.payment_url,
          externalReference: existingOpen.external_reference,
        };
      }
    }
    const claim = await admin
      .from('order_checkouts')
      .insert({
        account_id: ctx.accountId,
        external_reference: externalReference,
        input_fingerprint: fingerprint,
        snapshot: { ...snapshot, total },
        status: 'processing',
      })
      .select('*')
      .single();
    if (claim.error) {
      if (claim.error.code !== '23505') throw claim.error;
      const existing = await admin
        .from('order_checkouts')
        .select('*')
        .eq('account_id', ctx.accountId)
        .eq('external_reference', externalReference)
        .single();
      if (existing.error) throw existing.error;
      if (!existing.data || existing.data.input_fingerprint !== fingerprint) {
        throw new Error('Checkout reference conflicts with its frozen input.');
      }
      if (existing.data.status !== 'completed') {
        throw new Error(
          `Checkout ${existing.data.status}; reconcile before starting another operation.`
        );
      }
      if (
        !existing.data.order_id ||
        !existing.data.deal_id ||
        !existing.data.preference_id ||
        !existing.data.payment_url
      ) {
        throw new Error('Completed checkout has an incomplete durable result.');
      }
      if (
        !canonical.data ||
        canonical.data.id !== existing.data.order_id ||
        canonical.data.deal_id !== existing.data.deal_id ||
        canonical.data.contact_id !== input.contactId ||
        canonical.data.preference_id !== existing.data.preference_id ||
        canonical.data.payment_url !== existing.data.payment_url
      ) {
        throw new Error(
          'Completed checkout canonical binding is missing or inconsistent; reconcile.'
        );
      }
      return {
        ok: true,
        dealId: existing.data.deal_id,
        orderId: existing.data.order_id,
        preferenceId: existing.data.preference_id,
        link_mercado_pago: existing.data.payment_url,
      };
    }
    if (!claim.data?.id) throw new Error('Checkout claim was not persisted.');
    checkoutId = claim.data.id;
    const updateCheckout = async (payload: Record<string, unknown>) => {
      const result = await admin!
        .from('order_checkouts')
        .update(payload)
        .eq('account_id', ctx.accountId)
        .eq('external_reference', externalReference)
        .eq('id', checkoutId!)
        .select('id')
        .single();
      if (result.error) throw result.error;
      if (!result.data?.id)
        throw new Error('Checkout update was not persisted.');
    };
    if (!isMercadoPagoConfigured())
      throw new Error('Mercado Pago não configurado.');
    if (canonical.data)
      throw new Error('Canonical reference is already claimed; reconcile.');
    // Share the canonical insert-only exclusion with the standalone payment API.
    // Both writers claim before CRM/gateway work; a preflight read alone races.
    const reservedOrder = await admin
      .from('orders')
      .insert({
        account_id: ctx.accountId,
        contact_id: snapshot.contactId,
        external_reference: externalReference,
        total,
        total_amount: total,
        payment_fingerprint: paymentFingerprint,
        payment_conversation_id: input.conversationId ?? null,
        items: snapshot.items,
        delivery_kind: snapshot.deliveryKind,
        delivery_address: snapshot.deliveryAddress,
        payer_phone: snapshot.payerPhone,
        payer_name: snapshot.customerName,
        payment_method: 'mercado_pago',
        paid_online: false,
        status: 'checkout_uncertain',
      })
      .select('id')
      .single();
    if (reservedOrder.error) throw reservedOrder.error;
    if (!reservedOrder.data?.id)
      throw new Error('Canonical order claim was not persisted.');
    orderId = reservedOrder.data.id;
    const deal = await createOrderDeal(admin, ctx, {
      ...snapshot,
      paymentMethod: 'mercado_pago',
      total,
      paidOnline: false,
      external_reference: externalReference,
      skipOrderRecord: true,
      checkoutOwned: true,
    });
    if (!deal.dealId) throw new Error('Deal was not persisted.');
    dealId = deal.dealId;
    const notes = [
      buildOrderNotes({ ...snapshot, paymentMethod: 'mercado_pago' }),
      'Itens:',
      ...snapshot.items.map(
        (item) =>
          `${item.quantity}x ${item.title}${item.id ? ` [${item.id}]` : ''} - R$ ${item.unitPrice.toFixed(2)}${item.description ? ` — ${item.description}` : ''}`
      ),
      ...(snapshot.observations
        ? [`Observações: ${snapshot.observations}`]
        : []),
    ].join('\n');
    const noteResult = await admin
      .from('deals')
      .update({ notes })
      .eq('account_id', ctx.accountId)
      .eq('id', dealId)
      .select('id')
      .single();
    if (noteResult.error) throw noteResult.error;
    if (!noteResult.data?.id) throw new Error('Deal notes were not persisted.');
    // Write the uncertainty marker BEFORE the remote request. A crash between
    // request and response can never permit an automatic second preference.
    await updateCheckout({ status: 'uncertain', deal_id: dealId });
    gatewayStarted = true;
    const payment = await createPaymentLink({
      items: snapshot.items,
      externalReference,
      idempotencyKey: `CHECKOUT-${createHash('sha256')
        .update(JSON.stringify([ctx.accountId, externalReference]))
        .digest('hex')}`,
      payerName: snapshot.customerName,
      payerPhone: snapshot.payerPhone,
      deliveryKind: snapshot.deliveryKind,
      deliveryAddress: snapshot.deliveryAddress,
    });
    if (!payment.ok || !payment.paymentUrl || !payment.preferenceId)
      throw new Error('Mercado Pago returned an incomplete preference.');
    preferenceId = payment.preferenceId;
    paymentUrl = payment.paymentUrl;
    await updateCheckout({
      preference_id: payment.preferenceId,
      payment_url: payment.paymentUrl,
    });
    const order = await admin
      .from('orders')
      .update({
        account_id: ctx.accountId,
        contact_id: snapshot.contactId,
        deal_id: dealId,
        external_reference: externalReference,
        preference_id: payment.preferenceId,
        payment_url: payment.paymentUrl,
        total,
        total_amount: total,
        items: snapshot.items,
        delivery_kind: snapshot.deliveryKind,
        delivery_address: snapshot.deliveryAddress,
        payer_phone: snapshot.payerPhone,
        payer_name: snapshot.customerName,
        payment_method: 'mercado_pago',
        paid_online: false,
        status: 'pending',
      })
      .eq('account_id', ctx.accountId)
      .eq('external_reference', externalReference)
      .eq('id', orderId)
      .eq('status', 'checkout_uncertain')
      .select('id')
      .single();
    if (order.error) throw order.error;
    if (!order.data?.id) throw new Error('Canonical order was not persisted.');
    orderId = order.data.id;
    await updateCheckout({
      status: 'completed',
      order_id: order.data.id,
      error: null,
    });
    return {
      ok: true,
      dealId,
      orderId: order.data.id,
      preferenceId: payment.preferenceId,
      link_mercado_pago: payment.paymentUrl,
    };
  } catch (error) {
    let failure = message(error);
    if (admin && checkoutId) {
      try {
        const saved = await admin
          .from('order_checkouts')
          .update({
            status: gatewayStarted ? 'uncertain' : 'failed',
            error: failure,
            ...(dealId ? { deal_id: dealId } : {}),
            ...(orderId ? { order_id: orderId } : {}),
            ...(preferenceId ? { preference_id: preferenceId } : {}),
            ...(paymentUrl ? { payment_url: paymentUrl } : {}),
          })
          .eq('account_id', ctx.accountId)
          .eq('external_reference', externalReference)
          .eq('id', checkoutId)
          .select('id')
          .single();
        if (saved.error) throw saved.error;
        if (!saved.data?.id)
          throw new Error('Failure state was not persisted.');
      } catch (persistError) {
        failure += `; durable handoff failed: ${message(persistError)}. Existing claim remains blocked.`;
      }
    }
    return { ok: false, ...(dealId ? { dealId } : {}), error: failure };
  }
}
