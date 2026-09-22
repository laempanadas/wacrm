import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth'; // Assuming getSession is available

export async function middleware(request: NextRequest) {
  // Protect API v1 routes
  if (request.nextUrl.pathname.startsWith('/api/v1')) {
    const session = await getSession();
    if (!session || !session.user) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  // Add protection for Server Actions if needed, though they usually have internal checks
  // For example, by checking request headers for specific Server Action calls
  // if (request.headers.get('x-nextjs-action')) {
  //   const session = await getSession();
  //   if (!session || !session.user) {
  //     return new NextResponse('Unauthorized', { status: 401 });
  //   }
  // }

  return NextResponse.next();
}
