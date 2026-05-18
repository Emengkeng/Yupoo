import { Pool } from 'pg';

const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const db =
  globalForPg.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pgPool = db;
}

// ── Typed query helpers ───────────────────────────────────────────────────

export type JobStatus =
  | 'pending'
  | 'scraping'
  | 'scraped'
  | 'importing'
  | 'done'
  | 'failed';

export interface ImportJob {
  id: number;
  url: string;
  raw_name: string | null;
  raw_category: string | null;
  raw_price: string | null;
  status: JobStatus;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScrapedAlbum {
  id: number;
  job_id: number;
  album_id: string;
  store_slug: string;
  album_url: string;
  raw_title: string | null;
  translated_name: string | null;
  description: string | null;
  /**
   * Array of category paths.
   * Each inner array is one full path from root to leaf.
   * e.g. [["Men","Sneakers","Nike"], ["Sale","Footwear"]]
   * The WooCommerce importer assigns the leaf node ID of each path to the product.
   */
  category_paths: string[][];
  images: string[];
  total_pages: number;
  scraped_at: Date;
}

export interface ImportedProduct {
  id: number;
  job_id: number;
  wc_product_id: number;
  wc_product_url: string;
  images_uploaded: number;
  images_failed: number;
  variations_created: number;
  imported_at: Date;
}

// ── Job queries ───────────────────────────────────────────────────────────

export async function createJobs(
  entries: { url: string; raw_name?: string; raw_category?: string; raw_price?: string }[]
): Promise<ImportJob[]> {
  if (entries.length === 0) return [];

  const values = entries
    .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(', ');

  const params = entries.flatMap((e) => [
    e.url,
    e.raw_name ?? null,
    e.raw_category ?? null,
    e.raw_price ?? null,
  ]);

  const res = await db.query<ImportJob>(
    `INSERT INTO import_jobs (url, raw_name, raw_category, raw_price)
     VALUES ${values}
     RETURNING *`,
    params
  );
  return res.rows;
}

export async function updateJobStatus(
  id: number,
  status: JobStatus,
  error?: string
): Promise<void> {
  await db.query(
    `UPDATE import_jobs SET status = $1, error = $2 WHERE id = $3`,
    [status, error ?? null, id]
  );
}

export async function getJobs(limit = 200, offset = 0): Promise<ImportJob[]> {
  const res = await db.query<ImportJob>(
    `SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

export async function getJobStats(): Promise<Record<JobStatus, number>> {
  const res = await db.query<{ status: JobStatus; count: string }>(
    `SELECT status, COUNT(*)::int AS count FROM import_jobs GROUP BY status`
  );
  const stats: Record<string, number> = {
    pending: 0, scraping: 0, scraped: 0,
    importing: 0, done: 0, failed: 0,
  };
  for (const row of res.rows) stats[row.status] = Number(row.count);
  return stats as Record<JobStatus, number>;
}

// ── Scraped album queries ─────────────────────────────────────────────────

export async function saveScrapedAlbum(data: {
  job_id: number;
  album_id: string;
  store_slug: string;
  album_url: string;
  raw_title: string | null;
  translated_name: string | null;
  description: string | null;
  /**
   * Array of category paths.
   * Each inner array is one full path, e.g. [["Men","Sneakers","Nike"],["Sale","Footwear"]]
   */
  category_paths: string[][];
  images: string[];
  total_pages: number;
}): Promise<ScrapedAlbum> {
  const res = await db.query<ScrapedAlbum>(
    `INSERT INTO scraped_albums
      (job_id, album_id, store_slug, album_url, raw_title, translated_name,
       description, category_paths, images, total_pages)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.job_id,
      data.album_id,
      data.store_slug,
      data.album_url,
      data.raw_title,
      data.translated_name,
      data.description,
      JSON.stringify(data.category_paths),   // [["Men","Sneakers","Nike"],...]
      JSON.stringify(data.images),
      data.total_pages,
    ]
  );

  const row = res.rows[0];

  // pg returns JSONB columns as already-parsed JS values, but guard just in case.
  return {
    ...row,
    category_paths: typeof row.category_paths === 'string'
      ? JSON.parse(row.category_paths)
      : (row.category_paths ?? []),
    images: typeof row.images === 'string'
      ? JSON.parse(row.images)
      : (row.images ?? []),
  };
}

export async function getScrapedAlbum(jobId: number): Promise<ScrapedAlbum | null> {
  const res = await db.query<ScrapedAlbum>(
    `SELECT * FROM scraped_albums WHERE job_id = $1 LIMIT 1`,
    [jobId]
  );
  if (!res.rows[0]) return null;

  const row = res.rows[0];
  return {
    ...row,
    category_paths: typeof row.category_paths === 'string'
      ? JSON.parse(row.category_paths)
      : (row.category_paths ?? []),
    images: typeof row.images === 'string'
      ? JSON.parse(row.images)
      : (row.images ?? []),
  };
}

// ── Imported product queries ──────────────────────────────────────────────

export async function saveImportedProduct(data: {
  job_id: number;
  wc_product_id: number;
  wc_product_url: string;
  images_uploaded: number;
  images_failed: number;
  variations_created: number;
}): Promise<void> {
  await db.query(
    `INSERT INTO imported_products
      (job_id, wc_product_id, wc_product_url, images_uploaded, images_failed, variations_created)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      data.job_id,
      data.wc_product_id,
      data.wc_product_url,
      data.images_uploaded,
      data.images_failed,
      data.variations_created,
    ]
  );
}