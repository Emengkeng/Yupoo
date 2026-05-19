import { Worker, Job } from 'bullmq';
import pLimit from 'p-limit';
import { getRedis, IMPORT_QUEUE, type ImportJobData } from '../lib/queues';
import {
  updateJobStatus,
  getScrapedAlbum,
  saveImportedProduct,
} from '../lib/db';
import {
  uploadImageToWordPress,
  getAllCategories,
  resolveCategoryPath,
  createWcProduct,
  createWcVariation,
  type WcCategory,
} from '../lib/woocommerce';

const CONCURRENCY = parseInt(process.env.IMPORT_CONCURRENCY ?? '2', 10);
const IMAGE_UPLOAD_CONCURRENCY = parseInt(process.env.IMAGE_UPLOAD_CONCURRENCY ?? '1', 10);
const MAX_IMAGES_PER_PRODUCT = parseInt(process.env.MAX_IMAGES_PER_PRODUCT ?? '4', 10);
// Delay in ms between each image upload. Tune upward if 503s persist (e.g. 2000).
const UPLOAD_DELAY_MS = parseInt(process.env.UPLOAD_DELAY_MS ?? '1500', 10);

// ── Size parsing ──────────────────────────────────────────────────────────

/**
 * Parse a raw size string into an array of EU size strings.
 *
 * Handles:
 *   "36-45"       → ["36","37","38","39","40","41","42","43","44","45"]
 *   "36–45"       → same (en-dash)
 *   "36,37,38"    → ["36","37","38"]
 *   "36 37 38"    → ["36","37","38"]
 *   "36.5-40"     → ["36.5","37","37.5","38","38.5","39","39.5","40"]
 *
 * Returns [] if the string is empty or unparseable.
 */
function parseSizes(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Range: "36-45" or "36–45" (with optional .5 half-sizes)
  const rangeMatch = trimmed.match(/^(\d{2}(?:\.\d)?)\s*[-–—]\s*(\d{2}(?:\.\d)?)$/);
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1]);
    const hi = parseFloat(rangeMatch[2]);
    if (!isNaN(lo) && !isNaN(hi) && lo <= hi && hi - lo <= 20) {
      const sizes: string[] = [];
      const step = (rangeMatch[1].includes('.') || rangeMatch[2].includes('.')) ? 0.5 : 1;
      for (let s = lo; s <= hi + 0.001; s += step) {
        const rounded = Math.round(s * 2) / 2;
        sizes.push(rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1));
      }
      return sizes;
    }
  }

  // Comma or space list: "36,37,38" or "36 37 38"
  const tokens = trimmed
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{2}(\.\d)?$/.test(s) && parseFloat(s) >= 34 && parseFloat(s) <= 50);

  return tokens;
}

// ── Image fetch ───────────────────────────────────────────────────────────

async function fetchImageBuffer(
  imageUrl: string,
  referer: string
): Promise<{ buffer: ArrayBuffer; contentType: string; filename: string }> {
  const res = await fetch(imageUrl, {
    headers: {
      Referer: referer,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (contentType === 'image/jpg') contentType = 'image/jpeg';
  if (!contentType.startsWith('image/')) contentType = 'image/jpeg';

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('Empty response');

  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const filename = `yupoo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  return { buffer, contentType, filename };
}

// ── Worker ────────────────────────────────────────────────────────────────

export function startImportWorker() {
  const worker = new Worker<ImportJobData>(
    IMPORT_QUEUE,
    async (job: Job<ImportJobData>) => {
      const { jobId, rawPrice, rawSizes } = job.data;

      console.log(`[import] job ${jobId}`);
      await updateJobStatus(jobId, 'importing');

      // ── 1. Load scraped album ─────────────────────────────────────────
      const album = await getScrapedAlbum(jobId);
      if (!album) throw new Error(`No scraped album found for job ${jobId}`);

      // ── 2. Parse sizes ────────────────────────────────────────────────
      const sizes = rawSizes ? parseSizes(rawSizes) : [];
      const hasVariations = sizes.length > 0;

      if (hasVariations) {
        console.log(`[import] job ${jobId} | sizes: [${sizes.join(', ')}]`);
      }

      const referer = `https://${album.store_slug}.x.yupoo.com`;
      const imagesToUpload = album.images.slice(1, MAX_IMAGES_PER_PRODUCT + 1);

      // ── 3. Upload images to WordPress ─────────────────────────────────
      const limit = pLimit(IMAGE_UPLOAD_CONCURRENCY);

      // Stagger job starts to avoid synchronized bursts across concurrent jobs
      await new Promise((r) => setTimeout(r, Math.random() * 2000));

      async function uploadWithRetry(
        url: string,
        position: number,
        retries = 4
      ): Promise<{ id: number; position: number } | null> {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const { buffer, contentType, filename } = await fetchImageBuffer(url, referer);
            const mediaId = await uploadImageToWordPress(buffer, contentType, filename);

            // Breathe between uploads so the WP host isn't hit back-to-back.
            // Controlled via UPLOAD_DELAY_MS env var (default 1500ms).
            if (UPLOAD_DELAY_MS > 0) {
              await new Promise((r) => setTimeout(r, UPLOAD_DELAY_MS));
            }

            return { id: mediaId, position };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            // Retry on 503s, bare network failures, and connection resets —
            // all of which are transient server-side issues.
            const isRetryable =
              msg.includes('503') ||
              msg.includes('fetch failed') ||
              msg.includes('ECONNRESET') ||
              msg.includes('ETIMEDOUT');

            if (isRetryable && attempt < retries) {
              // Exponential backoff: 2s, 4s, 8s
              const delay = 1000 * Math.pow(2, attempt);
              console.warn(
                `[import] job ${jobId} | image ${position + 1} | retryable error, retrying in ${delay}ms (attempt ${attempt}/${retries}): ${msg}`
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }

            console.warn(`[import] job ${jobId} | image ${position + 1} failed: ${msg}`);
            return null;
          }
        }
        return null;
      }

      const results = await Promise.all(
        imagesToUpload.map((url, position) =>
          limit(() => uploadWithRetry(url, position))
        )
      );

      const wpImages = results
        .filter((r): r is { id: number; position: number } => r !== null)
        .sort((a, b) => a.position - b.position);

      const uploaded = wpImages.length;
      const failed = imagesToUpload.length - uploaded;

      if (wpImages.length === 0) {
        throw new Error('All image uploads failed — aborting product creation');
      }

      console.log(`[import] job ${jobId} | ${uploaded} images uploaded, ${failed} failed`);

      // ── 4. Resolve categories ─────────────────────────────────────────
      const resolvedCategoryIds: number[] = [];

      if (album.category_paths.length > 0) {
        let existingCats: WcCategory[] = await getAllCategories();

        for (const path of album.category_paths) {
          if (path.length === 0) continue;
          try {
            const { id, cats } = await resolveCategoryPath(path, existingCats);
            existingCats = cats;
            if (!resolvedCategoryIds.includes(id)) {
              resolvedCategoryIds.push(id);
            }
          } catch (err) {
            console.warn(
              `[import] job ${jobId} | category resolve failed for [${path.join('/')}]: ` +
              (err instanceof Error ? err.message : String(err))
            );
          }
        }

        console.log(
          `[import] job ${jobId} | resolved ${resolvedCategoryIds.length} ` +
          `categor${resolvedCategoryIds.length === 1 ? 'y' : 'ies'}: ` +
          `[${resolvedCategoryIds.join(', ')}]`
        );
      }

      // ── 5. Build attributes ───────────────────────────────────────────
      const attributes = hasVariations
        ? [{ name: 'Size', visible: true, variation: true, options: sizes }]
        : [];

      // ── 6. Create WooCommerce product ─────────────────────────────────
      const created = await createWcProduct({
        name: album.translated_name || album.raw_title || `Product ${album.album_id}`,
        type: hasVariations ? 'variable' : 'simple',
        description: album.description || '',
        status: 'publish',
        categories: resolvedCategoryIds.map((id) => ({ id })),
        images: wpImages,
        attributes,
        regular_price: hasVariations ? undefined : (rawPrice || undefined),
        meta_data: [
          { key: '_yupoo_album_id',  value: album.album_id },
          { key: '_yupoo_album_url', value: album.album_url },
          { key: '_yupoo_store',     value: album.store_slug },
          { key: '_import_job_id',   value: String(jobId) },
        ],
      });

      console.log(`[import] ✓ job ${jobId} | WC product #${created.id} | "${album.translated_name}" | type: ${hasVariations ? 'variable' : 'simple'}`);

      // ── 7. Create size variations ─────────────────────────────────────
      let variationsCreated = 0;

      if (hasVariations) {
        console.log(`[import] job ${jobId} | creating ${sizes.length} size variations…`);

        for (const size of sizes) {
          try {
            await createWcVariation(created.id, {
              attributes: [{ name: 'Size', option: size }],
              status: 'publish',
              regular_price: rawPrice || undefined,
            });
            variationsCreated++;
          } catch (err) {
            console.warn(
              `[import] job ${jobId} | size ${size} variation failed: ` +
              (err instanceof Error ? err.message : String(err))
            );
          }
        }

        console.log(
          `[import] job ${jobId} | ${variationsCreated}/${sizes.length} size variations created`
        );
      }

      // ── 8. Save result ────────────────────────────────────────────────
      await saveImportedProduct({
        job_id: jobId,
        wc_product_id: created.id,
        wc_product_url: `${process.env.WC_URL}/wp-admin/post.php?post=${created.id}&action=edit`,
        images_uploaded: uploaded,
        images_failed: failed,
        variations_created: variationsCreated,
      });

      await updateJobStatus(jobId, 'done');
    },
    {
      connection: getRedis(),
      concurrency: CONCURRENCY,
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[import] ✗ job ${jobId}: ${err.message}`);
    await updateJobStatus(jobId, 'failed', err.message);
  });

  worker.on('error', (err) => {
    console.error('[import] Worker error:', err);
  });

  console.log(`[import] Worker started | concurrency: ${CONCURRENCY}`);
  return worker;
}