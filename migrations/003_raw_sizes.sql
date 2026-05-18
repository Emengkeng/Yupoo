-- Migration 003: add raw_sizes column to import_jobs
-- Run with: psql $DATABASE_URL -f migrations/003_raw_sizes.sql

ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS raw_sizes TEXT;

-- Optional comment for documentation
COMMENT ON COLUMN import_jobs.raw_sizes IS
  'Raw size string supplied by the user, e.g. "36-45" or "36,37,38,39". '
  'Parsed by the import worker into individual WooCommerce size variations.';