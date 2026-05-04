import { UTApi } from 'uploadthing/server';

// Singleton so we don't create a new client per request
export const utapi = new UTApi();

/**
 * Upload images from Yupoo URLs to UploadThing.
 * Yupoo requires a matching Referer header — we pass it via the URL object trick.
 * Returns an array of { originalUrl, uploadedUrl, error? } results.
 */
export async function uploadImagesFromYupoo(
  imageUrls: string[],
  refererBase: string, // e.g. "https://storename.x.yupoo.com"
  onProgress?: (done: number, total: number) => void
): Promise<{ originalUrl: string; uploadedUrl: string | null; key: string | null; error?: string }[]> {
  const results: { originalUrl: string; uploadedUrl: string | null; key: string | null; error?: string }[] = [];

  // UploadThing's uploadFilesFromUrl accepts headers via a UploadThingFile object
  // We process in small batches to avoid timeouts and rate limits
  const BATCH_SIZE = 5;

  for (let i = 0; i < imageUrls.length; i += BATCH_SIZE) {
    const batch = imageUrls.slice(i, i + BATCH_SIZE);

    const uploadThingFiles = batch.map((url) => ({
      url,
      name: `yupoo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
      customId: undefined,
      headers: {
        Referer: refererBase,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    }));

    try {
      const batchResults = await utapi.uploadFilesFromUrl(uploadThingFiles);

      for (let j = 0; j < batch.length; j++) {
        const res = batchResults[j];
        if (res && res.data) {
          results.push({
            originalUrl: batch[j],
            uploadedUrl: res.data.url,
            key: res.data.key,
          });
        } else {
          results.push({
            originalUrl: batch[j],
            uploadedUrl: null,
            key: null,
            error: res?.error?.message || 'Upload failed',
          });
        }
      }
    } catch (err) {
      // Whole batch failed — mark all as failed
      for (const url of batch) {
        results.push({
          originalUrl: url,
          uploadedUrl: null,
          key: null,
          error: err instanceof Error ? err.message : 'Batch upload error',
        });
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, imageUrls.length), imageUrls.length);

    // Small delay between batches
    if (i + BATCH_SIZE < imageUrls.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}
