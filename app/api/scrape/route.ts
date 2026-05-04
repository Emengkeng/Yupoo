import { NextRequest, NextResponse } from 'next/server';
import { scrapeAlbum, parseYupooUrl } from '@/lib/scraper';

export const maxDuration = 120; // 2 min timeout (Vercel/Render pro needed for longer)

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing url field' }, { status: 400 });
    }

    const parsed = parseYupooUrl(url);
    if (!parsed) {
      return NextResponse.json(
        {
          error:
            'Invalid Yupoo album URL. Expected formats:\n• https://storename.x.yupoo.com/albums/123456\n• https://x.yupoo.com/photos/storename/albums/123456',
        },
        { status: 400 }
      );
    }

    const album = await scrapeAlbum(url);

    return NextResponse.json({ ok: true, album });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown scraping error';
    console.error('[scrape]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
