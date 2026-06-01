require('dotenv').config();

import { startScrapeWorker } from './scrape.worker';
import { startImportWorker } from './import.worker';
import { db } from '../lib/db';
import { getScrapeQueue, getImportQueue } from '../lib/queues';

console.log('=== Yupoo Import Worker ===');
console.log(`SCRAPE_CONCURRENCY: ${process.env.SCRAPE_CONCURRENCY ?? 10}`);
console.log(`IMPORT_CONCURRENCY: ${process.env.IMPORT_CONCURRENCY ?? 15}`);
console.log(`REDIS_URL: ${process.env.REDIS_URL}`);
console.log(`DATABASE_URL: ${process.env.DATABASE_URL?.replace(/:([^@]+)@/, ':***@')}`);
console.log('');

const scrapeWorker = startScrapeWorker();
const importWorker = startImportWorker();

// ── Startup recovery ──────────────────────────────────────────────────────
// Re-enqueue any jobs that are orphaned in the DB but not in Redis.
// This covers: worker was down when jobs were submitted, Redis was flushed, etc.

async function recoverOrphanedJobs() {
  try {
    // Pending → re-enqueue into scrape queue
    const pending = await db.query(
      `SELECT id, url, raw_name, raw_category, raw_price, raw_sizes
       FROM import_jobs
       WHERE status = 'pending'`
    );

    if (pending.rows.length > 0) {
      const scrapeQueue = getScrapeQueue();
      await scrapeQueue.addBulk(
        pending.rows.map((j: any) => ({
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
      console.log(`[recovery] Re-enqueued ${pending.rows.length} pending job(s) into scrape queue`);
    }

    // scraped/importing → re-enqueue into import queue (mirrors retry-stuck)
    const stuck = await db.query(
      `UPDATE import_jobs
       SET status = 'pending', error = NULL
       WHERE status IN ('scraped', 'importing')
       RETURNING id, raw_price, raw_sizes`
    );

    if (stuck.rows.length > 0) {
      const importQueue = getImportQueue();
      await importQueue.addBulk(
        stuck.rows.map((j: any) => ({
          name: `import:${j.id}`,
          data: {
            jobId:    j.id,
            rawPrice: j.raw_price,
            rawSizes: j.raw_sizes,
          },
        }))
      );
      console.log(`[recovery] Re-enqueued ${stuck.rows.length} stuck scraped/importing job(s) into import queue`);
    }

  } catch (err) {
    // Non-fatal — workers still run, operator can use the UI retry buttons
    console.error('[recovery] Startup recovery failed (non-fatal):', err);
  }
}

recoverOrphanedJobs();

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[worker] ${signal} received — shutting down gracefully`);
  await Promise.all([
    scrapeWorker.close(),
    importWorker.close(),
  ]);
  console.log('[worker] All workers closed.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[worker] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled rejection:', reason);
  process.exit(1);
});