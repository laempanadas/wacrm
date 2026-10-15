import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  createPaymentLink,
  isMercadoPagoConfigured,
  MP_NOT_CONFIGURED_MESSAGE,
  type PaymentLinkItem,
} from '@/lib/payments/mercado-pago';
import { exactBrlCents } from '@/lib/payments/payment-identity';

let adminClient: SupabaseClient | null = null;
function supabaseAdmin() {
  return (adminClient ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ));
}
export async function GET() {
  try {
    await getCurrentAccount();
    return NextResponse.json({ configured: isMercadoPagoConfigured() });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await getCurrentAccount();
    if (!accountId) throw new Error('Missing authenticated account');
    const body = await request.json().catch(() => null);
    const invalid = () =>
      NextResponse.json(
        { error: 'Invalid payment input; no lines can be discarded.' },
        { status: 400 }
      );
    if (!body || !Array.isArray(body.items) || !body.items.length)
      return invalid();
    const items: PaymentLinkItem[] = [];
    let totalCents = 0;
    for (const item of body.items) {
      if (
        !item ||
        typeof item.title !== 'string' ||
        !item.title.trim() ||
        item.title.length > 250 ||
        typeof item.quantity !== 'number' ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 ||
        typeof item.unitPrice !== 'number' ||
        exactBrlCents(item.unitPrice) === null ||
        (item.id !== undefined &&
          (typeof item.id !== 'string' || !item.id.trim())) ||
        (item.description !== undefined && typeof item.description !== 'string')
      )
        return invalid();
      totalCents += exactBrlCents(item.unitPrice)! * item.quantity;
      items.push({
        title: item.title.trim(),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        ...(item.id !== undefined ? { id: item.id } : {}),
        ...(item.description !== undefined
          ? { description: item.description }
          : {}),
      });
    }
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return invalid();
    for (const key of [
      'externalReference',
      'contactId',
      'dealId',
      'conversationId',
    ]) {
      if (
        body[key] !== undefined &&
        (typeof body[key] !== 'string' ||
          !body[key] ||
          body[key] !== body[key].trim())
      )
        return invalid();
    }
    if (
      body.deliveryKind !== undefined &&
      !['delivery', 'retirada'].includes(body.deliveryKind)
    )
      return invalid();
    const externalReference = body.externalReference ?? `PED-${randomUUID()}`;
    const contactId = body.contactId ?? null;
    const dealId = body.dealId ?? null;
    const db = supabaseAdmin();
    // Every service-role FK is validated BEFORE claiming or remote I/O.
    for (const [table, id] of [
      ['contacts', contactId],
      ['deals', dealId],
      ['conversations', body.conversationId],
    ] as const) {
      if (!id) continue;
      const { data, error } = await db
        .from(table)
        .select('*')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (
        !data ||
        data.account_id !== accountId ||
        (table !== 'contacts' && contactId && data.contact_id !== contactId)
      ) {
        return NextResponse.json(
          { error: 'Linked record not found' },
          { status: 404 }
        );
      }
    }
    // Standalone payments cannot borrow a deal: an ownership lookup does not
    // reserve it against concurrent checkouts or uncertain payment attempts.
    // Reject the capability instead of relying on a check-then-insert race.
    if (dealId) {
      return NextResponse.json(
        { error: 'Standalone payments cannot link an existing deal' },
        { status: 409 }
      );
    }
    const snapshot = {
      account_id: accountId,
      contact_id: contactId,
      deal_id: dealId,
      external_reference: externalReference,
      items,
      total: totalCents / 100,
      total_amount: totalCents / 100,
      delivery_kind: body.deliveryKind ?? 'delivery',
      delivery_address:
        typeof body.deliveryAddress === 'string'
          ? body.deliveryAddress.trim()
          : '',
      payer_phone:
        typeof body.payerPhone === 'string' ? body.payerPhone.trim() : '',
      payer_name:
        typeof body.payerName === 'string' && body.payerName.trim()
          ? body.payerName.trim()
          : 'Cliente',
      payment_method: 'mercado_pago',
      paid_online: false,
    };
    const { data: existing, error: lookupError } = await db
      .from('orders')
      .select('*')
      .eq('account_id', accountId)
      .eq('external_reference', externalReference)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      const same = Object.entries(snapshot).every(([key, value]) => {
        if (key === 'total' || key === 'total_amount')
          return exactBrlCents(existing[key]) === totalCents;
        // JSONB may reorder object keys; line order and duplicates still matter.
        return isDeepStrictEqual(existing[key], value);
      });
      if (
        !same ||
        !existing.id ||
        !existing.preference_id ||
        !existing.payment_url ||
        existing.status !== 'pending'
      ) {
        return NextResponse.json(
          {
            error:
              'Reference already claimed or input changed; reconciliation required',
          },
          { status: 409 }
        );
      }
      return NextResponse.json({
        ok: true,
        paymentUrl: existing.payment_url,
        preferenceId: existing.preference_id,
        orderId: existing.id,
        reused: true,
      });
    }
    if (!isMercadoPagoConfigured())
      return NextResponse.json(
        { error: MP_NOT_CONFIGURED_MESSAGE },
        { status: 503 }
      );
    // Canonical orders' (account_id, external_reference) unique index is an
    // insert-only claim. Never upsert or restart an incomplete/uncertain row.
    // Mark uncertainty before remote I/O; retries cannot duplicate a preference.
    const claim = await db
      .from('orders')
      .insert({ ...snapshot, status: 'checkout_uncertain' })
      .select('id')
      .single();
    if (claim.error?.code === '23505')
      return NextResponse.json(
        { error: 'Reference already claimed; reconciliation required' },
        { status: 409 }
      );
    if (claim.error) throw claim.error;
    if (!claim.data?.id)
      throw new Error('Canonical order claim was not persisted');
    const result = await createPaymentLink({
      items,
      externalReference,
      idempotencyKey: `PAYMENT-${createHash('sha256')
        .update(JSON.stringify([accountId, externalReference]))
        .digest('hex')}`,
      payerName: snapshot.payer_name,
      payerPhone: snapshot.payer_phone,
      deliveryKind: snapshot.delivery_kind,
      deliveryAddress: snapshot.delivery_address,
    });
    if (!result.ok || !result.preferenceId || !result.paymentUrl)
      throw new Error('Incomplete gateway preference');
    const saved = await db
      .from('orders')
      .update({
        preference_id: result.preferenceId,
        payment_url: result.paymentUrl,
        status: 'pending',
      })
      .eq('account_id', accountId)
      .eq('external_reference', externalReference)
      .eq('id', claim.data.id)
      .eq('status', 'checkout_uncertain')
      .select('id')
      .single();
    if (saved.error) throw saved.error;
    if (!saved.data?.id)
      throw new Error(
        'Payment binding was not persisted; reconciliation required'
      );
    return NextResponse.json({
      ...result,
      orderId: saved.data.id,
      reused: false,
    });
  } catch (error) {
    // The durable incomplete claim remains blocking even when handoff fails.
    // Never return a live payment URL after a DB error or missing result row.
    return toErrorResponse(error);
  }
}
