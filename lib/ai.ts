const XAI_API = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-3-fast-beta';

// ── Brand abbreviation lookup ─────────────────────────────────────────────
// Expands shorthand used by Yupoo sellers before passing to the AI.
// Keys are lowercase, matched case-insensitively against whole words.
// Add new entries here as you encounter them.

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

// ── Chinese brand name lookup ─────────────────────────────────────────────
// Common Chinese brand names found in Yupoo supplier catalogs.
// Applied before AI translation to reduce API costs and improve consistency.

export const CHINESE_BRAND_NAMES: Record<string, string> = {
  '普拉达':   'Prada',
  '古奇':    'Gucci',
  '缪缪':    'Miu Miu',
  '迪奥':    'Dior',
  '万宝龙':   'Montblanc',
  '卡地亚':   'Cartier',
  '圣罗兰':   'Saint Laurent',
  '华伦天奴':  'Valentino',
  '托里伯奇':  'Tory Burch',
  '芬迪':    'Fendi',
  '巴黎世家':  'Balenciaga',
  '香奈儿':   'Chanel',
  '爱马仕':   'Hermès',
  '博柏利':   'Burberry',
  '麦克斯韦':  'Alexander McQueen',
  '纪梵希':   'Givenchy',
  '范思哲':   'Versace',
  '杰尼亚':   'Ermenegildo Zegna',
  '蔻驰':    'Coach',
  '马克雅各布': 'Marc Jacobs',
  '路易威登':  'Louis Vuitton',
  '葆蝶家':   'Bottega Veneta',
  '宝缇嘉':   'Bottega Veneta',
  '克里斯汀迪奥': 'Christian Dior',
  '华伦天努':  'Valentino',   // alternate spelling seen in listings
};

// ── Chinese product-grade / listing tags ──────────────────────────────────
// Tokens that describe product grade or type in Yupoo listings.
// Replaced with their English equivalents before further processing.

export const CHINESE_PRODUCT_TAGS: Record<string, string> = {
  '原单': 'Original',   // "first copy" / AAA grade
  '高仿': 'Replica',
  '正品': 'Authentic',
  '定制': 'Custom',
  '限量': 'Limited Edition',
};

// ── Helper: expand Chinese brands and product tags ────────────────────────

/**
 * Replace known Chinese brand names and product-grade tags with English.
 * Operates on exact substring matches (no word-boundary needed for CJK).
 */
export function expandChineseBrands(name: string): string {
  let result = name;

  const brandEntries = Object.entries(CHINESE_BRAND_NAMES).sort(
    ([a], [b]) => b.length - a.length
  );
  for (const [chinese, english] of brandEntries) {
    result = result.replace(chinese, english);
  }

  for (const [tag, label] of Object.entries(CHINESE_PRODUCT_TAGS)) {
    // "原单1BH082" → "Original 1BH082"
    result = result.replace(new RegExp(`${tag}([\\w])`, 'g'), `${label} $1`);
    // "原单 1BH082" → "Original 1BH082" (tag with existing space)
    result = result.replace(tag, label);
  }

  return result.replace(/\s+/g, ' ').trim();
}

// ── Helper: normalize reversed "CODE Brand" titles ────────────────────────

/**
 * Yupoo sellers sometimes list products as "CODE BrandName" instead of
 * "BrandName CODE". Detect and flip so brand always comes first.
 * Only flips when the very first token is purely numeric.
 *
 * "7061 万宝龙"   → "万宝龙 7061"   (expandChineseBrands handles it next)
 * "7186 LV"      → "LV 7186"       (expandAbbreviations handles it next)
 * "BV 855182"    → unchanged        (BV is not numeric)
 * "普拉达 1BH082" → unchanged        (brand already first)
 */
export function normalizeTokenOrder(name: string): string {
  const match = name.match(/^(\d+)\s+(.+)$/);
  if (match) {
    return `${match[2]} ${match[1]}`;
  }
  return name;
}

// ── Helper: expand Latin brand abbreviations ──────────────────────────────

/**
 * Expand brand abbreviations in a product name.
 * Handles three cases:
 *  1. Standard Latin word boundary:   "lv bag"  → "Louis Vuitton bag"
 *  2. Abbreviation adjacent to CJK:   "BV包"    → "Bottega Veneta包"
 *  3. Abbreviation before a code:     "BV843893" → "Bottega Veneta843893"
 *
 * Uses lookbehind/lookahead (requires Node.js 10+ / V8 6.3+).
 * Falls back to capture-group approach for broader compatibility if needed.
 */
export function expandAbbreviations(name: string): string {
  let result = name;

  for (const [abbr, full] of Object.entries(BRAND_ABBREVIATIONS)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Matches abbr when surrounded by:
    // - start / end of string
    // - whitespace
    // - CJK character [\u4e00-\u9fff\u3400-\u4dbf]
    // - digit (so "BV843893" also expands)
    const pattern =
      `(?<=[\\s\\u4e00-\\u9fff\\u3400-\\u4dbf]|^)` +
      `(${escaped})` +
      `(?=[\\s\\u4e00-\\u9fff\\u3400-\\u4dbf\\d]|$)`;

    const re = new RegExp(pattern, 'gi');
    result = result.replace(re, full);
  }

  return result;
}

// ── Master pre-processor ──────────────────────────────────────────────────

/**
 * Run all local normalization steps on a raw Yupoo product title before
 * any AI call. Order matters:
 *   1. normalizeTokenOrder  — flip "7061 万宝龙" → "万宝龙 7061"
 *   2. expandChineseBrands  — "万宝龙" → "Montblanc", "原单" → "Original"
 *   3. expandAbbreviations  — "BV" → "Bottega Veneta", "LV" → "Louis Vuitton"
 *
 * Many common titles will be fully resolved here with zero API cost.
 */
export function preprocessTitle(raw: string): string {
  let title = raw.trim();
  title = normalizeTokenOrder(title);
  title = expandChineseBrands(title);
  title = expandAbbreviations(title);
  return title;
}

// ── Grok API call ─────────────────────────────────────────────────────────

async function grokText(prompt: string): Promise<string> {
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

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`xAI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

// ── Public helpers ────────────────────────────────────────────────────────

/**
 * Normalize and translate a single product title.
 *
 * Pipeline:
 *   1. preprocessTitle()   — local normalization (no API cost)
 *   2. If significant CJK remains → AI translation
 *   3. expandAbbreviations() on the AI result (catches any abbrs in translation)
 *
 * Examples (no API call needed):
 *   "普拉达 原单1BH082"  → "Prada Original 1BH082"
 *   "7061 万宝龙"       → "Montblanc 7061"
 *   "BV 855182"        → "Bottega Veneta 855182"
 *   "7186 LV"          → "Louis Vuitton 7186"
 */
export async function translateTitle(title: string): Promise<string> {
  // Step 1 — local normalization (free, instant)
  const preprocessed = preprocessTitle(title);

  // Step 2 — check if significant CJK remains
  const cjk = (preprocessed.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;

  if (cjk > 0 && cjk / preprocessed.length >= 0.3) {
    // Still has substantial CJK — hand off to AI
    const translated = await grokText(
      `Translate this product title to English. Reply with only the translated title, nothing else.\n\n"${preprocessed}"`
    );
    // Run abbreviation expansion on the AI output too
    return expandAbbreviations(translated || preprocessed);
  }

  // Already clean — no API call needed
  return preprocessed;
}

/**
 * Generate a 2-sentence product description for a WooCommerce listing.
 */
export async function generateDescription(
  productName: string,
  categoryPath: string[]
): Promise<string> {
  const category = categoryPath.length > 0 ? categoryPath.join(' > ') : null;

  return grokText(
    `Write a 2-sentence product description for a WooCommerce store listing.
Product name: ${productName}${category ? `\nCategory: ${category}` : ''}
Keep it concise, factual, and suitable for a fashion/sneaker/accessories store.
Reply with only the description, no quotes, no labels.`
  );
}

/**
 * Batch: translate + generate descriptions for multiple products in one API call.
 * Returns array in same order as input.
 *
 * All titles are pre-processed locally before being sent to the AI,
 * which reduces token usage and improves translation accuracy.
 */
export async function batchEnrich(
  products: { name: string; categoryPath: string[] }[]
): Promise<{ translatedName: string; description: string }[]> {
  if (products.length === 0) return [];

  // Pre-process all titles locally before sending to AI
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

  const prompt = `For each product below, return a JSON array where each element has:
- "translatedName": the product name in English (translate any remaining Chinese if needed, otherwise keep as-is)
- "description": a 2-sentence English product description for a WooCommerce store

Products:
${lines}

Reply with ONLY a valid JSON array, no markdown, no explanation. Example:
[{"translatedName":"Nike Air Max 90","description":"The Nike Air Max 90 is a classic running shoe..."}]`;

  const raw = await grokText(prompt);

  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(clean) as { translatedName: string; description: string }[];
    if (Array.isArray(parsed) && parsed.length === preprocessed.length) {
      // Run abbreviation expansion on AI-returned names too
      return parsed.map((item) => ({
        ...item,
        translatedName: expandAbbreviations(item.translatedName),
      }));
    }
  } catch {
    // fall through to per-item fallback
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