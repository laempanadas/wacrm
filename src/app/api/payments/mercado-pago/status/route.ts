// ============================================================
// /api/payments/mercado-pago/status
//
//   GET ?externalReference=<id-do-pedido>
//     — consulta o status do pagamento associado à referência externa
//       (o ID do pedido) e devolve um status normalizado para a UI.
//
// Requer sessão autenticada. As credenciais do Mercado Pago ficam no
// ambiente (MP_ACCESS_TOKEN) — nunca no cliente. Veja docs/vercel-deploy.md.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  getPaymentStatusByExternalReference,
  isMercadoPagoConfigured,
  MP_NOT_CONFIGURED_MESSAGE,
} from '@/lib/payments/mercado-pago';

export async function GET(request: Request) {
  try {
    // Garante sessão válida antes de qualquer chamada externa.
    await getCurrentAccount();

    if (!isMercadoPagoConfigured()) {
      return NextResponse.json(
        { error: MP_NOT_CONFIGURED_MESSAGE },
        {
          status: 503,
        }
      );
    }

    const { searchParams } = new URL(request.url);
    const externalReference = searchParams.get('externalReference')?.trim();

    if (!externalReference) {
      return NextResponse.json(
        { error: 'Informe o parâmetro externalReference (ID do pedido).' },
        { status: 400 }
      );
    }

    const result = await getPaymentStatusByExternalReference(externalReference);

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Mercado Pago')) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
