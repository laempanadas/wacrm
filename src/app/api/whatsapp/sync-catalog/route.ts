// src/app/api/whatsapp/sync-catalog/route.ts
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Changes the account's commerce settings on Meta, so only admins
    // may call it — and only against their own account's config.
    const ctx = await requireRole('admin');

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('access_token, phone_number_id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error || !config) {
      return NextResponse.json(
        { error: 'Configuração do WhatsApp não encontrada no banco.' },
        { status: 404 }
      );
    }

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
  } catch (err) {
    return toErrorResponse(err);
  }
}
