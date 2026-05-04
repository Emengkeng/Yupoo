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
 * Handles:
 *   https://storename.x.yupoo.com/albums/123456?uid=1
 *   https://x.yupoo.com/photos/storename/albums/123456
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
  const pageUrl = pageNum > 1 ? `${url}?page=${pageNum}` : url;
  const page = await browser.newPage();

  try {
    // Set realistic headers so Yupoo treats us as a browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `https://${storeSlug}.x.yupoo.com/albums`,
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for images to appear
    await page.waitForSelector('img', { timeout: 15000 }).catch(() => {});

    // Scroll slowly to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 120);
      });
    });

    // Extra pause for any deferred loads
    await new Promise((r) => setTimeout(r, 1500));

    const result = await page.evaluate((slug: string) => {
      // ── Title ─────────────────────────────────────────────
      const titleEl =
        document.querySelector('.album__title') ||
        document.querySelector('h1') ||
        document.querySelector('.showalbum__title') ||
        document.querySelector('title');
      const title = (titleEl?.textContent || '').trim().replace(/\s*[-|].*$/, '').trim();

      // ── Category ──────────────────────────────────────────
      const breadcrumbs = Array.from(
        document.querySelectorAll('.breadcrumb a, .crumb a, nav a')
      )
        .map((el) => el.textContent?.trim())
        .filter(Boolean)
        .filter((t) => t !== 'Home' && t !== slug);
      const category = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1]! : null;

      // ── Images ────────────────────────────────────────────
      const seen = new Set<string>();
      const images: string[] = [];

      const pushIfValid = (src: string | null | undefined) => {
        if (!src) return;
        // Filter out tiny icons, avatars, placeholders
        if (src.includes('avatar') || src.includes('placeholder') || src.includes('loading'))
          return;
        // Only accept photo CDN URLs
        if (!src.includes('photo.yupoo.com') && !src.includes('img.yupoo.com') && !src.includes('x.yupoo.com/photos'))
          return;
        if (seen.has(src)) return;
        seen.add(src);
        images.push(src);
      };

      document.querySelectorAll('img').forEach((img) => {
        // Prefer full-res origin src attributes set by lazy loaders
        pushIfValid(img.getAttribute('data-origin-src'));
        pushIfValid(img.getAttribute('data-src'));
        pushIfValid(img.getAttribute('data-lazy-src'));
        pushIfValid(img.getAttribute('src'));
      });

      // ── Pagination ────────────────────────────────────────
      const hasNextPage = !!document.querySelector(
        '.pagination .next:not(.disabled), a[rel="next"], .page-next:not([disabled])'
      );

      return { title, category, images, hasNextPage };
    }, storeSlug);

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

    // Polite delay between pages
    await new Promise((r) => setTimeout(r, 800));
  }

  if (allImages.length === 0) {
    throw new Error(
      'No images found in this album. The album may be empty, private, or Yupoo is blocking access — try again in a minute.'
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
