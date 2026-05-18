-- Migration 002: rename category_path (TEXT[]) → category_paths (JSONB)
-- Only needed if you already ran 001 and have data in scraped_albums.
-- Run with: psql $DATABASE_URL -f migrations/002_category_paths.sql

ALTER TABLE scraped_albums
  RENAME COLUMN category_path TO category_paths;

-- Convert existing TEXT[] rows into a JSONB array-of-arrays.
-- Old shape: {"Men","Sneakers","Nike"}  (single path stored flat)
-- New shape: [["Men","Sneakers","Nike"]] (array of paths)
ALTER TABLE scraped_albums
  ALTER COLUMN category_paths TYPE JSONB
  USING (
    CASE
      WHEN category_paths IS NULL OR array_length(category_paths, 1) IS NULL
        THEN '[]'::jsonb
      ELSE jsonb_build_array(to_jsonb(category_paths))
    END
  );

ALTER TABLE scraped_albums
  ALTER COLUMN category_paths SET DEFAULT '[]';