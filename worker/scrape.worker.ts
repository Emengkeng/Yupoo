import { Worker, Job } from 'bullmq';
import { getRedis, getScrapeQueue, getImportQueue, SCRAPE_QUEUE, type ScrapeJobData } from '../lib/queues';
import { updateJobStatus, saveScrapedAlbum } from '../lib/db';
import { scrapeAlbum } from '../lib/scraper';
import { translateTitle, generateDescription } from '../lib/ai';

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY ?? '10', 10);

export function startScrapeWorker() {
  const worker = new Worker<ScrapeJobData>(
    SCRAPE_QUEUE,
    async (job: Job<ScrapeJobData>) => {
      const { jobId, url, rawName, rawCategory, rawPrice } = job.data;

      console.log(`[scrape] job ${jobId} | ${url}`);
      await updateJobStatus(jobId, 'scraping');

      // ── 1. Scrape ─────────────────────────────────────────────────────
      const album = await scrapeAlbum(url);

      // ── 2. Resolve product name ───────────────────────────────────────
      // Priority: user-supplied rawName > scraped title (translated) > fallback
      let productName: string;
      if (rawName?.trim()) {
        productName = rawName.trim();
      } else {
        productName = await translateTitle(album.title || `Product ${album.albumId}`);
      }

      // ── 3. Resolve category path ──────────────────────────────────────
      // Priority: user-supplied rawCategory > scraped category > empty
      let categoryPath: string[] = [];
      if (rawCategory?.trim()) {
        categoryPath = rawCategory
          .split('/')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (album.category) {
        categoryPath = album.category
          .split('/')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      // ── 4. Generate description ───────────────────────────────────────
      const description = await generateDescription(productName, categoryPath);

      // ── 5. Save to DB ─────────────────────────────────────────────────
      await saveScrapedAlbum({
        job_id: jobId,
        album_id: album.albumId,
        store_slug: album.storeSlug,
        album_url: album.albumUrl,
        raw_title: album.title,
        translated_name: productName,
        description,
        category_path: categoryPath,
        images: album.images,
        total_pages: album.totalPages,
      });

      await updateJobStatus(jobId, 'scraped');
      console.log(`[scrape] ✓ job ${jobId} | "${productName}" | ${album.images.length} images`);

      // ── 6. Enqueue import job ─────────────────────────────────────────
      const importQueue = getImportQueue();
      await importQueue.add(`import:${jobId}`, { jobId, rawPrice: rawPrice ?? null }, {
        // Slight delay so scrape worker can move on before import starts
        delay: 500,
      });
    },
    {
      connection: getRedis(),
      concurrency: CONCURRENCY,
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[scrape] ✗ job ${jobId}: ${err.message}`);
    await updateJobStatus(jobId, 'failed', err.message);
  });

  worker.on('error', (err) => {
    console.error('[scrape] Worker error:', err);
  });

  console.log(`[scrape] Worker started | concurrency: ${CONCURRENCY}`);
  return worker;
}