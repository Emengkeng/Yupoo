-- Migration 001: initial schema
-- Run with: psql $DATABASE_URL -f migrations/001_initial.sql
-- Or via the migrate script: npm run migrate

CREATE TABLE IF NOT EXISTS import_jobs (
  id              SERIAL PRIMARY KEY,
  url             TEXT NOT NULL,
  -- Optional overrides supplied by the user in the input form
  raw_name        TEXT,                        -- "Boots", "Classic Sneaker", etc.
  raw_category    TEXT,                        -- "Men/Sneakers/Nike" raw string
  raw_price       TEXT,                        -- "1,299", "19.99", etc.
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','scraping','scraped','importing','done','failed')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scraped_albums (
  id              SERIAL PRIMARY KEY,
  job_id          INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  album_id        TEXT NOT NULL,
  store_slug      TEXT NOT NULL,
  album_url       TEXT NOT NULL,
  raw_title       TEXT,                        -- title as scraped (may be Chinese)
  translated_name TEXT,                        -- Claude-translated/generated name
  description     TEXT,                        -- Claude-generated English description
  category_path   TEXT[],                      -- resolved path e.g. {'Men','Sneakers','Nike'}
  images          JSONB NOT NULL DEFAULT '[]', -- array of image URLs
  total_pages     INTEGER NOT NULL DEFAULT 1,
  scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS imported_products (
  id                  SERIAL PRIMARY KEY,
  job_id              INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  wc_product_id       INTEGER NOT NULL,
  wc_product_url      TEXT NOT NULL,
  images_uploaded     INTEGER NOT NULL DEFAULT 0,
  images_failed       INTEGER NOT NULL DEFAULT 0,
  variations_created  INTEGER NOT NULL DEFAULT 0,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for queue workers polling by status
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scraped_albums_job_id ON scraped_albums(job_id);
CREATE INDEX IF NOT EXISTS idx_imported_products_job_id ON imported_products(job_id);

-- Auto-update updated_at on import_jobs
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER import_jobs_updated_at
  BEFORE UPDATE ON import_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();