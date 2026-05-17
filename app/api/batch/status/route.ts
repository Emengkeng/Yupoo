import { NextRequest, NextResponse } from 'next/server';
import { getJobs, getJobStats } from '@/lib/db';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const [jobs, stats] = await Promise.all([
      getJobs(limit, offset),
      getJobStats(),
    ]);

    // Join with scraped_albums and imported_products for display
    const jobIds = jobs.map((j) => j.id);
    let enriched: any[] = jobs;

    if (jobIds.length > 0) {
      const [albums, products] = await Promise.all([
        db.query(
          `SELECT job_id, translated_name, album_id, store_slug, jsonb_array_length(images) AS image_count
            FROM scraped_albums WHERE job_id = ANY($1)`,
          [jobIds]
        ),
        db.query(
          `SELECT job_id, wc_product_id, wc_product_url, images_uploaded, images_failed
           FROM imported_products WHERE job_id = ANY($1)`,
          [jobIds]
        ),
      ]);

      const albumMap = new Map(albums.rows.map((r: any) => [r.job_id, r]));
      const productMap = new Map(products.rows.map((r: any) => [r.job_id, r]));

      enriched = jobs.map((j) => ({
        ...j,
        album: albumMap.get(j.id) ?? null,
        product: productMap.get(j.id) ?? null,
      }));
    }

    return NextResponse.json({ ok: true, stats, jobs: enriched, total: enriched.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Retry failed jobs
export async function POST(req: NextRequest) {
  try {
    const { jobIds } = await req.json() as { jobIds: number[] };
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return NextResponse.json({ error: 'jobIds required' }, { status: 400 });
    }

    // Reset to pending
    await db.query(
      `UPDATE import_jobs SET status = 'pending', error = NULL WHERE id = ANY($1) AND status = 'failed'`,
      [jobIds]
    );

    // Re-enqueue
    const { getScrapeQueue } = await import('@/lib/queues');
    const jobs = await db.query(
      `SELECT id, url, raw_name, raw_category, raw_price FROM import_jobs WHERE id = ANY($1)`,
      [jobIds]
    );

    const scrapeQueue = getScrapeQueue();
    await scrapeQueue.addBulk(
      jobs.rows.map((j: any) => ({
        name: `scrape:${j.id}`,
        data: {
          jobId: j.id,
          url: j.url,
          rawName: j.raw_name,
          rawCategory: j.raw_category,
          rawPrice: j.raw_price,
        },
      }))
    );

    return NextResponse.json({ ok: true, retried: jobs.rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}