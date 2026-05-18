import { NextRequest, NextResponse } from 'next/server';
import { createJobs } from '@/lib/db';
import { getScrapeQueue } from '@/lib/queues';
import { parseYupooUrl } from '@/lib/scraper';

interface ParsedLine {
  url: string;
  rawName: string | null;
  rawCategory: string | null;
  rawPrice: string | null;
  rawSizes: string | null;
}

/**
 * Determines whether a field value looks like a category path.
 * A field is treated as a category if it contains '/' or ';'.
 */
function looksLikeCategory(value: string): boolean {
  return value.includes('/') || value.includes(';');
}

/**
 * Determines whether a field value looks like a size range or list.
 *
 * Matches:
 *   "36-45"          — EU range with hyphen
 *   "36–45"          — EU range with en-dash
 *   "36,37,38,39"    — comma-separated list
 *   "36 37 38 39"    — space-separated list (4+ entries)
 *
 * Must consist only of two-digit numbers (optionally with .5) separated
 * by hyphens, commas, or spaces. Single numbers are NOT treated as sizes
 * to avoid misidentifying a short price like "45" as a size range.
 */
function looksLikeSizes(value: string): boolean {
  const trimmed = value.trim();
  // Range: "36-45" or "36–45" (exactly two size tokens)
  if (/^\d{2}(\.\d)?\s*[-–—]\s*\d{2}(\.\d)?$/.test(trimmed)) return true;
  // List: at least two size tokens separated by commas or spaces
  const tokens = trimmed.split(/[\s,，]+/).filter(Boolean);
  return (
    tokens.length >= 2 &&
    tokens.every((t) => /^\d{2}(\.\d)?$/.test(t) && parseFloat(t) >= 34 && parseFloat(t) <= 50)
  );
}

/**
 * Parse one input line into its structured fields.
 *
 * Supported formats (| is the field separator):
 *
 *   URL
 *   URL | Name
 *   URL | Category/Sub
 *   URL | 36-45
 *   URL | Category/Sub | Price
 *   URL | Name | Category/Sub
 *   URL | Name | Category/Sub | Price
 *   URL | Name | Category/Sub | Price | 36-45
 *   URL | Category/Sub | Price | 36-45
 *   URL | Name | Category/Sub | 36-45
 *   URL | Category/Sub | 36-45
 *   URL | 36,37,38,39
 *
 * Detection order (last field → first):
 *   1. Sizes  — last field if it looks like a range or list
 *   2. Price  — next-to-last (after sizes stripped) if numeric
 *   3. Name / Category — auto-detected by presence of '/' or ';'
 */
function parseLine(line: string): ParsedLine | null {
  const parts = line.split('|').map((p) => p.trim());
  const rawUrl = parts[0];
  if (!rawUrl) return null;

  const parsed = parseYupooUrl(rawUrl);
  if (!parsed) return null;

  let endIdx = parts.length;

  // ── Step 1: peel sizes off the end ───────────────────────────────────
  let rawSizes: string | null = null;
  if (endIdx > 1 && looksLikeSizes(parts[endIdx - 1])) {
    rawSizes = parts[endIdx - 1];
    endIdx--;
  }

  // ── Step 2: peel price off the end ───────────────────────────────────
  let rawPrice: string | null = null;
  if (
    endIdx > 1 &&
    !isNaN(parseFloat(parts[endIdx - 1])) &&
    !looksLikeCategory(parts[endIdx - 1]) &&
    !looksLikeSizes(parts[endIdx - 1])
  ) {
    rawPrice = parts[endIdx - 1];
    if (isNaN(parseFloat(rawPrice))) rawPrice = null;
    endIdx--;
  }

  // ── Step 3: middle fields → name / category ───────────────────────────
  const middle = parts.slice(1, endIdx);

  let rawName: string | null = null;
  let rawCategory: string | null = null;

  if (middle.length === 0) {
    // URL only (possibly with sizes/price already peeled)
  } else if (middle.length === 1) {
    if (looksLikeCategory(middle[0])) {
      rawCategory = middle[0];
    } else {
      rawName = middle[0];
    }
  } else {
    // Two or more: first is name, second is category
    rawName = middle[0] || null;
    rawCategory = middle[1] || null;
  }

  return { url: parsed.canonical, rawName, rawCategory, rawPrice, rawSizes };
}

export async function POST(req: NextRequest) {
  try {
    const { input } = await req.json() as { input: string };

    if (!input?.trim()) {
      return NextResponse.json({ error: 'No input provided' }, { status: 400 });
    }

    const lines = input
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed: ParsedLine[] = [];
    const invalid: string[] = [];

    for (const line of lines) {
      const result = parseLine(line);
      if (result) parsed.push(result);
      else invalid.push(line);
    }

    if (parsed.length === 0) {
      return NextResponse.json(
        { error: 'No valid Yupoo URLs found', invalid },
        { status: 400 }
      );
    }

    // Create DB jobs
    const jobs = await createJobs(
      parsed.map((p) => ({
        url: p.url,
        raw_name: p.rawName ?? undefined,
        raw_category: p.rawCategory ?? undefined,
        raw_price: p.rawPrice ?? undefined,
        raw_sizes: p.rawSizes ?? undefined,
      }))
    );

    // Enqueue scrape jobs
    const scrapeQueue = getScrapeQueue();
    await scrapeQueue.addBulk(
      jobs.map((job) => ({
        name: `scrape:${job.id}`,
        data: {
          jobId: job.id,
          url: job.url,
          rawName: job.raw_name,
          rawCategory: job.raw_category,
          rawPrice: job.raw_price,
          rawSizes: job.raw_sizes,
        },
      }))
    );

    return NextResponse.json({
      ok: true,
      queued: jobs.length,
      invalid: invalid.length,
      invalidLines: invalid,
      jobIds: jobs.map((j) => j.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[batch/submit]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}