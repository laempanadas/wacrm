/**
 * src/app/api/payments/mercado-pago/webhook/route.ts
 *
 * Webhook handler for Mercado Pago notifications.
 *
 * Requirements:
 *  - MP_ACCESS_TOKEN in env (to query MP API)
 *  - SUPABASE_SERVICE_ROLE_KEY in env (to update DB)
 *  - OPTIONAL: MP_WEBHOOK_TOKEN if you set a secret to validate incoming requests
 *
 * Behavior:
 *  - Parse incoming notification (supports several MP shapes).
 *  - Query MP API to obtain definitive resource (payment / merchant_order / preference).
 *  - Locate order by preference_id or external_reference.
 *  - Insert an audit row into payments table (provider event).
 *  - If payment is approved, update orders.status -> 'paid', set paid_at,
 *    update corresponding deal (move to 'Confirmado'), and apply tag on contact.
 *  - Idempotent: if order already 'paid' we only log and return OK.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN!; // ensure set

// Constants matching your create-order.ts
const ORDERS_PIPELINE_NAME = 'Pedidos Delivery';
const TAG_CONFIRMADO = 'Confirmado';

function supabaseAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// Helper: query Mercado Pago resource given topic and id
async function fetchMercadoPagoResource(topic: string, id: string) {
  const base = 'https://api.mercadopago.com';
  let url = '';
  if (topic === 'payment') {
    url = `${base}/v1/payments/${id}`;
  } else if (topic === 'merchant_order') {
    url = `${base}/merchant_orders/${id}`;
  } else if (topic === 'preference' || topic === 'payment_preferences') {
    url = `${base}/checkout/preferences/${id}`;
  } else {
    // fallback try payments endpoint
    url = `${base}/v1/payments/${id}`;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MP API error ${res.status}: ${body}`);
  }
  return res.json();
}

// Ensure tag exists; return tag id or null
async function ensureTag(admin: any, accountId: string | null, tagName: string) {
  try {
    const { data: existingTag, error: findErr } = await admin
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', tagName)
      .limit(1)
      .maybeSingle();

    if (findErr) {
      console.error('[MP Webhook] Erro buscando tag existente', findErr);
    }
    if (existingTag && (existingTag as any).id) {
      return (existingTag as any).id;
    }

    const { data: createdTag, error: createErr } = await admin
      .from('tags')
      .insert({ account_id: accountId, user_id: null, name: tagName, color: '#22c55e' })
      .select('id')
      .maybeSingle();

    if (createErr) {
      console.error('[MP Webhook] Erro criando tag', createErr);
      return null;
    }
    if (createdTag && (createdTag as any).id) {
      return (createdTag as any).id;
    }
    return null;
  } catch (err) {
    console.error('[MP Webhook] ensureTag error', err);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const admin = supabaseAdmin();

    const payload = await request.json().catch(() => null);
    if (!payload) {
      return NextResponse.json({ ok: false, message: 'payload vazio' }, { status: 400 });
    }

    // Extract topic/id from various MP notification shapes
    let topic: string | null = null;
    let id: string | null = null;

    if (payload.topic) {
      topic = payload.topic;
      id = payload.id || payload.data?.id || null;
    } else if (payload.type) {
      topic = payload.type;
      id = payload.data?.id || null;
    } else if (payload.action && payload.data) {
      topic = String(payload.action).split('.')[0];
      id = payload.data.id || null;
    } else if (payload.data && payload.data.id) {
      topic = 'payment';
      id = payload.data.id;
    }

    if (!topic || !id) {
      console.warn('[MP Webhook] Sem topic/id no payload', { payload });
      return NextResponse.json({ ok: false, message: 'Sem topic/id' }, { status: 400 });
    }

    // Optional token validation (if you configured MP webhook token)
    // const mpTokenHeader = request.headers.get('x-mp-webhook-token');
    // if (process.env.MP_WEBHOOK_TOKEN && mpTokenHeader !== process.env.MP_WEBHOOK_TOKEN) {
    //   console.warn('[MP Webhook] Token inválido');
    //   return NextResponse.json({ ok: false }, { status: 401 });
    // }

    // Fetch resource from MP
    const resource = await fetchMercadoPagoResource(topic, id);

    // Normalize extracted info
    let preferenceId: string | undefined;
    let paymentStatus: string | undefined;
    let paymentId: string | undefined;
    let externalReference: string | undefined;

    if (resource) {
      if (resource.preference_id) preferenceId = resource.preference_id;
      if (resource.status) paymentStatus = resource.status;
      if (resource.id) paymentId = String(resource.id);
      if (resource.external_reference) externalReference = resource.external_reference;
      // merchant_order payments array
      if (!paymentStatus && resource.payments && Array.isArray(resource.payments) && resource.payments.length) {
        const last = resource.payments[resource.payments.length - 1];
        paymentStatus = last.status;
        paymentId = last.id;
        if (!preferenceId && last.preference_id) preferenceId = last.preference_id;
      }
      if (!preferenceId && resource.id && (topic === 'preference' || topic === 'payment_preferences')) {
        preferenceId = String(resource.id);
      }
    }

    // Find order by preference_id or external_reference
    let order: any = null;
    if (preferenceId) {
      const { data: byPref } = await admin.from('orders').select('*').eq('preference_id', preferenceId).limit(1);
      if (byPref && byPref.length) order = byPref[0];
    }
    if (!order && externalReference) {
      const { data: byExt } = await admin.from('orders').select('*').eq('external_reference', externalReference).limit(1);
      if (byExt && byExt.length) order = byExt[0];
    }

    // Insert audit into payments table
    try {
      await admin.from('payments').insert({
        account_id: order?.account_id ?? null,
        order_id: order?.id ?? null,
        deal_id: order?.deal_id ?? null,
        provider: 'mercado_pago',
        provider_payment_id: paymentId ?? id,
        event_type: topic,
        status: paymentStatus ?? null,
        meta: resource,
      });
    } catch (pErr) {
      console.error('[MP Webhook] Erro ao gravar evento payments:', pErr);
    }

    if (!order) {
      console.warn('[MP Webhook] Ordem não encontrada para preference/externalReference', { preferenceId, externalReference });
      return NextResponse.json({ ok: true, message: 'Evento registrado (sem ordem vinculada)' });
    }

    // Idempotency: if already paid, return OK
    if (order.status === 'paid') {
      console.log('[MP Webhook] Ordem já marcada como paga, ignorando ações adicionais', { orderId: order.id });
      return NextResponse.json({ ok: true, message: 'Já pago' });
    }

    const approvedStates = ['approved', 'paid', 'authorized'];
    if (paymentStatus && approvedStates.includes(String(paymentStatus).toLowerCase())) {
      try {
        // update order
        await admin.from('orders').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', order.id);

        // Update deal stage to Confirmado if order.deal_id exists
        if (order.deal_id) {
          try {
            // Find pipeline by account and name
            const { data: pipelines } = await admin
              .from('pipelines')
              .select('id')
              .eq('account_id', order.account_id)
              .eq('name', ORDERS_PIPELINE_NAME)
              .limit(1);
            const pipeline = pipelines && pipelines.length ? pipelines[0] : null;
            if (pipeline && pipeline.id) {
              const { data: stages } = await admin
                .from('pipeline_stages')
                .select('id')
                .eq('pipeline_id', pipeline.id)
                .eq('name', 'Confirmado')
                .limit(1);
              const stage = stages && stages.length ? stages[0] : null;
              if (stage && stage.id) {
                await admin.from('deals').update({ stage_id: stage.id }).eq('id', order.deal_id);
              }
            }
          } catch (stageErr) {
            console.error('[MP Webhook] Erro ao mover deal para Confirmado', stageErr);
          }

          // Apply tag "Confirmado" to contact via ensureTag + upsert contact_tags
          try {
            const tagId = await ensureTag(admin, order.account_id, TAG_CONFIRMADO);
            if (tagId && order.contact_id) {
              try {
                await admin.from('contact_tags').upsert({ contact_id: order.contact_id, tag_id: tagId }, { onConflict: 'contact_id,tag_id' });
              } catch (upErr) {
                console.error('[MP Webhook] Erro ao upsert contact_tags', upErr);
              }
            }
          } catch (tagErr) {
            console.error('[MP Webhook] Erro ao aplicar tag Confirmado', tagErr);
          }
        }

        console.log('[MP Webhook] Ordem marcada como paga e deal atualizado', { orderId: order.id, preferenceId, paymentId });
        return NextResponse.json({ ok: true, message: 'Order updated to paid' });
      } catch (updateErr) {
        console.error('[MP Webhook] Erro ao atualizar order/deal após pagamento', updateErr);
        return NextResponse.json({ ok: false, message: 'Erro interno' }, { status: 500 });
      }
    }

    console.log('[MP Webhook] Evento recebido (não aprovado):', { paymentStatus, preferenceId, paymentId });
    return NextResponse.json({ ok: true, message: 'Evento recebido' });
  } catch (err: any) {
    console.error('[MP Webhook] Erro ao processar webhook', err);
    return NextResponse.json({ ok: false, error: err?.message ?? String(err) }, { status: 500 });
  }
}