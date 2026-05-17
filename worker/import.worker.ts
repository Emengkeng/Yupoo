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
  type WcCategory,
} from '../lib/woocommerce';

const CONCURRENCY = parseInt(process.env.IMPORT_CONCURRENCY ?? '15', 10);
// How many images to upload in parallel per product
const IMAGE_UPLOAD_CONCURRENCY = 5;
// Cap images per product — Yupoo albums can have 20+ but we only need a few
const MAX_IMAGES_PER_PRODUCT = parseInt(process.env.MAX_IMAGES_PER_PRODUCT ?? '4', 10);

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

export function startImportWorker() {
  const worker = new Worker<ImportJobData>(
    IMPORT_QUEUE,
    async (job: Job<ImportJobData>) => {
      const { jobId, rawPrice } = job.data;

      console.log(`[import] job ${jobId}`);
      await updateJobStatus(jobId, 'importing');

      // ── 1. Load scraped album ─────────────────────────────────────────
      const album = await getScrapedAlbum(jobId);
      if (!album) throw new Error(`No scraped album found for job ${jobId}`);

      const referer = `https://${album.store_slug}.x.yupoo.com`;

      // Slice to max — scraper stores all images but we only upload the first N
      const imagesToUpload = album.images.slice(0, MAX_IMAGES_PER_PRODUCT);

      // ── 2. Upload images to WordPress concurrently ────────────────────
      const limit = pLimit(IMAGE_UPLOAD_CONCURRENCY);
      let uploaded = 0;
      let failed = 0;

      const wpImages: { id: number; position: number }[] = [];

      await Promise.all(
        imagesToUpload.map((url, position) =>
          limit(async () => {
            try {
              const { buffer, contentType, filename } = await fetchImageBuffer(url, referer);
              const mediaId = await uploadImageToWordPress(buffer, contentType, filename);
              wpImages.push({ id: mediaId, position });
              uploaded++;
            } catch (err) {
              failed++;
              console.warn(
                `[import] job ${jobId} | image ${position + 1} failed: ${err instanceof Error ? err.message : err}`
              );
            }
          })
        )
      );

      // Sort by original position so gallery order is preserved
      wpImages.sort((a, b) => a.position - b.position);

      if (wpImages.length === 0) {
        throw new Error('All image uploads failed — aborting product creation');
      }

      console.log(`[import] job ${jobId} | ${uploaded} images uploaded, ${failed} failed`);

      // ── 3. Resolve categories ─────────────────────────────────────────
      const resolvedCategoryIds: number[] = [];
      if (album.category_path.length > 0) {
        let existingCats: WcCategory[] = await getAllCategories();
        try {
          const { id, cats } = await resolveCategoryPath(album.category_path, existingCats);
          existingCats = cats;
          resolvedCategoryIds.push(id);
        } catch (err) {
          console.warn(
            `[import] job ${jobId} | category resolve failed: ${err instanceof Error ? err.message : err}`
          );
        }
      }

      // ── 4. Create WooCommerce product ─────────────────────────────────
      const created = await createWcProduct({
        name: album.translated_name || album.raw_title || `Product ${album.album_id}`,
        type: 'simple',
        description: album.description || '',
        status: 'publish',
        categories: resolvedCategoryIds.map((id) => ({ id })),
        images: wpImages,
        attributes: [],
        regular_price: rawPrice || undefined,
        meta_data: [
          { key: '_yupoo_album_id', value: album.album_id },
          { key: '_yupoo_album_url', value: album.album_url },
          { key: '_yupoo_store', value: album.store_slug },
          { key: '_import_job_id', value: String(jobId) },
        ],
      });

      console.log(`[import] ✓ job ${jobId} | WC product #${created.id} | "${album.translated_name}"`);

      // ── 5. Save result ────────────────────────────────────────────────
      await saveImportedProduct({
        job_id: jobId,
        wc_product_id: created.id,
        wc_product_url: `${process.env.WC_URL}/wp-admin/post.php?post=${created.id}&action=edit`,
        images_uploaded: uploaded,
        images_failed: failed,
        variations_created: 0,
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