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

// ── Chinese brand name lookup ─────────────────────────────────────────────
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
  '华伦天努':  'Valentino',
};

// ── Chinese product-grade / listing tags ──────────────────────────────────
export const CHINESE_PRODUCT_TAGS: Record<string, string> = {
  '原单': 'Original',
  '高仿': 'Replica',
  '正品': 'Authentic',
  '定制': 'Custom',
  '限量': 'Limited Edition',
};

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

// ── Master pre-processor ──────────────────────────────────────────────────
export function preprocessTitle(raw: string): string {
  let title = raw.trim();
  title = normalizeTokenOrder(title);
  title = expandChineseBrands(title);
  title = expandAbbreviations(title);
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
    return expandAbbreviations(translated || preprocessed);
  }

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