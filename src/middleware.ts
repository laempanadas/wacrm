import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server'; // Correct import for server-side Supabase client

export async function middleware(request: NextRequest) {
  const supabase = await createClient();

  // Protect API v1 routes
  if (request.nextUrl.pathname.startsWith('/api/v1')) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  // Extend session if needed (standard practice for Supabase auth-helpers)
  await supabase.auth.getSession();

  return NextResponse.next();
}
