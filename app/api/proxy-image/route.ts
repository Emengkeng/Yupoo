import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  const referer = req.nextUrl.searchParams.get('ref');

  if (!url || !url.includes('photo.yupoo.com')) {
    return new NextResponse('Invalid url', { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: {
        Referer: referer || 'https://yupoo.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (!res.ok) return new NextResponse('Fetch failed', { status: 502 });

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = await res.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // cache 24h in browser
      },
    });
  } catch {
    return new NextResponse('Proxy error', { status: 502 });
  }
}