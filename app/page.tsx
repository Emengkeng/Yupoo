'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './page.module.css';

// ── Types ─────────────────────────────────────────────────────────────────

interface ScrapedAlbum {
  title: string;
  albumId: string;
  storeSlug: string;
  albumUrl: string;
  category: string | null;
  images: string[];
  totalPages: number;
}

interface WcCategory {
  id: number;
  name: string;
  slug: string;
  parent: number;
}

interface LogEntry {
  id: number;
  message: string;
  level: 'info' | 'success' | 'error' | 'warn';
  ts: number;
}

type QueueStatus = 'pending' | 'scraping' | 'ready' | 'importing' | 'done' | 'failed';

interface QueueItem {
  id: string;
  url: string;
  status: QueueStatus;
  productName?: string;
  error?: string;
}

const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

const CATEGORY_TREE: Record<string, Record<string, string[]>> = {
  Men: {
    Bags: [],
    Belts: [],
    'Football Boots': [],
    Glasses: ['Gucci', 'LV'],
    Sneakers: [],
    'T-Shirts': ['Balenciaga', 'Dior', 'Fendi', 'Givenchy', 'Gucci', 'LV'],
  },
  Women: {
    Bags: [],
    Belts: [],
    Glasses: ['Gucci', 'LV'],
    Sneakers: [],
    'T-Shirts': ['Balenciaga', 'Dior', 'Fendi', 'Givenchy', 'Gucci', 'LV'],
  },
};

// ── Main Component ────────────────────────────────────────────────────────

export default function Home() {
  // ── Queue state ──────────────────────────────────────────────────────────
  const [queueInput, setQueueInput] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [showQueueInput, setShowQueueInput] = useState(true);

  // Scraping state
  const [scraping, setScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState('');
  const [album, setAlbum] = useState<ScrapedAlbum | null>(null);

  // Edit state
  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [sizeType, setSizeType] = useState<'sneaker' | 'tshirt' | 'none'>('sneaker');
  const [sneakerRange, setSneakerRange] = useState('');
  const [tshirtSizes, setTshirtSizes] = useState<Set<string>>(new Set());

  // Category state
  const [quickGender, setQuickGender] = useState('');
  const [quickSub, setQuickSub] = useState('');
  const [quickBrand, setQuickBrand] = useState('');
  const [customCat, setCustomCat] = useState('');
  const [categoryPaths, setCategoryPaths] = useState<string[][]>([]);

  // Import state
  const [importing, setImporting] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [importDone, setImportDone] = useState<{
    productId: number;
    productUrl: string;
    status: string;
    variationsCreated: number;
  } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const logCounter = useRef(0);

  // Product type + status
  const [productType, setProductType] = useState<'simple' | 'variable'>('simple');
  const [productStatus, setProductStatus] = useState<'draft' | 'publish'>('draft');

  // Variable product
  const [variationAttribute, setVariationAttribute] = useState('');
  const [variations, setVariations] = useState<{ id: string; value: string; imageUrl: string | null }[]>([]);
  const [pickerOpenForId, setPickerOpenForId] = useState<string | null>(null);
  const [regularPrice, setRegularPrice] = useState('');

  // Sneaker range for variable size
  const [varSneakerRange, setVarSneakerRange] = useState('');

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs((prev) => [...prev, { id: ++logCounter.current, message, level, ts: Date.now() }]);
  }, []);

  // ── Queue helpers ─────────────────────────────────────────────────────────

  function buildQueue() {
    const urls = queueInput
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    const items: QueueItem[] = urls.map((url) => ({
      id: Math.random().toString(36).slice(2),
      url,
      status: 'pending',
    }));
    setQueue(items);
    setCurrentIndex(null);
    setAlbum(null);
    setImportDone(null);
    setLogs([]);
    setShowQueueInput(false);
  }

  function updateQueueStatus(index: number, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  // Captures current "carry-over" settings (everything except name, images, variations)
  function captureSettings() {
    return {
      categoryPaths,
      regularPrice,
      sizeType,
      sneakerRange,
      tshirtSizes: new Set(tshirtSizes),
      productType,
      productStatus,
      variationAttribute,
    };
  }

  async function scrapeIndex(index: number) {
    const item = queue[index];
    if (!item) return;

    setScraping(true);
    setScrapeError('');
    setAlbum(null);
    setImportDone(null);
    setLogs([]);
    updateQueueStatus(index, { status: 'scraping' });

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setScrapeError(data.error || 'Scraping failed');
        updateQueueStatus(index, { status: 'failed', error: data.error || 'Scraping failed' });
        return;
      }

      const a: ScrapedAlbum = data.album;
      setAlbum(a);
      setProductName(a.title);
      setDescription('');
      setSelectedImages(new Set(a.images));
      setVariations([]);
      setPickerOpenForId(null);
      setVarSneakerRange('');

      // Prefill category from album if no category is set yet, otherwise keep existing
      if (categoryPaths.length === 0 && a.category) {
        setCategoryPaths([a.category.split('/').map((s) => s.trim()).filter(Boolean)]);
      }

      updateQueueStatus(index, { status: 'ready', productName: a.title });
      setCurrentIndex(index);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setScrapeError(msg);
      updateQueueStatus(index, { status: 'failed', error: msg });
    } finally {
      setScraping(false);
    }
  }

  async function startQueue() {
    buildQueue();
  }

  // Called after a successful import — advance to next pending item
  async function handleNext() {
    if (currentIndex === null) return;
    // Save current settings to carry over
    // (state already reflects current values, nothing to do)

    // Find next pending item
    const nextIndex = queue.findIndex((item, i) => i > currentIndex && item.status === 'pending');
    if (nextIndex === -1) return; // no more items

    await scrapeIndex(nextIndex);
  }

  // ── Category helpers ──────────────────────────────────────────────────────

  function buildCurrentPath(): string[] {
    if (customCat.trim()) {
      return customCat.split('/').map((s) => s.trim()).filter(Boolean);
    }
    const path: string[] = [];
    if (quickGender) path.push(quickGender);
    if (quickSub) path.push(quickSub);
    if (quickBrand) path.push(quickBrand);
    return path;
  }

  function addCurrentCategory() {
    const path = buildCurrentPath();
    if (path.length === 0) return;
    const key = path.join(' > ');
    if (categoryPaths.some((p) => p.join(' > ') === key)) return;
    setCategoryPaths((prev) => [...prev, path]);
    setQuickGender('');
    setQuickSub('');
    setQuickBrand('');
    setCustomCat('');
  }

  function removeCategory(index: number) {
    setCategoryPaths((prev) => prev.filter((_, i) => i !== index));
  }

  function proxyUrl(original: string, storeSlug: string) {
    const ref = encodeURIComponent(`https://${storeSlug}.x.yupoo.com`);
    return `/api/proxy-image?url=${encodeURIComponent(original)}&ref=${ref}`;
  }

  // ── Image selection ──────────────────────────────────────────────────────

  function toggleImage(url: string) {
    setSelectedImages((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  function selectAll() { if (album) setSelectedImages(new Set(album.images)); }
  function deselectAll() { setSelectedImages(new Set()); }

  // ── Variable size helpers ─────────────────────────────────────────────────

  function autoFillSneakerVariations() {
    const m = varSneakerRange.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (!m) return;
    const lo = parseInt(m[1]), hi = parseInt(m[2]);
    if (isNaN(lo) || isNaN(hi) || lo > hi || hi - lo > 60) return;
    const sizes = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
    setVariations(sizes.map((sz) => ({
      id: Math.random().toString(36).slice(2),
      value: sz,
      imageUrl: null,
    })));
  }

  function autoFillTshirtVariations() {
    setVariations(TSHIRT_SIZES.map((sz) => ({
      id: Math.random().toString(36).slice(2),
      value: sz,
      imageUrl: null,
    })));
  }

  function sneakerPreview(raw: string): string {
    const m = raw.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (m) {
      const lo = parseInt(m[1]), hi = parseInt(m[2]);
      if (!isNaN(lo) && !isNaN(hi) && lo <= hi && hi - lo <= 60) {
        return `${lo}, ${lo + 1}, … ${hi}  (${hi - lo + 1} sizes)`;
      }
    }
    return raw.trim() ? raw.trim() : '';
  }

  // ── Variation helpers ─────────────────────────────────────────────────────

  function addVariation() {
    setVariations((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), value: '', imageUrl: null },
    ]);
  }

  function removeVariation(id: string) {
    setVariations((prev) => prev.filter((v) => v.id !== id));
  }

  function updateVariation(id: string, patch: Partial<{ value: string; imageUrl: string | null }>) {
    setVariations((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }

  // ── Import ────────────────────────────────────────────────────────────────

  async function handleImport() {
    if (!album || !productName.trim() || selectedImages.size === 0) return;
    if (currentIndex !== null) updateQueueStatus(currentIndex, { status: 'importing' });

    setImporting(true);
    setLogs([]);
    setImportDone(null);

    const payload = {
      album: {
        albumId: album.albumId,
        storeSlug: album.storeSlug,
        albumUrl: album.albumUrl,
        selectedImages: Array.from(selectedImages),
      },
      product: {
        name: productName,
        description,
        categoryPaths,
        productType,
        variationAttribute,
        variations: variations.map((v) => ({ value: v.value, imageUrl: v.imageUrl })),
        sizeType,
        sneakerSizeRange: sneakerRange,
        tshirtSizes: Array.from(tshirtSizes),
        status: productStatus,
        regularPrice,
      },
    };

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.body) throw new Error('No response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'log') {
              addLog(event.message, event.level);
            } else if (event.type === 'done') {
              setImportDone({
                productId: event.productId,
                productUrl: event.productUrl,
                status: event.status,
                variationsCreated: event.variationsCreated ?? 0,
              });
              if (currentIndex !== null) {
                updateQueueStatus(currentIndex, { status: 'done', productName });
              }
            } else if (event.type === 'error') {
              addLog(event.message, 'error');
              if (currentIndex !== null) {
                updateQueueStatus(currentIndex, { status: 'failed', error: event.message });
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      addLog(err instanceof Error ? err.message : 'Import failed', 'error');
      if (currentIndex !== null) {
        updateQueueStatus(currentIndex, { status: 'failed' });
      }
    } finally {
      setImporting(false);
    }
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const pendingAfterCurrent = currentIndex !== null
    ? queue.filter((item, i) => i > currentIndex && item.status === 'pending').length
    : 0;

  const queueTotal = queue.length;
  const queueDone = queue.filter((i) => i.status === 'done').length;
  const isLastItem = pendingAfterCurrent === 0 && currentIndex !== null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <span className={styles.logoDot} />
            Yupoo Importer
          </div>
          <div className={styles.headerMeta}>
            {queueTotal > 0 && (
              <span className={styles.queueProgress}>
                {queueDone}/{queueTotal} done
              </span>
            )}
            <span className={styles.pill}>WooCommerce</span>
          </div>
        </div>
      </header>

      <main className={styles.main}>

        {/* ── Queue Input ── */}
        {showQueueInput ? (
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.stepNum}>01</span>
              <h2 className={styles.cardTitle}>Album URLs</h2>
            </div>
            <div className={styles.fieldGroup}>
              <label>Paste one URL per line</label>
              <textarea
                value={queueInput}
                onChange={(e) => setQueueInput(e.target.value)}
                placeholder={`https://storename.x.yupoo.com/albums/111111\nhttps://storename.x.yupoo.com/albums/222222\nhttps://storename.x.yupoo.com/albums/333333`}
                rows={5}
              />
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                className={styles.btnPrimary}
                onClick={startQueue}
                disabled={!queueInput.trim()}
              >
                Start Queue ({queueInput.split('\n').filter((l) => l.trim()).length} URLs)
              </button>
            </div>
            <p className={styles.hint} style={{ marginTop: 10 }}>
              You'll review and import each product one at a time. Supports: <code>storename.x.yupoo.com/albums/ID</code>
            </p>
          </section>
        ) : (
          /* ── Queue status bar ── */
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.stepNum}>01</span>
              <h2 className={styles.cardTitle}>Queue</h2>
              <button
                className={styles.btnGhost}
                style={{ marginLeft: 'auto' }}
                onClick={() => { setShowQueueInput(true); setQueue([]); setCurrentIndex(null); setAlbum(null); }}
              >
                ✕ Reset
              </button>
            </div>
            <div className={styles.queueList}>
              {queue.map((item, i) => (
                <div
                  key={item.id}
                  className={`${styles.queueItem} ${
                    i === currentIndex ? styles.queueItemActive :
                    item.status === 'done' ? styles.queueItemDone :
                    item.status === 'failed' ? styles.queueItemFailed : ''
                  }`}
                >
                  <span className={styles.queueNum}>{i + 1}</span>
                  <span className={styles.queueUrl}>{item.url}</span>
                  <span className={styles.queueStatusBadge} data-status={item.status}>
                    {item.status === 'pending' && '⋯'}
                    {item.status === 'scraping' && '↻'}
                    {item.status === 'ready' && '✎'}
                    {item.status === 'importing' && '↑'}
                    {item.status === 'done' && '✓'}
                    {item.status === 'failed' && '✗'}
                  </span>
                </div>
              ))}
            </div>

            {/* Scrape first item if queue was just built and nothing is current */}
            {currentIndex === null && queue.length > 0 && (
              <button
                className={styles.btnPrimary}
                style={{ marginTop: 12 }}
                onClick={() => scrapeIndex(0)}
                disabled={scraping}
              >
                {scraping ? <><span className={styles.spinner} /> Scraping…</> : 'Start → Scrape First Product'}
              </button>
            )}
          </section>
        )}

        {/* ── Scrape error ── */}
        {scrapeError && (
          <div className={styles.errorBox}>
            <span className={styles.errorIcon}>⚠</span>
            <pre className={styles.errorText}>{scrapeError}</pre>
          </div>
        )}

        {/* ── Edit Panel ── */}
        {album && (
          <>
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.stepNum}>02</span>
                <h2 className={styles.cardTitle}>Product Details</h2>
                <span className={styles.albumBadge}>{album.storeSlug} / {album.albumId}</span>
              </div>

              <div className={styles.fieldGrid}>
                <div className={styles.fieldGroup}>
                  <label>Product Name</label>
                  <input
                    type="text"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="e.g. Nike Air Max 90"
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label>Description (optional)</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Product description…"
                    rows={3}
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label>Price (optional)</label>
                  <input
                    type="number"
                    value={regularPrice}
                    onChange={(e) => setRegularPrice(e.target.value)}
                    placeholder="e.g. 89.99"
                    min="0"
                    step="0.01"
                  />
                </div>
              </div>

              {/* Category */}
              <div className={styles.fieldSection}>
                <label>Category</label>

                {categoryPaths.length > 0 && (
                  <div className={styles.catSelected}>
                    {categoryPaths.map((path, i) => (
                      <span key={i} className={styles.catSelectedTag}>
                        {path.join(' › ')}
                        <button className={styles.catRemoveBtn} onClick={() => removeCategory(i)} title="Remove">✕</button>
                      </span>
                    ))}
                  </div>
                )}

                <div className={styles.catPickerRow} style={{ marginTop: categoryPaths.length ? 10 : 0 }}>
                  {Object.keys(CATEGORY_TREE).map((gender) => (
                    <button
                      key={gender}
                      className={`${styles.catChip} ${quickGender === gender && !customCat.trim() ? styles.catChipActive : ''}`}
                      onClick={() => { setQuickGender(gender); setQuickSub(''); setQuickBrand(''); setCustomCat(''); }}
                    >
                      {gender === 'Men' ? '♂' : '♀'} {gender}
                    </button>
                  ))}
                  <button className={styles.catChip} onClick={() => { setQuickGender(''); setQuickSub(''); setQuickBrand(''); setCustomCat(''); }}>
                    ✕ Clear
                  </button>
                </div>

                {quickGender && !customCat.trim() && (
                  <div className={styles.catPickerRow} style={{ marginTop: 8 }}>
                    {Object.keys(CATEGORY_TREE[quickGender]).map((sub) => (
                      <button
                        key={sub}
                        className={`${styles.catChip} ${quickSub === sub ? styles.catChipActive : ''}`}
                        onClick={() => { setQuickSub(sub); setQuickBrand(''); }}
                      >
                        {sub}
                      </button>
                    ))}
                  </div>
                )}

                {quickGender && quickSub && !customCat.trim() && CATEGORY_TREE[quickGender][quickSub]?.length > 0 && (
                  <div className={styles.catPickerRow} style={{ marginTop: 8 }}>
                    <button className={`${styles.catChip} ${!quickBrand ? styles.catChipActive : ''}`} onClick={() => setQuickBrand('')}>All brands</button>
                    {CATEGORY_TREE[quickGender][quickSub].map((brand) => (
                      <button
                        key={brand}
                        className={`${styles.catChip} ${quickBrand === brand ? styles.catChipActive : ''}`}
                        onClick={() => setQuickBrand(brand)}
                      >
                        {brand}
                      </button>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 10 }}>
                  <label>Or type custom path (use / for hierarchy)</label>
                  <input
                    type="text"
                    value={customCat}
                    onChange={(e) => { setCustomCat(e.target.value); if (e.target.value.trim()) { setQuickGender(''); setQuickSub(''); setQuickBrand(''); } }}
                    placeholder="e.g. Men / Sneakers / Nike"
                    onKeyDown={(e) => e.key === 'Enter' && addCurrentCategory()}
                  />
                </div>

                {buildCurrentPath().length > 0 && (
                  <div className={styles.catAddRow}>
                    <span className={styles.catPreview}>{buildCurrentPath().join(' › ')}</span>
                    <button className={styles.catAddBtn} onClick={addCurrentCategory}>+ Add category</button>
                  </div>
                )}
              </div>

              {/* Product Type */}
              <div className={styles.fieldSection}>
                <label>Product Type</label>
                <div className={styles.sizeToggle}>
                  {(['simple', 'variable'] as const).map((t) => (
                    <button
                      key={t}
                      className={`${styles.sizeBtn} ${productType === t ? styles.sizeBtnActive : ''}`}
                      onClick={() => setProductType(t)}
                    >
                      {t === 'simple' ? '📦 Simple' : '🎨 Variable'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Variable product */}
              {productType === 'variable' && (
                <div className={styles.fieldSection}>
                  <div className={styles.fieldGroup}>
                    <label>Variation attribute name (e.g. Color, Size, Style)</label>
                    <input
                      type="text"
                      value={variationAttribute}
                      onChange={(e) => setVariationAttribute(e.target.value)}
                      placeholder="Color"
                    />
                  </div>

                  {/* Size quick-fill — shown when attribute looks like "Size" */}
                  {variationAttribute.trim().toLowerCase() === 'size' && (
                    <div className={styles.sizeQuickFill}>
                      <span className={styles.sizeQuickLabel}>Quick fill sizes:</span>

                      {/* Sneaker range */}
                      <div className={styles.sizeQuickRow}>
                        <input
                          type="text"
                          className={styles.sizeQuickInput}
                          value={varSneakerRange}
                          onChange={(e) => setVarSneakerRange(e.target.value)}
                          placeholder="e.g. 36-46"
                        />
                        <button
                          className={styles.sizeQuickBtn}
                          onClick={autoFillSneakerVariations}
                          disabled={!varSneakerRange.trim().match(/^\d+\s*[-–—]\s*\d+$/)}
                        >
                          👟 Fill Sneaker Sizes
                        </button>
                      </div>
                      {sneakerPreview(varSneakerRange) && (
                        <div className={styles.sizePreview}>{sneakerPreview(varSneakerRange)}</div>
                      )}

                      {/* T-shirt sizes */}
                      <div className={styles.sizeQuickRow} style={{ marginTop: 8 }}>
                        <button className={styles.sizeQuickBtn} onClick={autoFillTshirtVariations}>
                          👕 Fill T-Shirt Sizes (XS → XXXL)
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: 12 }}>
                    <label>Variations {variations.length > 0 && `(${variations.length})`}</label>
                    {variations.map((v) => (
                      <div key={v.id} className={styles.variationRow}>
                        <input
                          type="text"
                          className={styles.variationInput}
                          value={v.value}
                          onChange={(e) => updateVariation(v.id, { value: e.target.value })}
                          placeholder="e.g. Red, 42, XL…"
                        />

                        <button
                          className={`${styles.varImgBtn} ${v.imageUrl ? styles.varImgBtnSet : ''}`}
                          onClick={() => setPickerOpenForId(pickerOpenForId === v.id ? null : v.id)}
                          title="Pick representative image"
                        >
                          {v.imageUrl ? (
                            <img
                              src={`/api/proxy-image?url=${encodeURIComponent(v.imageUrl)}&ref=${encodeURIComponent(`https://${album!.storeSlug}.x.yupoo.com`)}`}
                              alt="variation"
                              className={styles.varImgPreview}
                            />
                          ) : '🖼'}
                        </button>

                        <button className={styles.btnGhost} onClick={() => removeVariation(v.id)} title="Remove">✕</button>

                        {pickerOpenForId === v.id && (
                          <div className={styles.varPickerGrid}>
                            <button
                              className={`${styles.varPickerThumb} ${!v.imageUrl ? styles.varPickerThumbActive : ''}`}
                              onClick={() => { updateVariation(v.id, { imageUrl: null }); setPickerOpenForId(null); }}
                            >
                              None
                            </button>
                            {album!.images.map((img, i) => (
                              <button
                                key={i}
                                className={`${styles.varPickerThumb} ${v.imageUrl === img ? styles.varPickerThumbActive : ''}`}
                                onClick={() => { updateVariation(v.id, { imageUrl: img }); setPickerOpenForId(null); }}
                              >
                                <img
                                  src={`/api/proxy-image?url=${encodeURIComponent(img)}&ref=${encodeURIComponent(`https://${album!.storeSlug}.x.yupoo.com`)}`}
                                  alt={`img ${i + 1}`}
                                />
                                <span>{i + 1}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}

                    <button className={styles.btnGhost} style={{ marginTop: 8 }} onClick={addVariation}>
                      + Add variation manually
                    </button>

                    {variations.length > 0 && (
                      <p className={styles.hint} style={{ marginTop: 8 }}>
                        Each variation gets one representative image. All selected images go to the parent product gallery.
                        Price from the field above is applied to every variation.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Size — simple products only */}
              {productType === 'simple' && (
                <div className={styles.fieldSection}>
                  <label>Size</label>
                  <div className={styles.sizeToggle}>
                    {(['sneaker', 'tshirt', 'none'] as const).map((t) => (
                      <button
                        key={t}
                        className={`${styles.sizeBtn} ${sizeType === t ? styles.sizeBtnActive : ''}`}
                        onClick={() => setSizeType(t)}
                      >
                        {t === 'sneaker' ? '👟 Sneaker' : t === 'tshirt' ? '👕 T-Shirt' : '✕ None'}
                      </button>
                    ))}
                  </div>

                  {sizeType === 'sneaker' && (
                    <div style={{ marginTop: 8 }}>
                      <input
                        type="text"
                        value={sneakerRange}
                        onChange={(e) => setSneakerRange(e.target.value)}
                        placeholder="e.g. 36-46 or 40"
                      />
                      {sneakerPreview(sneakerRange) && (
                        <div className={styles.sizePreview}>{sneakerPreview(sneakerRange)}</div>
                      )}
                    </div>
                  )}

                  {sizeType === 'tshirt' && (
                    <div className={styles.tshirtGrid}>
                      {TSHIRT_SIZES.map((sz) => (
                        <button
                          key={sz}
                          className={`${styles.tshirtChip} ${tshirtSizes.has(sz) ? styles.tshirtChipActive : ''}`}
                          onClick={() => {
                            setTshirtSizes((prev) => {
                              const next = new Set(prev);
                              if (next.has(sz)) next.delete(sz); else next.add(sz);
                              return next;
                            });
                          }}
                        >
                          {sz}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* ── Image Grid ── */}
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.stepNum}>03</span>
                <h2 className={styles.cardTitle}>Images</h2>
                <span className={styles.albumBadge}>
                  {selectedImages.size}/{album.images.length} selected
                </span>
                <div className={styles.imgActions}>
                  <button className={styles.btnGhost} onClick={selectAll}>All</button>
                  <button className={styles.btnGhost} onClick={deselectAll}>None</button>
                </div>
              </div>

              <div className={styles.imageGrid}>
                {album.images.map((img, i) => {
                  const selected = selectedImages.has(img);
                  return (
                    <button
                      key={i}
                      className={`${styles.imgThumb} ${selected ? styles.imgThumbSelected : styles.imgThumbDeselected}`}
                      onClick={() => toggleImage(img)}
                      title={selected ? 'Click to deselect' : 'Click to select'}
                    >
                      <img
                        src={proxyUrl(img, album.storeSlug)}
                        alt={`Image ${i + 1}`}
                        loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
                      />
                      <div className={styles.imgOverlay}>
                        {selected ? <span className={styles.imgCheck}>✓</span> : <span className={styles.imgX}>✕</span>}
                      </div>
                      <div className={styles.imgNum}>{i + 1}</div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ── Import ── */}
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.stepNum}>04</span>
                <h2 className={styles.cardTitle}>Import to WooCommerce</h2>
              </div>

              <div className={styles.importSummary}>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>Product</span>
                  <span className={styles.summaryValue}>{productName || <em style={{ opacity: 0.4 }}>unnamed</em>}</span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>Images</span>
                  <span className={styles.summaryValue}>{selectedImages.size}</span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>Category</span>
                  <span className={styles.summaryValue}>
                    {categoryPaths.length > 0
                      ? categoryPaths.map((p) => p.join(' › ')).join(', ')
                      : <em style={{ opacity: 0.4 }}>none</em>}
                  </span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>Status</span>
                  <span className={`${styles.summaryValue} ${productStatus === 'publish' ? styles.liveValue : styles.draftBadge}`}>
                    {productStatus === 'publish' ? 'Live' : 'Draft'}
                  </span>
                </div>
                {regularPrice && (
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Price</span>
                    <span className={styles.summaryValue}>{regularPrice}</span>
                  </div>
                )}
                {productType === 'variable' && variations.length > 0 && (
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>Variations</span>
                    <span className={styles.summaryValue}>{variations.filter(v => v.value.trim()).length}</span>
                  </div>
                )}
              </div>

              <div className={styles.statusRow}>
                <span className={styles.statusLabel}>Publish as:</span>
                {(['draft', 'publish'] as const).map((s) => (
                  <button
                    key={s}
                    className={`${styles.statusBtn} ${productStatus === s ? (s === 'publish' ? styles.statusBtnLive : styles.statusBtnDraft) : ''}`}
                    onClick={() => setProductStatus(s)}
                  >
                    {s === 'draft' ? '⏸ Draft' : '🟢 Live'}
                  </button>
                ))}
              </div>

              <button
                className={styles.btnImport}
                onClick={handleImport}
                disabled={importing || !productName.trim() || selectedImages.size === 0}
              >
                {importing
                  ? <><span className={styles.spinner} /> Importing…</>
                  : `Import ${selectedImages.size} image${selectedImages.size !== 1 ? 's' : ''} as ${productStatus === 'publish' ? 'Live' : 'Draft'}`}
              </button>

              {logs.length > 0 && (
                <div className={styles.logBox} ref={logRef}>
                  {logs.map((log) => (
                    <div key={log.id} className={`${styles.logLine} ${styles[`log_${log.level}`]}`}>
                      <span className={styles.logIcon}>
                        {log.level === 'success' ? '✓' : log.level === 'error' ? '✗' : log.level === 'warn' ? '⚠' : '›'}
                      </span>
                      {log.message}
                    </div>
                  ))}
                </div>
              )}

              {importDone && (
                <div className={styles.successBox}>
                  <div className={styles.successTitle}>🎉 Product created!</div>
                  <p>
                    Created as a <strong>{importDone.status === 'publish' ? 'live product' : 'draft'}</strong>.
                    {importDone.status === 'draft' && ' Set your price and publish when ready.'}
                    {importDone.variationsCreated > 0 && ` ${importDone.variationsCreated} variation(s) created with price set.`}
                  </p>
                  <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                    <a href={importDone.productUrl} target="_blank" rel="noopener noreferrer" className={styles.btnSuccess}>
                      Open in WordPress →
                    </a>
                    {!isLastItem && (
                      <button
                        className={styles.btnNext}
                        onClick={handleNext}
                        disabled={scraping}
                      >
                        {scraping
                          ? <><span className={styles.spinnerDark} /> Scraping next…</>
                          : `Next Product → (${pendingAfterCurrent} remaining)`}
                      </button>
                    )}
                    {isLastItem && queueTotal > 1 && (
                      <span className={styles.allDoneBadge}>🏁 All products done!</span>
                    )}
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}