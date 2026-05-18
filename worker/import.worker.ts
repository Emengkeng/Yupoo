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

const CONCURRENCY = parseInt(process.env.IMPORT_CONCURRENCY ?? '2', 10);
const IMAGE_UPLOAD_CONCURRENCY = parseInt(process.env.IMAGE_UPLOAD_CONCURRENCY ?? '1', 10);
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
      const imagesToUpload = album.images.slice(1, MAX_IMAGES_PER_PRODUCT + 1);

      // ── 2. Upload images to WordPress concurrently ────────────────────
      const limit = pLimit(IMAGE_UPLOAD_CONCURRENCY);

      // Stagger job starts to avoid synchronized bursts across concurrent jobs
      await new Promise((r) => setTimeout(r, Math.random() * 2000));

      async function uploadWithRetry(
        url: string,
        position: number,
        retries = 3
      ): Promise<{ id: number; position: number } | null> {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const { buffer, contentType, filename } = await fetchImageBuffer(url, referer);
            const mediaId = await uploadImageToWordPress(buffer, contentType, filename);
            return { id: mediaId, position };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const is503 = msg.includes('503');
            if (is503 && attempt < retries) {
              const delay = 1000 * Math.pow(2, attempt);
              console.warn(
                `[import] job ${jobId} | image ${position + 1} | 503, retrying in ${delay}ms (attempt ${attempt}/${retries})`
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

      // ── 3. Resolve categories ─────────────────────────────────────────
      //
      // album.category_paths is an array of paths, e.g.:
      //   [["Men","Sneakers","Nike"], ["Sale","Footwear"]]
      //
      // For each path we walk the WooCommerce category tree, creating nodes
      // that don't exist yet, and collect the leaf node ID.
      // Duplicate leaf IDs are deduplicated before attaching to the product.
      //
      // getAllCategories() is called once up-front; the result is threaded
      // through each resolveCategoryPath call so newly-created categories are
      // visible to subsequent paths without extra DB round-trips.
      const resolvedCategoryIds: number[] = [];

      if (album.category_paths.length > 0) {
        let existingCats: WcCategory[] = await getAllCategories();

        for (const path of album.category_paths) {
          if (path.length === 0) continue;
          try {
            const { id, cats } = await resolveCategoryPath(path, existingCats);
            // Thread updated category list to the next iteration so newly
            // created categories are found locally instead of hitting the API.
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

      // ── 4. Create WooCommerce product ─────────────────────────────────
      const created = await createWcProduct({
        name: album.translated_name || album.raw_title || `Product ${album.album_id}`,
        type: 'simple',
        description: album.description || '',
        status: 'publish',
        // WooCommerce accepts an array — each entry is { id: number }
        categories: resolvedCategoryIds.map((id) => ({ id })),
        images: wpImages,
        attributes: [],
        regular_price: rawPrice || undefined,
        meta_data: [
          { key: '_yupoo_album_id',  value: album.album_id },
          { key: '_yupoo_album_url', value: album.album_url },
          { key: '_yupoo_store',     value: album.store_slug },
          { key: '_import_job_id',   value: String(jobId) },
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