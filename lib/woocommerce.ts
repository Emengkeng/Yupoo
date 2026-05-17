const WC_URL = process.env.WC_URL!;
const WC_KEY = process.env.WC_CONSUMER_KEY!;
const WC_SECRET = process.env.WC_CONSUMER_SECRET!;

const WP_APP_USER = process.env.WP_APP_USER!;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;

function wcAuth() {
  return `Basic ${Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64')}`;
}

function wpAuth() {
  return `Basic ${Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString('base64')}`;
}

async function wcFetch(path: string, options: RequestInit = {}) {
  const url = `${WC_URL}/wp-json/wc/v3${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: wcAuth(),
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WooCommerce API error ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Retry helper ──────────────────────────────────────────────────────────
// Retries on 503 (server overloaded) and 429 (rate limited) with exponential
// backoff. All other errors are rethrown immediately.

const RETRYABLE = [429, 503];

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 4
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = parseInt(msg.match(/error (\d{3})/i)?.[1] ?? '0', 10);
      const retryable = RETRYABLE.some((s) => msg.includes(String(s)));

      if (retryable && attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
        console.warn(
          `[wp] ${label} | ${status || 'error'}, retrying in ${delay}ms (attempt ${attempt}/${retries})`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw err;
    }
  }
  // Unreachable but satisfies TypeScript
  throw new Error(`${label}: all retries exhausted`);
}

export async function uploadImageToWordPress(
  imageBuffer: ArrayBuffer,
  contentType: string,
  filename: string
): Promise<number> {
  if (!WP_APP_USER || !WP_APP_PASSWORD) {
    throw new Error(
      'WP_APP_USER and WP_APP_PASSWORD env vars are required for media uploads. ' +
      'Generate an Application Password at Users → your admin → Application Passwords.'
    );
  }

  const url = `${WC_URL}/wp-json/wp/v2/media`;
  console.log(`[wp-media] Uploading ${filename} (${imageBuffer.byteLength} bytes)`);

  const media = await withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: wpAuth(),
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
        body: imageBuffer,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`WordPress media upload error ${res.status}: ${body}`);
      }

      return res.json();
    },
    `upload ${filename}`
  );

  console.log(`[wp-media] ✓ Attachment ID ${media.id}`);
  return media.id as number;
}

export interface WcCategory {
  id: number;
  name: string;
  slug: string;
  parent: number;
}

export async function getAllCategories(): Promise<WcCategory[]> {
  const cats: WcCategory[] = [];
  let page = 1;
  while (true) {
    const batch: WcCategory[] = await wcFetch(`/products/categories?per_page=100&page=${page}`);
    cats.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return cats;
}

export async function findOrCreateCategory(
  name: string,
  parentId: number | null = null,
  existingCats: WcCategory[]
): Promise<{ id: number; cats: WcCategory[] }> {
  const needle = name.trim().toLowerCase();
  const existing = existingCats.find(
    (c) =>
      c.name.toLowerCase() === needle &&
      (parentId === null ? c.parent === 0 : c.parent === parentId)
  );
  if (existing) return { id: existing.id, cats: existingCats };

  const created: WcCategory = await wcFetch('/products/categories', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), ...(parentId ? { parent: parentId } : {}) }),
  });

  return { id: created.id, cats: [...existingCats, created] };
}

export async function resolveCategoryPath(
  segments: string[],
  existingCats: WcCategory[]
): Promise<{ id: number; cats: WcCategory[] }> {
  let parentId: number | null = null;
  let cats = existingCats;
  let lastId = 0;

  for (const seg of segments) {
    if (!seg.trim()) continue;
    const result = await findOrCreateCategory(seg, parentId, cats);
    lastId = result.id;
    parentId = result.id;
    cats = result.cats;
  }

  return { id: lastId, cats };
}

export interface CreateProductPayload {
  name: string;
  type: 'simple' | 'variable';
  description: string;
  status: 'draft' | 'publish';
  categories: { id: number }[];
  images: { id: number; position: number }[];
  attributes: {
    name: string;
    visible: boolean;
    variation: boolean;
    options: string[];
  }[];
  meta_data: { key: string; value: string }[];
  regular_price?: string;
}

export async function createWcProduct(payload: CreateProductPayload) {
  return withRetry(
    () => wcFetch('/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    `createWcProduct "${payload.name}"`
  );
}

export interface CreateVariationPayload {
  attributes: { name: string; option: string }[];
  image?: { id: number };
  status: 'draft' | 'publish';
  regular_price?: string;
}

export async function createWcVariation(
  productId: number,
  payload: CreateVariationPayload
) {
  return withRetry(
    () => wcFetch(`/products/${productId}/variations`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
    `createWcVariation product ${productId}`
  );
}