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
    const targetPhone = searchParams.get('phone');

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

    // 1. Garante a ativação de visibilidade do catálogo
    await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // 2. Se informou um telefone, dispara o catálogo com produto de capa
    let sendResult = null;
    if (targetPhone) {
      const cleanPhone = targetPhone.replace(/\D/g, '');
      
      const sendRes = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'interactive',
            interactive: {
              type: 'catalog_message',
              body: {
                text: '🥟 Bem-vindo à La Empanadas!\n\nToque no botão abaixo para abrir nosso cardápio completo e fazer seu pedido:',
              },
              action: {
                name: 'catalog_message',
                parameters: {
                  thumbnail_product_retailer_id: 'emp_Atum', // ID real do seu catálogo
                },
              },
              footer: {
                text: 'La Empanadas Delivery',
              },
            },
          }),
        }
      );
      sendResult = await sendRes.json();
    }

    return NextResponse.json({
      success: true,
      message: targetPhone
        ? `Disparo executado para ${targetPhone}`
        : 'Catálogo sincronizado na Meta com sucesso.',
      sendResult,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
