import { UTApi } from 'uploadthing/server';
import crypto from 'crypto';

export const utapi = new UTApi();

// ── In-process dedup cache ────────────────────────────────────────────────
// Maps SHA-256(imageBuffer) → { uploadedUrl, key }
// Survives across requests in the same Node.js process (dev + long-running prod).
// On a cold start / new deploy it resets gracefully — worst case is a re-upload.

const uploadCache = new Map<string, { uploadedUrl: string; key: string }>();

function hashBuffer(buf: ArrayBuffer): string {
  return crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

// ── Core fetch + upload ───────────────────────────────────────────────────

export interface FetchedImage {
  buffer: ArrayBuffer;
  contentType: string;  // always normalised (never image/jpg)
  filename: string;
}

async function fetchImage(imageUrl: string, refererBase: string): Promise<FetchedImage> {
  console.log(`[upload] Fetching: ${imageUrl}`);

  const response = await fetch(imageUrl, {
    headers: {
      Referer: refererBase,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });

  console.log(
    `[upload] Fetch status: ${response.status}, ` +
    `Content-Type: ${response.headers.get('content-type')}, ` +
    `Content-Length: ${response.headers.get('content-length')}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch image (HTTP ${response.status}): ${imageUrl}`);
  }

  // Normalise MIME type — WordPress rejects non-standard ones like image/jpg
  let contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (contentType === 'image/jpg') contentType = 'image/jpeg';
  if (!contentType.startsWith('image/')) contentType = 'image/jpeg';

  const buffer = await response.arrayBuffer();
  console.log(`[upload] Downloaded ${buffer.byteLength} bytes`);

  if (buffer.byteLength === 0) {
    throw new Error(`Empty response body for: ${imageUrl}`);
  }

  const ext = contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
    ? 'webp'
    : 'jpg';
  const filename = `yupoo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  return { buffer, contentType, filename };
}

async function uploadToUploadThing(
  image: FetchedImage
): Promise<{ uploadedUrl: string; key: string }> {
  console.log(
    `[upload] Uploading File: ${image.filename}, size=${image.buffer.byteLength}, type=${image.contentType}`
  );

  const file = new File([image.buffer], image.filename, { type: image.contentType });
  const result = await utapi.uploadFiles(file);

  console.log(`[upload] UploadThing result: ${JSON.stringify(result)}`);

  if (!result.data) {
    throw new Error(
      result.error?.message || JSON.stringify(result.error) || 'Unknown UploadThing error'
    );
  }

  const uploadedUrl = result.data.ufsUrl || (result.data as any).url;
  if (!uploadedUrl) throw new Error('No URL returned from UploadThing');

  console.log(`[upload] ✓ Success: ${uploadedUrl}`);
  return { uploadedUrl, key: result.data.key };
}

// ── Public API ────────────────────────────────────────────────────────────

export interface UploadResult {
  originalUrl: string;
  uploadedUrl: string | null;
  key: string | null;
  /** Raw image data — available even on dedup cache hits, used by WP direct upload */
  buffer: ArrayBuffer | null;
  contentType: string | null;
  filename: string | null;
  fromCache: boolean;
  error?: string;
}

export async function uploadImagesFromYupoo(
  imageUrls: string[],
  refererBase: string,
  onProgress?: (done: number, total: number) => void
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];

  console.log(`[upload] Starting: ${imageUrls.length} images, referer=${refererBase}`);
  console.log(
    `[upload] UPLOADTHING_TOKEN set: ${!!process.env.UPLOADTHING_TOKEN}, ` +
    `prefix: ${(process.env.UPLOADTHING_TOKEN || '').slice(0, 20)}...`
  );

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    try {
      // Always fetch the image so we have the buffer for WP direct upload
      const image = await fetchImage(url, refererBase);
      const hash = hashBuffer(image.buffer);
      const cached = uploadCache.get(hash);

      if (cached) {
        console.log(`[upload] ⚡ Cache hit for image ${i + 1} (hash ${hash.slice(0, 8)}…)`);
        results.push({
          originalUrl: url,
          uploadedUrl: cached.uploadedUrl,
          key: cached.key,
          buffer: image.buffer,
          contentType: image.contentType,
          filename: image.filename,
          fromCache: true,
        });
      } else {
        const uploaded = await uploadToUploadThing(image);
        uploadCache.set(hash, uploaded);
        results.push({
          originalUrl: url,
          uploadedUrl: uploaded.uploadedUrl,
          key: uploaded.key,
          buffer: image.buffer,
          contentType: image.contentType,
          filename: image.filename,
          fromCache: false,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[upload] ✗ Failed image ${i + 1}: ${message}`);
      results.push({
        originalUrl: url,
        uploadedUrl: null,
        key: null,
        buffer: null,
        contentType: null,
        filename: null,
        fromCache: false,
        error: message,
      });
    }

    onProgress?.(i + 1, imageUrls.length);

    if (i < imageUrls.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return results;
}