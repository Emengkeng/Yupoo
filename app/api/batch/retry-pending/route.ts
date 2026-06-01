import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScrapeQueue } from '@/lib/queues';

export async function POST(_req: NextRequest) {
  try {
    const res = await db.query(
      `SELECT id, url, raw_name, raw_category, raw_price, raw_sizes
       FROM import_jobs
       WHERE status = 'pending'`
    );

    if (res.rows.length === 0) {
      return NextResponse.json({ ok: true, retried: 0 });
    }

    const scrapeQueue = getScrapeQueue();

    await scrapeQueue.addBulk(
      res.rows.map((j: any) => ({
        name: `scrape:${j.id}`,
        data: {
          jobId:       j.id,
          url:         j.url,
          rawName:     j.raw_name,
          rawCategory: j.raw_category,
          rawPrice:    j.raw_price,
          rawSizes:    j.raw_sizes,
        },
      }))
    );

    return NextResponse.json({ ok: true, retried: res.rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}