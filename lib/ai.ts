const XAI_API = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-3-fast-beta';

// ── Brand abbreviation lookup ─────────────────────────────────────────────
const BRAND_ABBREVIATIONS: Record<string, string> = {
  'lv':    'Louis Vuitton',
  'bv':    'Bottega Veneta',
  'dg':    'Dolce & Gabbana',
  'ysl':   'Saint Laurent',
  'sl':    'Saint Laurent',
  'miu':   'Miu Miu',
  'gg':    'Gucci',
  'bb':    'Balenciaga',
  'cd':    'Christian Dior',
  'ow':    'Off-White',
  'nf':    'New Balance',
  'aj':    'Air Jordan',
  'af1':   'Air Force 1',
  'am':    'Air Max',
  'am90':  'Air Max 90',
  'am95':  'Air Max 95',
  'am97':  'Air Max 97',
  'tf':    'Tom Ford',
  'mc':    'MCM',
  'wb':    'Burberry',
  'ce':    'Celine',
  'fp':    'Fear of God',
  'fog':   'Fear of God',
  'ew':    'Enfants Riches Déprimés',
  'cp':    'C.P. Company',
  'sm':    'Salomon',
  'nb':    'New Balance',
  'goro':  "Goro's",
};

// Abbreviations that are redundant once the full brand name is present.
// e.g. "Louis Vuitton Glasses LV" → "Louis Vuitton Glasses"
const REDUNDANT_ABBR_AFTER_EXPANSION: Record<string, string> = {
  'lv': 'Louis Vuitton',
  'bv': 'Bottega Veneta',
  'gg': 'Gucci',
  'bb': 'Balenciaga',
  'cd': 'Christian Dior',
};

// ── Chinese brand name lookup ─────────────────────────────────────────────
export const CHINESE_BRAND_NAMES: Record<string, string> = {
  '普拉达':    'Prada',
  '古奇':     'Gucci',
  '缪缪':     'Miu Miu',
  '迪奥':     'Dior',
  '万宝龙':    'Montblanc',
  '卡地亚':    'Cartier',
  '圣罗兰':    'Saint Laurent',
  '华伦天奴':   'Valentino',
  '托里伯奇':   'Tory Burch',
  '芬迪':     'Fendi',
  '巴黎世家':   'Balenciaga',
  '香奈儿':    'Chanel',
  '爱马仕':    'Hermès',
  '博柏利':    'Burberry',
  '麦克斯韦':   'Alexander McQueen',
  '纪梵希':    'Givenchy',
  '范思哲':    'Versace',
  '杰尼亚':    'Ermenegildo Zegna',
  '蔻驰':     'Coach',
  '马克雅各布':  'Marc Jacobs',
  '路易威登':   'Louis Vuitton',
  '葆蝶家':    'Bottega Veneta',
  '宝缇嘉':    'Bottega Veneta',
  '克里斯汀迪奥': 'Christian Dior',
  '华伦天努':   'Valentino',
};

// ── Chinese product-grade / listing tags ──────────────────────────────────
export const CHINESE_PRODUCT_TAGS: Record<string, string> = {
  '原单': 'Original',
  '高仿': 'Replica',
  '正品': 'Authentic',
  '定制': 'Custom',
  '限量': 'Limited Edition',
};

// ── Noise words/phrases injected by Yupoo sellers into album titles ────────
// These add no product information and should be stripped before AI processing.
// Order matters: longer/more specific patterns first.
const TITLE_NOISE_PATTERNS: RegExp[] = [
  // Leading platform prefixes: "Yupoo-", "Yupoo ", "YUPOO-"
  /^yupoo[-\s]*/i,

  // Trailing/inline platform references: "DHgate", "Aliexpress", etc.
  /\bdhgate\b/gi,
  /\baliexpress\b/gi,
  /\btaobao\b/gi,
  /\b1688\b/g,

  // Quality/replica marketing adjectives that add no product info
  /\b(best fake|high quality replica|good quality|aaa\+?|replica online sale|exclusive cheap|sale outlet online|high quality)\b/gi,

  // "Code: XYZ123" — keep the code itself as a product identifier, strip "Code:"
  /\bcode\s*:\s*/gi,

  // Emojis and non-alphanumeric decoration at start/end
  /^[\s\p{Emoji}\p{So}\p{Sk}]+/u,
  /[\s\p{Emoji}\p{So}\p{Sk}]+$/u,

  // "No1", "No. 1" quality claims
  /\bno\.?\s*1\b/gi,

  // Yupoo anywhere (catch residual mid-string occurrences)
  /\byupoo\b/gi,
];

// ── Yupoo detection ───────────────────────────────────────────────────────

const YUPOO_RE = /\byupoo\b/i;

function containsYupoo(value: string): boolean {
  return YUPOO_RE.test(value);
}

/**
 * Strip "yupoo" from a *title* only.
 * Titles are short — bare word removal is safe here.
 */
function stripYupooFromTitle(value: string): string {
  return value.replace(/\s*\byupoo\b\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── Helper: expand Chinese brands and product tags ────────────────────────
export function expandChineseBrands(name: string): string {
  let result = name;

  const brandEntries = Object.entries(CHINESE_BRAND_NAMES).sort(
    ([a], [b]) => b.length - a.length
  );
  for (const [chinese, english] of brandEntries) {
    result = result.replace(chinese, english);
  }

  for (const [tag, label] of Object.entries(CHINESE_PRODUCT_TAGS)) {
    result = result.replace(new RegExp(`${tag}([\\w])`, 'g'), `${label} $1`);
    result = result.replace(tag, label);
  }

  return result.replace(/\s+/g, ' ').trim();
}

// ── Helper: normalize reversed "CODE Brand" titles ────────────────────────
export function normalizeTokenOrder(name: string): string {
  const match = name.match(/^(\d+)\s+(.+)$/);
  if (match) {
    return `${match[2]} ${match[1]}`;
  }
  return name;
}

// ── Helper: expand Latin brand abbreviations ──────────────────────────────
export function expandAbbreviations(name: string): string {
  let result = name;

  for (const [abbr, full] of Object.entries(BRAND_ABBREVIATIONS)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern =
      `(?<=[\\s\\u4e00-\\u9fff\\u3400-\\u4dbf]|^)` +
      `(${escaped})` +
      `(?=[\\s\\u4e00-\\u9fff\\u3400-\\u4dbf\\d]|$)`;
    const re = new RegExp(pattern, 'gi');
    result = result.replace(re, full);
  }

  return result;
}

/**
 * After expanding abbreviations, remove redundant short forms that now appear
 * alongside their full brand name.
 *
 * e.g. "Louis Vuitton Glasses LV Code BG7463"
 *   → expandAbbreviations → "Louis Vuitton Glasses Louis Vuitton Code BG7463"
 *   → deduplicateBrandNames → "Louis Vuitton Glasses Code BG7463"
 *
 * We handle this by detecting when the full brand name already appears and
 * removing the now-redundant abbreviation token.
 */
function deduplicateBrandNames(name: string): string {
  let result = name;

  for (const [abbr, full] of Object.entries(REDUNDANT_ABBR_AFTER_EXPANSION)) {
    if (!result.toLowerCase().includes(full.toLowerCase())) continue;

    // Remove the abbreviation token (case-insensitive, whole word)
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
  }

  return result.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Strip seller noise from a raw scraped Yupoo album title.
 *
 * Handles patterns like:
 *   "Yupoo Louis Vuitton Glasses LV Code: BG7463"   → "Louis Vuitton Glasses BG7463"
 *   "YUPOO-Burberry Replica Online Sale Glasses Code: XG3504" → "Burberry Glasses XG3504"
 *   "Best Fake Balenciaga Glasses Code: BG4943"      → "Balenciaga Glasses BG4943"
 *   "DHgate Louis Vuitton Glasses LV Code: UG5815"   → "Louis Vuitton Glasses UG5815"
 *   "Good Quality MiuMiu Glasses Code: UG6585"       → "MiuMiu Glasses UG6585"
 *   "👓 AAA+ Glasses Yupoo No1 High Quality"         → "Glasses" (sent to AI)
 */
function stripTitleNoise(raw: string): string {
  let result = raw.trim();
  for (const pattern of TITLE_NOISE_PATTERNS) {
    result = result.replace(pattern, ' ');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

// ── Master pre-processor ──────────────────────────────────────────────────
export function preprocessTitle(raw: string): string {
  let title = raw.trim();
  title = stripTitleNoise(title);       // remove platform/quality noise first
  title = normalizeTokenOrder(title);
  title = expandChineseBrands(title);
  title = expandAbbreviations(title);
  title = deduplicateBrandNames(title); // remove redundant abbreviations after expansion
  title = stripYupooFromTitle(title);   // final safety pass
  return title;
}

// ── Grok API call with 429 retry ──────────────────────────────────────────
async function grokText(prompt: string, retries = 4): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(XAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.XAI_API_KEY!}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (res.status === 429 && attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(`[ai] 429 rate limited, retrying in ${delay}ms (attempt ${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xAI API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }

  throw new Error('xAI API: all retries exhausted');
}

// ── Description prompt ────────────────────────────────────────────────────

function descriptionPrompt(productName: string, category: string | null, extra = ''): string {
  return `Write a 2-sentence product description for a WooCommerce store listing.
Product name: ${productName}${category ? `\nCategory: ${category}` : ''}
Keep it concise, factual, and suitable for a fashion/sneaker/accessories store.
Do not mention "Yupoo", image hosting platforms, or where the product images are sourced from.${extra}
Reply with only the description, no quotes, no labels.`;
}

// ── Generic fallback description ──────────────────────────────────────────

function fallbackDescription(productName: string): string {
  return `${productName} is a premium fashion item crafted with attention to detail and quality materials. It is an excellent choice for those seeking style and durability.`;
}

// ── Public helpers ────────────────────────────────────────────────────────

/**
 * Normalize and translate a single product title.
 * Uses local preprocessing first — AI only called if significant CJK remains.
 */
export async function translateTitle(title: string): Promise<string> {
  const preprocessed = preprocessTitle(title);

  const cjk = (preprocessed.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (cjk > 0 && cjk / preprocessed.length >= 0.3) {
    const translated = await grokText(
      `Translate this product title to English. Reply with only the translated title, nothing else.\n\n"${preprocessed}"`
    );
    return stripYupooFromTitle(expandAbbreviations(translated || preprocessed));
  }

  return preprocessed;
}

/**
 * Generate a 2-sentence product description for a WooCommerce listing.
 *
 * Strategy:
 * 1. Ask with a clear instruction not to mention Yupoo.
 * 2. If it still appears, retry once with a stronger correction.
 * 3. If it still appears after retry, return a safe generic description.
 *
 * We never surgically remove the word from a sentence — that risks leaving
 * grammatically broken text in the DB (e.g. "Available on , this sneaker...").
 */
export async function generateDescription(
  productName: string,
  categoryPath: string[]
): Promise<string> {
  const category = categoryPath.length > 0 ? categoryPath.join(' > ') : null;

  const first = await grokText(descriptionPrompt(productName, category));

  if (!containsYupoo(first)) return first;

  console.warn(`[ai] description contained "yupoo", retrying — product: "${productName}"`);

  const second = await grokText(
    descriptionPrompt(
      productName,
      category,
      '\n\nIMPORTANT: Your previous response mentioned "Yupoo". Do not reference Yupoo or any image platform under any circumstances.'
    )
  );

  if (!containsYupoo(second)) return second;

  console.warn(`[ai] description still contained "yupoo" after retry, using fallback — product: "${productName}"`);
  return fallbackDescription(productName);
}

/**
 * Batch: translate + generate descriptions for multiple products in one API call.
 * Preferred over calling translateTitle + generateDescription separately —
 * one API call instead of two per product, halving rate limit pressure.
 */
export async function batchEnrich(
  products: { name: string; categoryPath: string[] }[]
): Promise<{ translatedName: string; description: string }[]> {
  if (products.length === 0) return [];

  const preprocessed = products.map((p) => ({
    ...p,
    name: preprocessTitle(p.name),
  }));

  const lines = preprocessed
    .map(
      (p, i) =>
        `${i + 1}. Name: "${p.name}" | Category: "${p.categoryPath.join(' > ') || 'none'}"`
    )
    .join('\n');

  const batchPrompt = (extra = '') =>
    `For each product below, return a JSON array where each element has:
- "translatedName": the product name in English (translate any remaining Chinese if needed, otherwise keep as-is)
- "description": a 2-sentence English product description for a WooCommerce store

Do not mention "Yupoo", image hosting platforms, or where the product images are sourced from in any field.${extra}

Products:
${lines}

Reply with ONLY a valid JSON array, no markdown, no explanation. Example:
[{"translatedName":"Nike Air Max 90","description":"The Nike Air Max 90 is a classic running shoe..."}]`;

  const tryParse = (raw: string): { translatedName: string; description: string }[] | null => {
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(clean) as { translatedName: string; description: string }[];
      if (Array.isArray(parsed) && parsed.length === preprocessed.length) return parsed;
    } catch {}
    return null;
  };

  let parsed = tryParse(await grokText(batchPrompt()));

  // If any item contains "yupoo", retry the whole batch once with a stronger instruction
  if (parsed && parsed.some((item) => containsYupoo(item.translatedName) || containsYupoo(item.description))) {
    console.warn('[ai] batch result contained "yupoo", retrying with stronger instruction');
    const retried = tryParse(
      await grokText(
        batchPrompt(
          '\n\nIMPORTANT: Your previous response mentioned "Yupoo". Do not reference Yupoo or any image platform under any circumstances.'
        )
      )
    );
    if (retried) parsed = retried;
  }

  if (parsed) {
    return parsed.map((item) => {
      const translatedName = stripYupooFromTitle(expandAbbreviations(item.translatedName));
      // If "yupoo" somehow still appears in a description after two attempts,
      // use a generic fallback rather than storing broken text.
      const description = containsYupoo(item.description)
        ? fallbackDescription(translatedName)
        : item.description;
      return { translatedName, description };
    });
  }

  console.warn('[ai] Batch parse failed, falling back to individual calls');
  return Promise.all(
    preprocessed.map(async (p) => {
      const translatedName = await translateTitle(p.name);
      const description = await generateDescription(translatedName, p.categoryPath);
      return { translatedName, description };
    })
  );
}