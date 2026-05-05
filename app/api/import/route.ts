import { NextRequest } from 'next/server';
import { uploadImagesFromYupoo } from '@/lib/uploadthing';
import {
  getAllCategories,
  resolveCategoryPath,
  createWcProduct,
  uploadImageToWordPress,
} from '@/lib/woocommerce';

export const maxDuration = 300; // 5 minutes

export interface ImportRequest {
  album: {
    albumId: string;
    storeSlug: string;
    albumUrl: string;
    selectedImages: string[];
  };
  product: {
    name: string;
    description: string;
    categoryPath: string[];
    sizeType: 'sneaker' | 'tshirt' | 'none';
    sneakerSizeRange: string;
    tshirtSizes: string[];
  };
}

function send(controller: ReadableStreamDefaultController, event: object) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  controller.enqueue(new TextEncoder().encode(line));
}

export async function POST(req: NextRequest) {
  const body: ImportRequest = await req.json();
  const { album, product } = body;

  const stream = new ReadableStream({
    async start(controller) {
      const log = (message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') => {
        send(controller, { type: 'log', message, level: type });
      };

      try {
        // ── 1. Validate ────────────────────────────────────────────
        if (!product.name.trim()) throw new Error('Product name is required');
        if (!album.selectedImages.length) throw new Error('No images selected');

        log(`Starting import for: ${product.name}`);
        log(`${album.selectedImages.length} images to upload`);

        // ── 2. Fetch images (+ upload to UploadThing for CDN backup) ──
        log('Fetching and uploading images…');
        const referer = `https://${album.storeSlug}.x.yupoo.com`;

        const uploadResults = await uploadImagesFromYupoo(
          album.selectedImages,
          referer,
          (done, total) => {
            log(`Processed ${done}/${total} images…`);
          }
        );

        const successful = uploadResults.filter((r) => r.buffer && r.contentType);
        const failed = uploadResults.filter((r) => !r.buffer);

        if (failed.length > 0) {
          log(`${failed.length} image(s) failed to fetch and will be skipped.`, 'warn');
          failed.forEach((f) => log(`  ✗ ${f.error}`, 'warn'));
        }
        if (successful.length === 0) {
          throw new Error('All image fetches failed. Check network access and try again.');
        }

        const cacheHits = successful.filter((r) => r.fromCache).length;
        if (cacheHits > 0) {
          log(`⚡ ${cacheHits} image(s) reused from session cache (no re-upload)`, 'info');
        }
        log(`✓ ${successful.length} images ready`, 'success');

        // ── 3. Upload each image directly to WordPress Media Library ──
        log('Uploading images to WordPress media library…');
        const wpMediaIds: { id: number; position: number }[] = [];
        let wpFailed = 0;

        for (let i = 0; i < successful.length; i++) {
          const img = successful[i];
          try {
            const mediaId = await uploadImageToWordPress(
              img.buffer!,
              img.contentType!,
              img.filename!
            );
            wpMediaIds.push({ id: mediaId, position: i });
            log(`  ✓ Image ${i + 1}/${successful.length} → WP media #${mediaId}`);
          } catch (err) {
            wpFailed++;
            const msg = err instanceof Error ? err.message : String(err);
            log(`  ✗ Image ${i + 1} failed WP upload: ${msg}`, 'warn');
          }
        }

        if (wpMediaIds.length === 0) {
          throw new Error('All WordPress media uploads failed. Check WP credentials and file permissions.');
        }
        if (wpFailed > 0) {
          log(`${wpFailed} image(s) skipped due to WP upload errors.`, 'warn');
        }
        log(`✓ ${wpMediaIds.length} images in WordPress media library`, 'success');

        // ── 4. Resolve WooCommerce categories ──────────────────────
        let categoryId: number | null = null;
        if (product.categoryPath.length > 0 && product.categoryPath[0]) {
          log('Resolving categories in WooCommerce…');
          const existingCats = await getAllCategories();
          const { id } = await resolveCategoryPath(product.categoryPath, existingCats);
          categoryId = id;
          log(`✓ Category resolved: ${product.categoryPath.join(' › ')}`, 'success');
        }

        // ── 5. Build size attributes ────────────────────────────────
        const attributes = [];

        if (product.sizeType === 'sneaker' && product.sneakerSizeRange) {
          const sizes = expandSneakerRange(product.sneakerSizeRange);
          if (sizes.length > 0) {
            attributes.push({
              name: 'Size',
              visible: true,
              variation: false,
              options: sizes,
            });
          }
        } else if (product.sizeType === 'tshirt' && product.tshirtSizes.length > 0) {
          attributes.push({
            name: 'Size',
            visible: true,
            variation: false,
            options: product.tshirtSizes,
          });
        }

        // ── 6. Create WooCommerce product ───────────────────────────
        log('Creating product in WooCommerce…');

        const payload = {
          name: product.name,
          description: product.description,
          status: 'draft' as const,
          categories: categoryId ? [{ id: categoryId }] : [],
          images: wpMediaIds, // WP attachment IDs — no URL sideloading needed
          attributes,
          meta_data: [
            { key: '_yupoo_album_id', value: album.albumId },
            { key: '_yupoo_album_url', value: album.albumUrl },
            { key: '_yupoo_store', value: album.storeSlug },
          ],
        };

        const created = await createWcProduct(payload);

        log(`✓ Product created as draft! ID: ${created.id}`, 'success');

        send(controller, {
          type: 'done',
          productId: created.id,
          productUrl: `${process.env.WC_URL}/wp-admin/post.php?post=${created.id}&action=edit`,
          uploadedImages: wpMediaIds.length,
          failedImages: failed.length + wpFailed,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log(message, 'error');
        send(controller, { type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function expandSneakerRange(raw: string): string[] {
  const m = raw.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
  if (m) {
    const lo = parseInt(m[1]);
    const hi = parseInt(m[2]);
    if (!isNaN(lo) && !isNaN(hi) && lo <= hi && hi - lo <= 60) {
      return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
    }
  }
  return raw.trim() ? [raw.trim()] : [];
}