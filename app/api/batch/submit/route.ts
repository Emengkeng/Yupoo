import { NextRequest, NextResponse } from 'next/server';
import { createJobs } from '@/lib/db';
import { getScrapeQueue } from '@/lib/queues';
import { parseYupooUrl } from '@/lib/scraper';

interface ParsedLine {
  url: string;
  rawName: string | null;
  rawCategory: string | null;
  rawPrice: string | null;
}

/**
 * Determines whether a field value looks like a category path.
 *
 * A field is treated as a category if it contains '/' (path separator) or ';'
 * (multiple-path separator). A plain name like "Boots" contains neither.
 */
function looksLikeCategory(value: string): boolean {
  return value.includes('/') || value.includes(';');
}

/**
 * Parse one input line into its structured fields.
 *
 * Supported formats (| is the field separator):
 *
 *   URL
 *   URL | Name
 *   URL | Category/Sub
 *   URL | Category/Sub | Price
 *   URL | Name | Category/Sub
 *   URL | Name | Category/Sub | Price
 *   URL | Category/Sub | Price
 *
 * Multiple categories (semicolon-separated paths):
 *   URL | Men/Sneakers/Nike;Sale/Footwear
 *   URL | Name | Men/Sneakers/Nike;Sale/Footwear | Price
 *
 * Field 2 auto-detection:
 *   - contains '/' or ';'  → category
 *   - otherwise            → name
 *
 * Price must be a valid number; it is always the last pipe field when present.
 */
function parseLine(line: string): ParsedLine | null {
  const parts = line.split('|').map((p) => p.trim());
  const rawUrl = parts[0];
  if (!rawUrl) return null;

  const parsed = parseYupooUrl(rawUrl);
  if (!parsed) return null;

  // Detect price: last field is numeric (and not a category path)
  const lastField = parts[parts.length - 1];
  const lastIsPrice =
    parts.length > 1 &&
    !isNaN(parseFloat(lastField)) &&
    !looksLikeCategory(lastField);

  const rawPrice = lastIsPrice ? lastField : null;
  if (rawPrice && isNaN(parseFloat(rawPrice))) return null;

  // Remaining fields between URL and optional price
  const middleEnd = lastIsPrice ? parts.length - 1 : parts.length;
  const middle = parts.slice(1, middleEnd);

  let rawName: string | null = null;
  let rawCategory: string | null = null;

  if (middle.length === 0) {
    // URL only
  } else if (middle.length === 1) {
    // Single middle field — detect by content
    if (looksLikeCategory(middle[0])) {
      rawCategory = middle[0];
    } else {
      rawName = middle[0];
    }
  } else {
    // Two or more middle fields — first is name, second is category
    rawName = middle[0] || null;
    rawCategory = middle[1] || null;
  }

  return { url: parsed.canonical, rawName, rawCategory, rawPrice };
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
          rawCategory: job.raw_category,   // may contain ';' for multiple paths
          rawPrice: job.raw_price,
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