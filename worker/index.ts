
require('dotenv').config();

import { startScrapeWorker } from './scrape.worker';
import { startImportWorker } from './import.worker';

console.log('=== Yupoo Import Worker ===');
console.log(`SCRAPE_CONCURRENCY: ${process.env.SCRAPE_CONCURRENCY ?? 10}`);
console.log(`IMPORT_CONCURRENCY: ${process.env.IMPORT_CONCURRENCY ?? 15}`);
console.log(`REDIS_URL: ${process.env.REDIS_URL}`);
console.log(`DATABASE_URL: ${process.env.DATABASE_URL?.replace(/:([^@]+)@/, ':***@')}`);
console.log('');

const scrapeWorker = startScrapeWorker();
const importWorker = startImportWorker();

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
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[worker] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled rejection:', reason);
  process.exit(1);
});