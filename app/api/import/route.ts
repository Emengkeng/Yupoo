import { NextRequest } from 'next/server';
import { uploadImagesFromYupoo } from '@/lib/uploadthing';
import { getAllCategories, resolveCategoryPath, createWcProduct } from '@/lib/woocommerce';

export const maxDuration = 300; // 5 minutes

export interface ImportRequest {
  album: {
    albumId: string;
    storeSlug: string;
    albumUrl: string;
    selectedImages: string[]; // subset of all scraped images user kept
  };
  product: {
    name: string;
    description: string;
    categoryPath: string[]; // e.g. ["Sneakers", "Nike"]
    sizeType: 'sneaker' | 'tshirt' | 'none';
    sneakerSizeRange: string; // e.g. "36-46"
    tshirtSizes: string[]; // e.g. ["S","M","L"]
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
        // ── 1. Validate input ──────────────────────────────────────
        if (!product.name.trim()) throw new Error('Product name is required');
        if (!album.selectedImages.length) throw new Error('No images selected');

        log(`Starting import for: ${product.name}`);
        log(`${album.selectedImages.length} images to upload`);

        // ── 2. Upload images to UploadThing ───────────────────────
        log('Uploading images to UploadThing CDN…');
        const referer = `https://${album.storeSlug}.x.yupoo.com`;

        const uploadResults = await uploadImagesFromYupoo(
          album.selectedImages,
          referer,
          (done, total) => {
            log(`Uploaded ${done}/${total} images…`);
          }
        );

        const successfulUploads = uploadResults.filter((r) => r.uploadedUrl);
        const failedUploads = uploadResults.filter((r) => !r.uploadedUrl);

        if (failedUploads.length > 0) {
          log(`${failedUploads.length} image(s) failed to upload and will be skipped.`, 'warn');
          failedUploads.forEach((f) => log(`  ✗ ${f.error}`, 'warn'));
        }

        if (successfulUploads.length === 0) {
          throw new Error('All image uploads failed. Check UploadThing credentials and try again.');
        }

        log(`✓ ${successfulUploads.length} images uploaded to CDN`, 'success');

        // ── 3. Resolve WooCommerce categories ─────────────────────
        let categoryId: number | null = null;
        if (product.categoryPath.length > 0 && product.categoryPath[0]) {
          log('Resolving categories in WooCommerce…');
          const existingCats = await getAllCategories();
          const { id } = await resolveCategoryPath(product.categoryPath, existingCats);
          categoryId = id;
          log(`✓ Category resolved: ${product.categoryPath.join(' › ')}`, 'success');
        }

        // ── 4. Build size attributes ──────────────────────────────
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

        // ── 5. Create WooCommerce product ─────────────────────────
        log('Creating product in WooCommerce…');

        const wcImages = successfulUploads.map((u, i) => ({
          src: u.uploadedUrl!,
          position: i,
        }));

        const payload = {
          name: product.name,
          description: product.description,
          status: 'draft' as const,
          categories: categoryId ? [{ id: categoryId }] : [],
          images: wcImages,
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
          uploadedImages: successfulUploads.length,
          failedImages: failedUploads.length,
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
  // Single value or unrecognised — return as-is
  return raw.trim() ? [raw.trim()] : [];
}
