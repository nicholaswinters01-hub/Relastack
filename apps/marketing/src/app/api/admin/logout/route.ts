import { NextResponse } from 'next/server';
import { ADMIN_COOKIE, isSameOrigin, sessionCookieOptions } from '@/lib/admin-auth';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) return new NextResponse('Forbidden', { status: 403 });

  const response = NextResponse.redirect(new URL('/admin/login', request.url), 303);
  response.cookies.set(ADMIN_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });

  return response;
}
