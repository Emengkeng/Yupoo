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
  // Use ?tab=nor (detail view) — it renders all data-origin-src in the HTML
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

    // networkidle2 ensures JS has run and lazy-loaded attrs are set
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Wait for the image cards to appear
    await page.waitForSelector('.showalbum__children', { timeout: 20000 }).catch(() => {});

    // Scroll to trigger any remaining lazy loaders
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
      // ── Title ─────────────────────────────────────────────
      const titleEl =
        document.querySelector('.showalbumheader__gallerytitle') ||
        document.querySelector('h1') ||
        document.querySelector('title');
      const title = (titleEl?.textContent || '').trim().replace(/\s*[-|].*$/, '').trim();

      // ── Category ──────────────────────────────────────────
      // Look in the viewer info panel which reliably has the category link
      const catEl = document.querySelector('.viewer__catewrap a, .yupoo-viewer-cate-item a');
      const category = catEl ? (catEl.textContent || '').trim() : null;

      // ── Images ────────────────────────────────────────────
      const seen = new Set<string>();
      const images: string[] = [];

      const pushIfValid = (src: string | null | undefined) => {
        if (!src) return;
        const s = src.trim();
        if (!s) return;
        if (s.startsWith('data:')) return;
        // Filter out avatars / loading placeholders
        if (s.includes('avatar') || s.includes('placeholder') || s.includes('loading')) return;
        // Only Yupoo photo CDN
        if (!s.includes('photo.yupoo.com') && !s.includes('img.yupoo.com')) return;
        if (seen.has(s)) return;
        seen.add(s);
        images.push(s);
      };

      // Primary: data-origin-src on every img inside album children
      document.querySelectorAll('.showalbum__children img').forEach((img) => {
        pushIfValid(img.getAttribute('data-origin-src'));
        pushIfValid(img.getAttribute('data-src'));   // fallback: big.jpg variant
        pushIfValid(img.getAttribute('src'));          // last resort
      });

      // Fallback: all imgs on page if we got nothing
      if (images.length === 0) {
        document.querySelectorAll('img').forEach((img) => {
          pushIfValid(img.getAttribute('data-origin-src'));
          pushIfValid(img.getAttribute('data-src'));
          pushIfValid(img.getAttribute('src'));
        });
      }

      // ── Pagination ────────────────────────────────────────
      const hasNextPage = !!document.querySelector(
        '.pagination .next:not(.disabled), a[rel="next"], .page-next:not([disabled])'
      );

      return { title, category, images, hasNextPage };
    }, storeSlug);

    console.log(`Scraped page ${pageNum} of album ${albumId}: found ${result.images.length} images.`);

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

    // Deduplicate across pages
    for (const img of result.images) {
      if (!allImages.includes(img)) allImages.push(img);
    }

    if (!result.hasNextPage) break;
    page++;

    await new Promise((r) => setTimeout(r, 800));
  }

  if (allImages.length === 0) {
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
    images: allImages,
    totalPages: page,
  };
}