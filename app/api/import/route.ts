import { NextRequest } from 'next/server';
import { uploadImagesFromYupoo } from '@/lib/uploadthing';
import {
  getAllCategories,
  resolveCategoryPath,
  createWcProduct,
  createWcVariation,
  uploadImageToWordPress,
} from '@/lib/woocommerce';

export const maxDuration = 300;

export interface VariationInput {
  value: string;
  imageUrl: string | null; // single representative image URL from album
}

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
    categoryPaths: string[][];
    productType: 'simple' | 'variable';
    variationAttribute: string;
    variations: VariationInput[];
    sizeType: 'sneaker' | 'tshirt' | 'none';
    sneakerSizeRange: string;
    tshirtSizes: string[];
    status: 'draft' | 'publish';
    regularPrice: string;
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
        if (!product.name.trim()) throw new Error('Product name is required');
        if (!album.selectedImages.length) throw new Error('No images selected');

        log(`Starting import for: ${product.name}`);
        log(`Type: ${product.productType} | Status: ${product.status}`);
        log(`${album.selectedImages.length} images to upload`);

        // ── 1. Collect all image URLs to fetch ─────────────────────
        // For variable products, also fetch variation images if not already in selectedImages
        const allImageUrls = [...album.selectedImages];
        if (product.productType === 'variable') {
          for (const v of product.variations) {
            if (v.imageUrl && !allImageUrls.includes(v.imageUrl)) {
              allImageUrls.push(v.imageUrl);
            }
          }
        }

        // ── 2. Fetch + upload to UploadThing ────────────────────────
        log('Fetching images…');
        const referer = `https://${album.storeSlug}.x.yupoo.com`;
        const uploadResults = await uploadImagesFromYupoo(allImageUrls, referer,
          (done, total) => log(`Fetched ${done}/${total} images…`)
        );

        // Build a map from original URL → upload result for easy lookup
        const resultByUrl = new Map(uploadResults.map((r) => [r.originalUrl, r]));

        const successful = uploadResults.filter((r) => r.buffer && r.contentType);
        const failed = uploadResults.filter((r) => !r.buffer);
        if (failed.length > 0) {
          log(`${failed.length} image(s) failed to fetch and will be skipped.`, 'warn');
        }
        if (successful.length === 0) throw new Error('All image fetches failed.');

        const cacheHits = successful.filter((r) => r.fromCache).length;
        if (cacheHits > 0) log(`⚡ ${cacheHits} image(s) reused from cache`, 'info');
        log(`✓ ${successful.length} images ready`, 'success');

        // ── 3. Upload to WordPress Media Library ────────────────────
        log('Uploading to WordPress media library…');
        // Map: originalUrl → WP attachment ID
        const wpIdByUrl = new Map<string, number>();
        let wpFailed = 0;

        for (const img of successful) {
          try {
            const mediaId = await uploadImageToWordPress(img.buffer!, img.contentType!, img.filename!);
            wpIdByUrl.set(img.originalUrl, mediaId);
            log(`  ✓ ${img.filename} → WP #${mediaId}`);
          } catch (err) {
            wpFailed++;
            log(`  ✗ ${img.filename} WP upload failed: ${err instanceof Error ? err.message : err}`, 'warn');
          }
        }

        if (wpIdByUrl.size === 0) throw new Error('All WordPress media uploads failed.');
        if (wpFailed > 0) log(`${wpFailed} image(s) skipped due to WP upload errors.`, 'warn');
        log(`✓ ${wpIdByUrl.size} images in WordPress media library`, 'success');

        // ── 4. Resolve categories ───────────────────────────────────
        const resolvedCategoryIds: number[] = [];
        const validPaths = product.categoryPaths.filter((p) => p.length > 0 && p[0]);
        if (validPaths.length > 0) {
          log(`Resolving ${validPaths.length} category path(s)…`);
          let existingCats = await getAllCategories();
          for (const path of validPaths) {
            try {
              const { id, cats } = await resolveCategoryPath(path, existingCats);
              existingCats = cats;
              resolvedCategoryIds.push(id);
              log(`✓ Category: ${path.join(' › ')}`, 'success');
            } catch (err) {
              log(`⚠ Could not resolve "${path.join(' › ')}": ${err instanceof Error ? err.message : err}`, 'warn');
            }
          }
        }

        // ── 5. Build attributes ─────────────────────────────────────
        const attributes = [];

        if (product.productType === 'variable' && product.variationAttribute && product.variations.length > 0) {
          // The variation attribute — variation: true makes WC treat it as a variation axis
          attributes.push({
            name: product.variationAttribute,
            visible: true,
            variation: true,
            options: product.variations.map((v) => v.value).filter(Boolean),
          });
        } else if (product.sizeType === 'sneaker' && product.sneakerSizeRange) {
          const sizes = expandSneakerRange(product.sneakerSizeRange);
          if (sizes.length > 0) {
            attributes.push({ name: 'Size', visible: true, variation: false, options: sizes });
          }
        } else if (product.sizeType === 'tshirt' && product.tshirtSizes.length > 0) {
          attributes.push({ name: 'Size', visible: true, variation: false, options: product.tshirtSizes });
        }

        // ── 6. Build parent product image list ──────────────────────
        // All successfully uploaded images (from selectedImages) go to the parent gallery
        const parentImages = album.selectedImages
          .map((url, position) => {
            const id = wpIdByUrl.get(url);
            return id ? { id, position } : null;
          })
          .filter((x): x is { id: number; position: number } => x !== null);

        // ── 7. Create parent WooCommerce product ────────────────────
        log(`Creating ${product.productType} product in WooCommerce…`);

        const created = await createWcProduct({
          name: product.name,
          type: product.productType,
          description: product.description,
          status: product.status,
          categories: resolvedCategoryIds.map((id) => ({ id })),
          images: parentImages,
          attributes,
          meta_data: [
            { key: '_yupoo_album_id', value: album.albumId },
            { key: '_yupoo_album_url', value: album.albumUrl },
            { key: '_yupoo_store', value: album.storeSlug },
          ],
          regular_price: product.regularPrice || undefined,
        });

        log(`✓ Parent product created! ID: ${created.id}`, 'success');

        // ── 8. Create variations (variable products only) ───────────
        let variationsCreated = 0;
        if (product.productType === 'variable' && product.variations.length > 0) {
          log(`Creating ${product.variations.length} variation(s)…`);

          for (const v of product.variations) {
            if (!v.value.trim()) continue;
            try {
              const imageId = v.imageUrl ? wpIdByUrl.get(v.imageUrl) : undefined;
              await createWcVariation(created.id, {
                attributes: [{ name: product.variationAttribute, option: v.value }],
                ...(imageId ? { image: { id: imageId } } : {}),
                status: product.status,
              });
              variationsCreated++;
              log(`  ✓ Variation "${v.value}"${imageId ? ` with image #${imageId}` : ''}`, 'success');
            } catch (err) {
              log(`  ✗ Variation "${v.value}" failed: ${err instanceof Error ? err.message : err}`, 'warn');
            }
          }

          log(`✓ ${variationsCreated}/${product.variations.length} variations created`, 'success');
        }

        send(controller, {
          type: 'done',
          productId: created.id,
          productUrl: `${process.env.WC_URL}/wp-admin/post.php?post=${created.id}&action=edit`,
          uploadedImages: parentImages.length,
          failedImages: failed.length + wpFailed,
          variationsCreated,
          status: product.status,
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
    const lo = parseInt(m[1]), hi = parseInt(m[2]);
    if (!isNaN(lo) && !isNaN(hi) && lo <= hi && hi - lo <= 60) {
      return Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
    }
  }
  return raw.trim() ? [raw.trim()] : [];
}