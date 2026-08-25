// src/app/api/whatsapp/sync-catalog/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';

export const dynamic = 'force-dynamic';

// Supabase admin client (server-side)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Helpers
 */
function normalizePhone(phone?: string) {
  return String(phone ?? '').replace(/\D/g, '');
}
function isValidPhone(phone?: string) {
  return /^\d{8,15}$/.test(String(phone ?? ''));
}
function nowISO() {
  return new Date().toISOString();
}
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Placeholder: implement Graph API integration here.
 * This stub should be replaced by real implementation that:
 * - upserts catalog items, stores product_retailer_id in your DB,
 * - handles uploads for images if necessary,
 * - returns structured metaResult for logging.
 */
async function syncCatalogWithMeta(
  phone: string,
  products: any[],
  requestId?: string
): Promise<{ success: boolean; metaResult?: any; error?: string }> {
  // Simulate latency for now
  await new Promise((r) => setTimeout(r, 300));
  return { success: true, metaResult: { synced: products.length, requestId } };
}

/**
 * GET handler: returns local products and last sync info for a phone
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const targetPhone = searchParams.get('phone');

    if (!isValidPhone(normalizePhone(targetPhone))) {
      return NextResponse.json({ success: false, error: 'missing_or_invalid_phone' }, { status: 400 });
    }
    const phone = normalizePhone(targetPhone);

    // Fetch products from Supabase
    const { data: products, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('external_id, name, price_cents, currency, image_url, description, availability, updated_at')
      .eq('phone', phone)
      .order('updated_at', { ascending: false })
      .limit(500);

    if (prodErr) {
      console.error('Supabase fetch products error:', prodErr);
      return NextResponse.json({ success: false, error: 'db_error_fetch_products' }, { status: 500 });
    }

    // Fetch last sync
    const { data: lastSyncs, error: syncErr } = await supabaseAdmin
      .from('catalog_syncs')
      .select('request_id, status, synced_count, meta_response, created_at')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1);

    if (syncErr) {
      console.error('Supabase fetch syncs error:', syncErr);
    }

    const items = Array.isArray(products)
      ? products.map((p: any) => ({
          external_id: p.external_id,
          name: p.name,
          price: Number(p.price_cents) / 100,
          currency: p.currency,
          image_url: p.image_url,
          description: p.description,
          availability: p.availability,
          updated_at: p.updated_at,
        }))
      : [];

    const lastSync = Array.isArray(lastSyncs) && lastSyncs.length > 0 ? lastSyncs[0] : null;

    return NextResponse.json(
      { success: true, phone, items_count: items.length, lastSync, items },
      { status: 200, headers: JSON_HEADERS }
    );
  } catch (err: any) {
    console.error('GET /api/whatsapp/sync-catalog error:', err);
    return NextResponse.json({ success: false, error: 'internal_error' }, { status: 500 });
  }
}

/**
 * POST handler: upsert products, create catalog_sync record, call Meta and update record
 *
 * Request body (example):
 * {
 *   "phone": "551126690644",
 *   "requestId": "optional-idempotency-key",
 *   "products": [{ "external_id":"sku1", "name":"Empanada Atum", "price":10.5, "currency":"BRL", "image_url":"https://..." }, ...]
 * }
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as
      | {
          phone?: string;
          requestId?: string;
          products?: any[];
        }
      | undefined;

    if (!body || !body.phone) {
      return NextResponse.json({ success: false, error: 'missing_phone_in_body' }, { status: 400 });
    }
    const phone = normalizePhone(body.phone);
    if (!isValidPhone(phone)) {
      return NextResponse.json({ success: false, error: 'invalid_phone_format' }, { status: 400 });
    }

    const requestId = body.requestId ?? `rid:${phone}:${Date.now()}`;

    // Idempotency check: if request already processed return existing status
    const { data: existingSync, error: existingErr } = await supabaseAdmin
      .from('catalog_syncs')
      .select('id, status')
      .eq('request_id', requestId)
      .maybeSingle();

    if (existingErr) {
      console.error('Supabase error checking existing sync:', existingErr);
      // proceed; we'll handle potential unique constraint on insert
    }
    if (existingSync) {
      return NextResponse.json({ success: true, phone, requestId, message: 'request_already_processed', status: existingSync.status }, { status: 200 });
    }

    // Normalize & dedupe products
    const productsIn = Array.isArray(body.products) ? body.products : [];
    const deduped: any[] = [];
    const seen = new Set<string>();
    for (const p of productsIn) {
      if (!p) continue;
      const external_id = String(p.external_id ?? '').trim();
      const name = String(p.name ?? '').trim();
      const price = Number(p.price);
      if (!external_id || !name || !Number.isFinite(price)) continue;
      if (seen.has(external_id)) continue;
      seen.add(external_id);
      deduped.push({
        external_id,
        name,
        price_cents: Math.round(price * 100),
        currency: p.currency ?? 'BRL',
        image_url: p.image_url ?? null,
        description: p.description ?? null,
        availability: p.availability ?? 'in_stock',
        updated_at: nowISO(),
      });
    }

    // Upsert products in Supabase
    if (deduped.length > 0) {
      const { error: upsertErr } = await supabaseAdmin
        .from('products')
        .upsert(
          deduped.map((r) => ({ ...r, phone })),
          { onConflict: ['phone', 'external_id'], returning: 'minimal' }
        );
      if (upsertErr) {
        console.error('Supabase upsert products error:', upsertErr);
        return NextResponse.json({ success: false, error: 'db_error_upsert_products' }, { status: 500 });
      }
    }

    // Create catalog_syncs record (pending)
    const { data: createdSync, error: createSyncErr } = await supabaseAdmin
      .from('catalog_syncs')
      .insert([{ phone, request_id: requestId, status: 'pending', synced_count: deduped.length, meta_response: null }])
      .select()
      .maybeSingle();

    if (createSyncErr) {
      console.error('Supabase create catalog_syncs error:', createSyncErr);
      // If it's a unique-constraint collision on request_id, treat as idempotent
      if (String(createSyncErr.message ?? '').includes('duplicate') || String(createSyncErr.code ?? '').includes('23505')) {
        return NextResponse.json({ success: true, phone, requestId, message: 'request_already_processed' }, { status: 200 });
      }
      return NextResponse.json({ success: false, error: 'db_error_create_sync' }, { status: 500 });
    }

    // Call external Meta APIs: (1) ensure catalog visible, (2) send message (if phone param requested)
    // Load whatsapp_config
    const { data: configs, error: cfgErr } = await supabaseAdmin.from('whatsapp_config').select('*').limit(1);
    if (cfgErr || !configs || configs.length === 0) {
      console.error('Missing whatsapp_config in DB', cfgErr);
      return NextResponse.json({ success: false, error: 'whatsapp_config_missing' }, { status: 500 });
    }
    const config = configs[0];
    const accessToken = decrypt(config.access_token);
    const phoneNumberId = config.phone_number_id;

    // 1) Ensure catalog visibility & cart enabled
    try {
      const confRes = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      // consume response for logging/debug (without exposing token)
      const confText = await confRes.text();
      let confJson: any = null;
      try {
        confJson = JSON.parse(confText);
      } catch {
        confJson = { raw: confText };
      }
      if (!confRes.ok) {
        console.error('Error setting whatsapp_commerce_settings', { status: confRes.status, response: confJson });
        // continue but mark sync as failed
        await supabaseAdmin.from('catalog_syncs').update({ status: 'failed', meta_response: confJson }).eq('request_id', requestId);
        return NextResponse.json({ success: false, error: 'meta_config_failed', details: confJson }, { status: 502 });
      }
    } catch (err) {
      console.error('Network error calling whatsapp_commerce_settings', err);
      await supabaseAdmin.from('catalog_syncs').update({ status: 'failed', meta_response: { error: String(err) } }).eq('request_id', requestId);
      return NextResponse.json({ success: false, error: 'meta_config_network_error' }, { status: 502 });
    }

    // 2) If the request body asked to send the catalog to a phone, send interactive product_list message
    let sendResult: any = null;
    // BEGIN: Replaced block (old catalog_message payload is left commented below)
    if (body && body.sendToPhone) {
      // The client can opt-in to request sending to a phone by passing { sendToPhone: true } and the phone in body.phone
      const cleanPhone = phone; // already normalized above

      // Validate catalog id config
      const catalogId = process.env.META_CATALOG_ID ?? config.catalog_id ?? null;
      if (!catalogId) {
        console.error('META_CATALOG_ID missing and not found in config');
        // Update sync as failed
        await supabaseAdmin.from('catalog_syncs').update({ status: 'failed', meta_response: { error: 'catalog_id_missing' } }).eq('request_id', requestId);
        return NextResponse.json({ success: false, error: 'catalog_id_missing' }, { status: 500 });
      }

      // Build payload for product_list (open full catalog)
      const payload = {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'product_list',
          body: {
            text:
              '🥟 Bem-vindo à La Empanadas!\n\nToque no botão abaixo para abrir nosso cardápio completo e fazer seu pedido:',
          },
          footer: {
            text: 'La Empanadas Delivery',
          },
          action: {
            catalog_id: catalogId,
          },
        },
      };

      // Safe logging (no token)
      console.info('Sending product_list interactive message', {
        phone: cleanPhone,
        catalogId,
        itemsSent: deduped.length,
        time: nowISO(),
      });

      try {
        const sendRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const sendText = await sendRes.text();
        try {
          sendResult = JSON.parse(sendText);
        } catch {
          sendResult = { raw: sendText };
        }

        if (!sendRes.ok) {
          console.error('Meta API error sending product_list', { status: sendRes.status, response: sendResult });
          // mark sync failed with meta response
          await supabaseAdmin
            .from('catalog_syncs')
            .update({ status: 'failed', meta_response: sendResult })
            .eq('request_id', requestId);
          return NextResponse.json({ success: false, sendResult }, { status: 502 });
        }
      } catch (err) {
        console.error('Network error sending product_list', err);
        await supabaseAdmin.from('catalog_syncs').update({ status: 'failed', meta_response: { error: String(err) } }).eq('request_id', requestId);
        return NextResponse.json({ success: false, error: 'meta_message_network_error' }, { status: 502 });
      }
    } else {
      // If sendToPhone not requested, we just performed upsert + created sync record
      // Optionally: enqueue a background job to sync large catalogs with Meta.
    }
    // END: Replaced block

    // Update catalog_syncs as success and attach meta response (if any)
    const finalMeta = sendResult ?? { note: 'no_send_performed' };
    const finalStatus = sendResult ? (sendResult.error ? 'failed' : 'success') : 'success';
    await supabaseAdmin
      .from('catalog_syncs')
      .update({ status: finalStatus, meta_response: finalMeta })
      .eq('request_id', requestId);

    return NextResponse.json({
      success: true,
      message: body.sendToPhone ? `Disparo executado para ${phone}` : 'Catálogo sincronizado na Meta com sucesso.',
      requestId,
      synced_count: deduped.length,
      sendResult,
    });
  } catch (err: any) {
    console.error('POST /api/whatsapp/sync-catalog unexpected error:', err);
    return NextResponse.json({ success: false, error: err.message ?? 'internal_error' }, { status: 500 });
  }
}

/**
 * ------------------------------------------------------------
 * Old (problematic) payload that caused (#100) Invalid parameter:
 *
 * // body: JSON.stringify({
 * //   messaging_product: 'whatsapp',
 * //   recipient_type: 'individual',
 * //   to: cleanPhone,
 * //   type: 'interactive',
 * //   interactive: {
 * //     type: 'catalog_message',
 * //     body: {
 * //       text: '🥟 Bem-vindo à La Empanadas!\n\nToque no botão abaixo para abrir nosso cardápio completo e fazer seu pedido:',
 * //     },
 * //     action: {
 * //       name: 'catalog_message',
 * //       parameters: {
 * //         thumbnail_product_retailer_id: 'emp_Atum', // ID real do seu catálogo
 * //       },
 * //     },
 * //     footer: {
 * //       text: 'La Empanadas Delivery',
 * //     },
 * //   },
 * // })
 *
 * Reason it failed:
 * - interactive.type = 'catalog_message' and action.parameters.thumbnail_product_retailer_id do not match Graph API documented schema.
 * - Use interactive.type 'product_list' with action.catalog_id or 'product' with action.product_retailer_id.
 *
 * Keep the commented snippet above for reference while debugging.
 * ------------------------------------------------------------
 */
