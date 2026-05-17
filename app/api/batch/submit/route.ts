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

function parseLine(line: string): ParsedLine | null {
  const parts = line.split('|').map((p) => p.trim());
  const rawUrl = parts[0];
  if (!rawUrl) return null;

  const parsed = parseYupooUrl(rawUrl);
  if (!parsed) return null;

  const rawPrice = parts[3] ? parts[3].trim()
    : parts[2] && !isNaN(parseFloat(parts[2])) && !parts[2].includes('/') ? parts[2].trim()
    : null;

  if (rawPrice && isNaN(parseFloat(rawPrice))) return null;

  // If parts[1] contains '/' treat it as category, otherwise as name
  let rawName: string | null = null;
  let rawCategory: string | null = null;

  if (parts[1]) {
    if (parts[1].includes('/')) {
      rawCategory = parts[1];
    } else {
      rawName = parts[1];
      rawCategory = parts[2] && !parts[2].match(/^\d+(\.\d+)?$/) ? parts[2] : null;
    }
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
      jobs.map((job, i) => ({
        name: `scrape:${job.id}`,
        data: {
          jobId: job.id,
          url: job.url,
          rawName: job.raw_name,
          rawCategory: job.raw_category,
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