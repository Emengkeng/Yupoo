const WC_URL = process.env.WC_URL!;
const WC_KEY = process.env.WC_CONSUMER_KEY!;
const WC_SECRET = process.env.WC_CONSUMER_SECRET!;

function wcHeaders() {
  const credentials = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64');
  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

async function wcFetch(path: string, options: RequestInit = {}) {
  const url = `${WC_URL}/wp-json/wc/v3${path}`;
  const res = await fetch(url, { ...options, headers: { ...wcHeaders(), ...(options.headers as Record<string, string> || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WooCommerce API error ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Categories ────────────────────────────────────────────────────────────

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
    (c) => c.name.toLowerCase() === needle && (parentId === null ? c.parent === 0 : c.parent === parentId)
  );
  if (existing) return { id: existing.id, cats: existingCats };

  const created: WcCategory = await wcFetch('/products/categories', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), ...(parentId ? { parent: parentId } : {}) }),
  });

  return { id: created.id, cats: [...existingCats, created] };
}

/**
 * Resolve an array of category name segments (e.g. ["Sneakers", "Nike"])
 * into a WooCommerce category ID, creating missing levels on the fly.
 */
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

// ── Products ──────────────────────────────────────────────────────────────

export interface CreateProductPayload {
  name: string;
  description: string;
  status: 'draft' | 'publish';
  categories: { id: number }[];
  images: { src: string; position: number }[];
  attributes: {
    name: string;
    visible: boolean;
    variation: boolean;
    options: string[];
  }[];
  meta_data: { key: string; value: string }[];
}

export async function createWcProduct(payload: CreateProductPayload) {
  return wcFetch('/products', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
