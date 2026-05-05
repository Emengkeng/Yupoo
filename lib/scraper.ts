import puppeteer, { Browser } from 'puppeteer';

export interface ScrapedAlbum {
  title: string;
  albumId: string;
  storeSlug: string;
  albumUrl: string;
  category: string | null;
  images: string[];
  totalPages: number;
}

/**
 * Normalise any Yupoo album URL into a canonical form and extract parts.
 */
export function parseYupooUrl(raw: string): {
  storeSlug: string;
  albumId: string;
  canonical: string;
} | null {
  try {
    const url = new URL(raw.trim());

    // Format A: storename.x.yupoo.com/albums/ALBUMID
    const subdomainMatch = url.hostname.match(/^(.+)\.x\.yupoo\.com$/);
    if (subdomainMatch) {
      const storeSlug = subdomainMatch[1];
      const albumMatch = url.pathname.match(/\/albums\/(\d+)/);
      if (!albumMatch) return null;
      const albumId = albumMatch[1];
      return {
        storeSlug,
        albumId,
        canonical: `https://${storeSlug}.x.yupoo.com/albums/${albumId}`,
      };
    }

    // Format B: x.yupoo.com/photos/storename/albums/ALBUMID
    if (url.hostname === 'x.yupoo.com') {
      const pathMatch = url.pathname.match(/\/photos\/([^/]+)\/albums\/(\d+)/);
      if (!pathMatch) return null;
      const storeSlug = pathMatch[1];
      const albumId = pathMatch[2];
      return {
        storeSlug,
        albumId,
        canonical: `https://${storeSlug}.x.yupoo.com/albums/${albumId}`,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the filename (without extension) looks like a real full-res
 * Yupoo image hash — e.g. "6910a181", "72352e99".
 * Thumbnail variants like "small", "medium", "large", "thumb" return false.
 */
function isFullResUrl(imageUrl: string): boolean {
  try {
    const pathname = new URL(imageUrl).pathname;
    const filename = pathname.split('/').pop() || '';
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    // A real hash is hex characters only, typically 6-12 chars
    return /^[0-9a-f]{6,}$/i.test(nameWithoutExt);
  } catch {
    return false;
  }
}

/**
 * Extract the photoId segment from a Yupoo CDN URL.
 * URL pattern: https://photo.yupoo.com/{store}/{photoId}/{filename}
 * Returns null if pattern doesn't match.
 */
function getPhotoId(imageUrl: string): string | null {
  try {
    const pathname = new URL(imageUrl).pathname;
    // pathname = /{store}/{photoId}/{filename}
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 3) return parts[1]; // photoId is index 1
    return null;
  } catch {
    return null;
  }
}

/**
 * Deduplicate a list of Yupoo image URLs:
 * 1. Group by photoId
 * 2. Within each group, prefer full-res (hex hash filename) over thumbnails
 * 3. If only thumbnails exist for a photoId, keep the first one as fallback
 * 4. Preserve original order based on first appearance of each photoId
 */
function deduplicateImages(images: string[]): string[] {
  // Map: photoId → { fullRes: string | null, fallback: string }
  const groups = new Map<string, { fullRes: string | null; fallback: string }>();
  // Track insertion order
  const order: string[] = [];

  for (const url of images) {
    const photoId = getPhotoId(url);
    if (!photoId) continue; // skip non-CDN URLs

    if (!groups.has(photoId)) {
      groups.set(photoId, { fullRes: null, fallback: url });
      order.push(photoId);
    }

    const group = groups.get(photoId)!;
    if (isFullResUrl(url)) {
      // Prefer full-res; if multiple full-res exist, keep first
      if (!group.fullRes) group.fullRes = url;
    } else {
      // Keep as fallback only if no fallback set yet
      if (group.fallback === url) {
        // already set on creation
      }
    }
  }

  return order.map((photoId) => {
    const group = groups.get(photoId)!;
    return group.fullRes ?? group.fallback;
  });
}

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });
  return browserInstance;
}

async function scrapeAlbumPage(
  browser: Browser,
  url: string,
  storeSlug: string,
  albumId: string,
  pageNum: number
): Promise<{ images: string[]; title: string; category: string | null; hasNextPage: boolean }> {
  const baseUrl = pageNum > 1 ? `${url}?page=${pageNum}&uid=1` : `${url}?uid=1`;
  const page = await browser.newPage();

  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://${storeSlug}.x.yupoo.com/albums`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('.showalbum__children', { timeout: 20000 }).catch(() => {});

    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 200;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    });

    await new Promise((r) => setTimeout(r, 1500));

    const result = await page.evaluate((slug: string) => {
      const titleEl =
        document.querySelector('.showalbumheader__gallerytitle') ||
        document.querySelector('h1') ||
        document.querySelector('title');
      const title = (titleEl?.textContent || '').trim().replace(/\s*[-|].*$/, '').trim();

      const catEl = document.querySelector('.viewer__catewrap a, .yupoo-viewer-cate-item a');
      const category = catEl ? (catEl.textContent || '').trim() : null;

      const seen = new Set<string>();
      const images: string[] = [];

      const pushIfValid = (src: string | null | undefined) => {
        if (!src) return;
        const s = src.trim();
        if (!s || s.startsWith('data:')) return;
        if (s.includes('avatar') || s.includes('placeholder') || s.includes('loading')) return;
        if (!s.includes('photo.yupoo.com') && !s.includes('img.yupoo.com')) return;
        if (seen.has(s)) return;
        seen.add(s);
        images.push(s);
      };

      document.querySelectorAll('.showalbum__children img').forEach((img) => {
        // Prioritise data-origin-src (full-res lazy attr) first
        pushIfValid(img.getAttribute('data-origin-src'));
        pushIfValid(img.getAttribute('data-src'));
        pushIfValid(img.getAttribute('src'));
      });

      if (images.length === 0) {
        document.querySelectorAll('img').forEach((img) => {
          pushIfValid(img.getAttribute('data-origin-src'));
          pushIfValid(img.getAttribute('data-src'));
          pushIfValid(img.getAttribute('src'));
        });
      }

      const hasNextPage = !!document.querySelector(
        '.pagination .next:not(.disabled), a[rel="next"], .page-next:not([disabled])'
      );

      return { title, category, images, hasNextPage };
    }, storeSlug);

    console.log(`Scraped page ${pageNum} of album ${albumId}: found ${result.images.length} images (before dedup).`);

    return result;
  } finally {
    await page.close();
  }
}

export async function scrapeAlbum(rawUrl: string): Promise<ScrapedAlbum> {
  const parsed = parseYupooUrl(rawUrl);
  if (!parsed) throw new Error('Invalid Yupoo album URL. Must contain /albums/ALBUMID.');

  const { storeSlug, albumId, canonical } = parsed;
  const browser = await getBrowser();

  const allImages: string[] = [];
  let title = '';
  let category: string | null = null;
  let page = 1;
  const MAX_PAGES = 20;

  while (page <= MAX_PAGES) {
    const result = await scrapeAlbumPage(browser, canonical, storeSlug, albumId, page);

    if (page === 1) {
      title = result.title || `Album ${albumId}`;
      category = result.category;
    }

    for (const img of result.images) {
      if (!allImages.includes(img)) allImages.push(img);
    }

    if (!result.hasNextPage) break;
    page++;

    await new Promise((r) => setTimeout(r, 800));
  }

  // Deduplicate: group by photoId, prefer full-res hex-hash filenames
  const dedupedImages = deduplicateImages(allImages);
  const removedCount = allImages.length - dedupedImages.length;
  if (removedCount > 0) {
    console.log(`[scraper] Removed ${removedCount} thumbnail/duplicate URLs, keeping ${dedupedImages.length} full-res images.`);
  }

  if (dedupedImages.length === 0) {
    throw new Error(
      'No images found. The album may be empty, private, or Yupoo is blocking access — try again in a minute.'
    );
  }

  return {
    title,
    albumId,
    storeSlug,
    albumUrl: canonical,
    category,
    images: dedupedImages,
    totalPages: page,
  };
}