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

export function parseYupooUrl(raw: string): {
  storeSlug: string;
  albumId: string;
  canonical: string;
} | null {
  try {
    const url = new URL(raw.trim());

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

function isFullResUrl(imageUrl: string): boolean {
  try {
    const pathname = new URL(imageUrl).pathname;
    const filename = pathname.split('/').pop() || '';
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    return /^[0-9a-f]{6,}$/i.test(nameWithoutExt);
  } catch {
    return false;
  }
}

function getPhotoId(imageUrl: string): string | null {
  try {
    const pathname = new URL(imageUrl).pathname;
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 3) return parts[1];
    return null;
  } catch {
    return null;
  }
}

function deduplicateImages(images: string[]): string[] {
  const groups = new Map<string, { fullRes: string | null; fallback: string }>();
  const order: string[] = [];

  for (const url of images) {
    const photoId = getPhotoId(url);
    if (!photoId) continue;

    if (!groups.has(photoId)) {
      groups.set(photoId, { fullRes: null, fallback: url });
      order.push(photoId);
    }

    const group = groups.get(photoId)!;
    if (isFullResUrl(url)) {
      if (!group.fullRes) group.fullRes = url;
    }
  }

  return order.map((photoId) => {
    const group = groups.get(photoId)!;
    return group.fullRes ?? group.fallback;
  });
}

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--safebrowsing-disable-auto-update',
    ],
  });
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

    // Block fonts, media and websockets — not needed for image URL extraction
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['font', 'media', 'websocket'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

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

    const result = await page.evaluate(() => {
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
    });

    console.log(`Scraped page ${pageNum} of album ${albumId}: ${result.images.length} images (before dedup).`);
    return result;
  } finally {
    await page.close();
  }
}

export async function scrapeAlbum(rawUrl: string): Promise<ScrapedAlbum> {
  const parsed = parseYupooUrl(rawUrl);
  if (!parsed) throw new Error('Invalid Yupoo album URL. Must contain /albums/ALBUMID.');

  const { storeSlug, albumId, canonical } = parsed;

  // Fresh browser per scrape — closed immediately after to free ~250MB
  // before the import phase begins
  const browser = await launchBrowser();

  const allImages: string[] = [];
  let title = '';
  let category: string | null = null;
  let page = 1;
  const MAX_PAGES = 20;

  try {
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
  } finally {
    // Always close — even on error — memory must be reclaimed before import
    try {
      await browser.close();
      console.log('[scraper] Browser closed, memory reclaimed.');
    } catch (e) {
      console.warn('[scraper] Failed to close browser:', e);
    }
  }

  const dedupedImages = deduplicateImages(allImages);
  const removedCount = allImages.length - dedupedImages.length;
  if (removedCount > 0) {
    console.log(`[scraper] Removed ${removedCount} duplicate/thumbnail URLs, keeping ${dedupedImages.length} full-res images.`);
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