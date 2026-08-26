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

export async function GET() {
  try {
    const { data: configs, error } = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .limit(1);

    if (error || !configs || configs.length === 0) {
      return NextResponse.json(
        { error: 'Configuração do WhatsApp não encontrada no banco.' },
        { status: 404 }
      );
    }

    const config = configs[0];
    const accessToken = decrypt(config.access_token);
    const phoneNumberId = config.phone_number_id;

    // 1. Envia a ativação forçada para a Meta
    const metaResponse = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/whatsapp_commerce_settings`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          is_catalog_visible: true,
          is_cart_enabled: true,
        }),
      }
    );

    const result = await metaResponse.json();

    // 2. Consulta o status retornado pela Meta
    const checkResponse = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/whatsapp_commerce_settings`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const currentSettings = await checkResponse.json();

    return NextResponse.json({
      success: result.success === true,
      metaPostResult: result,
      currentSettingsOnMeta: currentSettings,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
