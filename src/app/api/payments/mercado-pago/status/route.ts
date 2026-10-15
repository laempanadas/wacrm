import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  getPaymentStatusForOrder,
  isMercadoPagoConfigured,
  MP_NOT_CONFIGURED_MESSAGE,
} from '@/lib/payments/mercado-pago';

export async function GET(request: Request) {
  try {
    const { accountId } = await getCurrentAccount();
    if (!accountId) throw new Error('Missing authenticated account');
    // orders may be server-only (037); do not weaken RLS to serve this route.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const externalReference = new URL(request.url).searchParams.get(
      'externalReference'
    );
    if (!externalReference || externalReference !== externalReference.trim()) {
      return NextResponse.json(
        { error: 'Informe externalReference exata.' },
        { status: 400 }
      );
    }
    // Account-local uniqueness is not gateway ownership: resolve the durable
    // preference before any gateway query. Never return foreign identifiers.
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, account_id, preference_id, external_reference, total')
      .eq('account_id', accountId)
      .eq('external_reference', externalReference)
      .maybeSingle();
    if (error) throw error;
    if (!order || order.account_id !== accountId) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }
    if (!order.preference_id) {
      return NextResponse.json(
        { error: 'Unlinked legacy order; reconciliation required' },
        { status: 409 }
      );
    }
    // A service-role global read is used ONLY to reject ambiguous bindings;
    // it never selects by foreign reference or returns any foreign identifiers.
    const binding = await supabase
      .from('orders')
      .select('id, account_id')
      .eq('preference_id', order.preference_id)
      .maybeSingle();
    if (binding.error) throw binding.error;
    if (
      !binding.data ||
      binding.data.id !== order.id ||
      binding.data.account_id !== accountId
    ) {
      return NextResponse.json(
        { error: 'Invalid payment binding; reconciliation required' },
        { status: 409 }
      );
    }
    if (!isMercadoPagoConfigured()) {
      return NextResponse.json(
        { error: MP_NOT_CONFIGURED_MESSAGE },
        { status: 503 }
      );
    }
    const result = await getPaymentStatusForOrder(order);
    if (!result.ok)
      return NextResponse.json(
        { error: 'Could not fetch payment' },
        { status: 502 }
      );
    if (result.identityError)
      return NextResponse.json(
        { error: result.identityError },
        { status: 409 }
      );
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
