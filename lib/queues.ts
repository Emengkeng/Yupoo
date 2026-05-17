import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

// ── Redis connection ──────────────────────────────────────────────────────
// Re-use a single connection across queues in the same process.

const globalForRedis = globalThis as unknown as { redis?: IORedis };

export function getRedis(): IORedis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = new IORedis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
    });
  }
  return globalForRedis.redis;
}

// ── Job data types ────────────────────────────────────────────────────────

export interface ScrapeJobData {
  jobId: number;       // import_jobs.id
  url: string;
  rawName: string | null;
  rawCategory: string | null;
  rawPrice: string | null;
}

export interface ImportJobData {
  jobId: number;       // import_jobs.id — album already in scraped_albums
  rawPrice: string | null;
}

// ── Queue names ───────────────────────────────────────────────────────────

export const SCRAPE_QUEUE = 'scrape';
export const IMPORT_QUEUE = 'import';

// ── Queue instances (used by Next.js API routes to enqueue) ──────────────

let scrapeQueue: Queue<ScrapeJobData> | null = null;
let importQueue: Queue<ImportJobData> | null = null;

export function getScrapeQueue(): Queue<ScrapeJobData> {
  if (!scrapeQueue) {
    scrapeQueue = new Queue<ScrapeJobData>(SCRAPE_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return scrapeQueue;
}

export function getImportQueue(): Queue<ImportJobData> {
  if (!importQueue) {
    importQueue = new Queue<ImportJobData>(IMPORT_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return importQueue;
}

// ── Queue events (used by API routes for SSE progress streaming) ──────────

export function getScrapeQueueEvents(): QueueEvents {
  return new QueueEvents(SCRAPE_QUEUE, { connection: getRedis() });
}

export function getImportQueueEvents(): QueueEvents {
  return new QueueEvents(IMPORT_QUEUE, { connection: getRedis() });
}