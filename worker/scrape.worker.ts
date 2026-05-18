import { Worker, Job } from 'bullmq';
import { getRedis, getImportQueue, SCRAPE_QUEUE, type ScrapeJobData } from '../lib/queues';
import { updateJobStatus, saveScrapedAlbum } from '../lib/db';
import { scrapeAlbum } from '../lib/scraper';
import { translateTitle, generateDescription } from '../lib/ai';

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY ?? '5', 10);

/**
 * Parse a raw category string into an array of category paths.
 *
 * A single path:   "Men/Sneakers/Nike"         → [["Men","Sneakers","Nike"]]
 * Multiple paths:  "Men/Sneakers/Nike;Sale/Footwear"
 *                                              → [["Men","Sneakers","Nike"],["Sale","Footwear"]]
 *
 * Blank segments and blank paths are dropped.
 */
function parseCategoryPaths(raw: string): string[][] {
  return raw
    .split(';')
    .map((path) =>
      path
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    .filter((path) => path.length > 0);
}

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

      // ── 3. Resolve category paths ─────────────────────────────────────
      // Priority: user-supplied rawCategory > scraped category > empty
      //
      // rawCategory may contain multiple paths separated by ';':
      //   "Men/Sneakers/Nike;Sale/Footwear"
      //
      // The scraped album.category is always a single path string, so we
      // normalise it to the same shape for consistency.
      let categoryPaths: string[][] = [];

      if (rawCategory?.trim()) {
        categoryPaths = parseCategoryPaths(rawCategory.trim());
      } else if (album.category?.trim()) {
        categoryPaths = parseCategoryPaths(album.category.trim());
      }

      // ── 4. Generate description ───────────────────────────────────────
      // Pass the first category path to the description generator (used as
      // context only — the product can still be in multiple WC categories).
      const primaryPath = categoryPaths[0] ?? [];
      const description = await generateDescription(productName, primaryPath);

      // ── 5. Save to DB ─────────────────────────────────────────────────
      await saveScrapedAlbum({
        job_id: jobId,
        album_id: album.albumId,
        store_slug: album.storeSlug,
        album_url: album.albumUrl,
        raw_title: album.title,
        translated_name: productName,
        description,
        category_paths: categoryPaths,   // e.g. [["Men","Sneakers","Nike"],["Sale","Footwear"]]
        images: album.images,
        total_pages: album.totalPages,
      });

      await updateJobStatus(jobId, 'scraped');
      console.log(
        `[scrape] ✓ job ${jobId} | "${productName}" | ${album.images.length} images` +
        (categoryPaths.length > 0
          ? ` | ${categoryPaths.length} categor${categoryPaths.length === 1 ? 'y' : 'ies'}`
          : '')
      );

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