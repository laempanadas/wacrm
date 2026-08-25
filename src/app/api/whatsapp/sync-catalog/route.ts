import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    // Passe seu telefone na URL: ?phone=5511999999999
    const toPhone = searchParams.get('phone') || '5511999999999'; 

    const { data: configs } = await supabaseAdmin
      .from('whatsapp_config')
      .select('*')
      .limit(1);

    if (!configs || configs.length === 0) {
      return NextResponse.json({ error: 'Configuração não encontrada' }, { status: 404 });
    }

    const config = configs[0];
    const accessToken = decrypt(config.access_token);
    const phoneNumberId = config.phone_number_id;

    // Dispara a mensagem oficial de catálogo da Meta
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'interactive',
        interactive: {
          type: 'catalog_message',
          body: {
            text: '🥟 Bem-vindo à La Empanadas!\n\nClique no botão abaixo para explorar nosso cardápio completo e fazer seu pedido:',
          },
          action: {
            name: 'catalog_message',
          },
          footer: {
            text: 'La Empanadas Delivery',
          },
        },
      }),
    });

    const data = await res.json();

    return NextResponse.json({
      statusSent: res.ok,
      metaResponse: data,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
