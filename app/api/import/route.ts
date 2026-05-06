import { NextRequest } from 'next/server';
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
  imageUrl: string | null;
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
        log(`${album.selectedImages.length} images to process`);

        // ── 1. Collect all image URLs needed ───────────────────────
        const allImageUrls = [...album.selectedImages];
        if (product.productType === 'variable') {
          for (const v of product.variations) {
            if (v.imageUrl && !allImageUrls.includes(v.imageUrl)) {
              allImageUrls.push(v.imageUrl);
            }
          }
        }

        const referer = `https://${album.storeSlug}.x.yupoo.com`;

        // ── 2. Pipeline: fetch → WP upload → discard buffer ─────────
        // Process one image at a time so only one buffer is in memory
        // at any point. This keeps RAM usage flat regardless of album size.
        log('Uploading images to WordPress…');
        const wpIdByUrl = new Map<string, number>();
        let fetchFailed = 0;
        let wpFailed = 0;

        for (let i = 0; i < allImageUrls.length; i++) {
          const url = allImageUrls[i];
          log(`  Image ${i + 1}/${allImageUrls.length}…`);

          let buffer: ArrayBuffer | null = null;
          let contentType: string | null = null;
          let filename: string | null = null;

          // Step A: fetch image
          try {
            const fetched = await fetchImageForUpload(url, referer);
            buffer = fetched.buffer;
            contentType = fetched.contentType;
            filename = fetched.filename;
          } catch (err) {
            fetchFailed++;
            log(`  ✗ Fetch failed: ${err instanceof Error ? err.message : err}`, 'warn');
            continue;
          }

          // Step B: upload directly to WordPress (skip UploadThing)
          try {
            const mediaId = await uploadImageToWordPress(buffer, contentType, filename);
            wpIdByUrl.set(url, mediaId);
            log(`  ✓ ${filename} → WP #${mediaId}`, 'success');
          } catch (err) {
            wpFailed++;
            log(`  ✗ WP upload failed for ${filename}: ${err instanceof Error ? err.message : err}`, 'warn');
          } finally {
            // Explicitly null the buffer so GC can reclaim it immediately
            buffer = null;
          }

          // Small pause between images to avoid overwhelming WP
          if (i < allImageUrls.length - 1) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        if (wpIdByUrl.size === 0) throw new Error('All image uploads failed.');

        const totalFailed = fetchFailed + wpFailed;
        if (totalFailed > 0) log(`${totalFailed} image(s) skipped.`, 'warn');
        log(`✓ ${wpIdByUrl.size} images in WordPress`, 'success');

        // ── 3. Resolve categories ───────────────────────────────────
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

        // ── 4. Build attributes ─────────────────────────────────────
        const attributes = [];

        if (product.productType === 'variable' && product.variationAttribute && product.variations.length > 0) {
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

        // ── 5. Build parent product image list ──────────────────────
        const parentImages = album.selectedImages
          .map((url, position) => {
            const id = wpIdByUrl.get(url);
            return id ? { id, position } : null;
          })
          .filter((x): x is { id: number; position: number } => x !== null);

        // ── 6. Create parent WooCommerce product ────────────────────
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
          regular_price: product.productType === 'simple' ? (product.regularPrice || undefined) : undefined,
        });

        log(`✓ Product created! ID: ${created.id}`, 'success');

        log(`DEBUG variations payload: ${JSON.stringify(product.variations)}`);
        log(`DEBUG variationAttribute: "${product.variationAttribute}"`);
        log(`DEBUG productType: "${product.productType}"`);
        log(`DEBUG variations.length: ${product.variations.length}`);

        // ── 7. Create variations ────────────────────────────────────
        let variationsCreated = 0;
        if (product.productType === 'variable' && product.variations.length > 0) {
          log(`Creating ${product.variations.length} variation(s)…`);

          for (const v of product.variations) {
            if (!v.value.trim()) continue;
            try {
              const imageId = v.imageUrl ? wpIdByUrl.get(v.imageUrl) : undefined;
              
              log(`DEBUG creating variation: "${v.value}", imageId: ${imageId ?? 'none'}`);

              await createWcVariation(created.id, {
                attributes: [{ name: product.variationAttribute, option: v.value }],
                ...(imageId ? { image: { id: imageId } } : {}),
                status: product.status,
                regular_price: product.regularPrice || undefined,
              });
              variationsCreated++;
              log(`  ✓ "${v.value}"${imageId ? ` → img #${imageId}` : ''}${product.regularPrice ? ` @ ${product.regularPrice}` : ''}`, 'success');
            } catch (err) {
              log(`  ✗ "${v.value}" failed: ${err instanceof Error ? err.message : err}`, 'warn');
            }
          }

          log(`✓ ${variationsCreated}/${product.variations.length} variations created`, 'success');
        }

        // ── 8. Send done event FIRST before any cleanup ─────────────
        // This ensures the UI receives success even if the stream closes
        // immediately after due to memory pressure or connection issues
        send(controller, {
          type: 'done',
          productId: created.id,
          productUrl: `${process.env.WC_URL}/wp-admin/post.php?post=${created.id}&action=edit`,
          uploadedImages: parentImages.length,
          failedImages: totalFailed,
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

// ── Fetch image for direct WP upload ───────────────────────────────────────
// Replaces the two-step UploadThing → WP flow with a single fetch → WP step,
// halving the number of buffers needed and eliminating UploadThing entirely
// for the import pipeline.
async function fetchImageForUpload(
  imageUrl: string,
  referer: string
): Promise<{ buffer: ArrayBuffer; contentType: string; filename: string }> {
  const response = await fetch(imageUrl, {
    headers: {
      Referer: referer,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  let contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (contentType === 'image/jpg') contentType = 'image/jpeg';
  if (!contentType.startsWith('image/')) contentType = 'image/jpeg';

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength === 0) throw new Error('Empty response body');

  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const filename = `yupoo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  return { buffer, contentType, filename };
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