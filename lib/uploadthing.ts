import { UTApi } from 'uploadthing/server';

export const utapi = new UTApi();

async function fetchAndUpload(
  imageUrl: string,
  refererBase: string
): Promise<{ uploadedUrl: string; key: string }> {
  console.log(`[upload] Fetching: ${imageUrl}`);

  const response = await fetch(imageUrl, {
    headers: {
      Referer: refererBase,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });

  console.log(`[upload] Fetch status: ${response.status}, Content-Type: ${response.headers.get('content-type')}, Content-Length: ${response.headers.get('content-length')}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch image (HTTP ${response.status}): ${imageUrl}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const buffer = await response.arrayBuffer();

  console.log(`[upload] Downloaded ${buffer.byteLength} bytes`);

  if (buffer.byteLength === 0) {
    throw new Error(`Empty response body for: ${imageUrl}`);
  }

  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const filename = `yupoo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const file = new File([buffer], filename, { type: contentType });

  console.log(`[upload] Uploading File: ${filename}, size=${file.size}, type=${file.type}`);

  const result = await utapi.uploadFiles(file);

  console.log(`[upload] UploadThing result: ${JSON.stringify(result)}`);

  if (!result.data) {
    throw new Error(result.error?.message || JSON.stringify(result.error) || 'Unknown UploadThing error');
  }

  // v7 uses ufsUrl (the new UFS CDN), with url as fallback
  const uploadedUrl = result.data.ufsUrl || (result.data as any).url;
  if (!uploadedUrl) {
    throw new Error('No URL returned from UploadThing');
  }

  console.log(`[upload] ✓ Success: ${uploadedUrl}`);
  return { uploadedUrl, key: result.data.key };
}

export async function uploadImagesFromYupoo(
  imageUrls: string[],
  refererBase: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ originalUrl: string; uploadedUrl: string | null; key: string | null; error?: string }[]> {
  const results: { originalUrl: string; uploadedUrl: string | null; key: string | null; error?: string }[] = [];

  console.log(`[upload] Starting: ${imageUrls.length} images, referer=${refererBase}`);
  console.log(`[upload] UPLOADTHING_TOKEN set: ${!!process.env.UPLOADTHING_TOKEN}, prefix: ${(process.env.UPLOADTHING_TOKEN || '').slice(0, 20)}...`);

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    try {
      const uploaded = await fetchAndUpload(url, refererBase);
      results.push({ originalUrl: url, uploadedUrl: uploaded.uploadedUrl, key: uploaded.key });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[upload] ✗ Failed image ${i + 1}: ${message}`);
      results.push({ originalUrl: url, uploadedUrl: null, key: null, error: message });
    }

    onProgress?.(i + 1, imageUrls.length);

    if (i < imageUrls.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return results;
}