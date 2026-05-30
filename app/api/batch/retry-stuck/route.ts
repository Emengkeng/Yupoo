import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getImportQueue } from '@/lib/queues';

export async function POST(req: NextRequest) {
  try {
    const stuck = await db.query(
      `UPDATE import_jobs
       SET status = 'pending', error = NULL
       WHERE status IN ('scraped', 'importing')
       RETURNING id, raw_price, raw_sizes`
    );

    if (stuck.rows.length === 0) {
      return NextResponse.json({ ok: true, retried: 0 });
    }

    const importQueue = getImportQueue();

    await importQueue.addBulk(
      stuck.rows.map((j: any) => ({
        name: `import:${j.id}`,
        data: {
          jobId: j.id,
          rawPrice: j.raw_price,
          rawSizes: j.raw_sizes,
        },
      }))
    );

    return NextResponse.json({ ok: true, retried: stuck.rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}