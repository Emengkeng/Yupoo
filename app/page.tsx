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

const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

// ── Main Component ────────────────────────────────────────────────────────

export default function Home() {
  // Input
  const [albumUrl, setAlbumUrl] = useState('');

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
  const [wcCategories, setWcCategories] = useState<WcCategory[]>([]);
  const [catL1, setCatL1] = useState('');
  const [catL2, setCatL2] = useState('');
  const [catL3, setCatL3] = useState('');
  const [customCat, setCustomCat] = useState('');

  // Import state
  const [importing, setImporting] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [importDone, setImportDone] = useState<{ productId: number; productUrl: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const logCounter = useRef(0);

  // Load WC categories on mount
  useEffect(() => {
    fetch('/api/wc-categories')
      .then((r) => r.json())
      .then((d) => { if (d.categories) setWcCategories(d.categories); })
      .catch(() => {});
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs((prev) => [...prev, { id: ++logCounter.current, message, level, ts: Date.now() }]);
  }, []);

  // ── Derived category data ────────────────────────────────────────────────
  const rootCats = wcCategories.filter((c) => c.parent === 0);
  const l2Cats = catL1
    ? wcCategories.filter((c) => c.parent === parseInt(catL1))
    : [];
  const l3Cats = catL2
    ? wcCategories.filter((c) => c.parent === parseInt(catL2))
    : [];

  function buildCategoryPath(): string[] {
    const path: string[] = [];

    if (catL1) {
      const l1 = rootCats.find((c) => String(c.id) === catL1);
      if (l1) path.push(l1.name);
    }
    if (catL2) {
      const l2 = l2Cats.find((c) => String(c.id) === catL2);
      if (l2) path.push(l2.name);
    }
    if (catL3) {
      const l3 = l3Cats.find((c) => String(c.id) === catL3);
      if (l3) path.push(l3.name);
    }
    if (customCat.trim()) {
      path.push(...customCat.split('/').map((s) => s.trim()).filter(Boolean));
    }

    return path;
  }

  // ── Scrape ───────────────────────────────────────────────────────────────
  async function handleScrape() {
    if (!albumUrl.trim()) return;
    setScraping(true);
    setScrapeError('');
    setAlbum(null);
    setImportDone(null);
    setLogs([]);

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: albumUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setScrapeError(data.error || 'Scraping failed');
        return;
      }

      const a: ScrapedAlbum = data.album;
      setAlbum(a);
      setProductName(a.title);
      setDescription('');
      setSelectedImages(new Set(a.images));

      // Pre-fill category from scraped data
      if (a.category) setCustomCat(a.category);

    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setScraping(false);
    }
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

  // ── Import ───────────────────────────────────────────────────────────────
  async function handleImport() {
    if (!album || !productName.trim() || selectedImages.size === 0) return;

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
        categoryPath: buildCategoryPath(),
        sizeType,
        sneakerSizeRange: sneakerRange,
        tshirtSizes: Array.from(tshirtSizes),
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
              setImportDone({ productId: event.productId, productUrl: event.productUrl });
            } else if (event.type === 'error') {
              addLog(event.message, 'error');
            }
          } catch {}
        }
      }
    } catch (err) {
      addLog(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
    }
  }

  // ── Sneaker size preview ─────────────────────────────────────────────────
  function sneakerPreview(raw: string): string {
    const m = raw.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (m) {
      const lo = parseInt(m[1]), hi = parseInt(m[2]);
      if (!isNaN(lo) && !isNaN(hi) && lo <= hi && hi - lo <= 60) {
        const count = hi - lo + 1;
        return `${lo}, ${lo + 1}, … ${hi}  (${count} sizes)`;
      }
    }
    return raw.trim() ? raw.trim() : '';
  }

  // ── Render ───────────────────────────────────────────────────────────────
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
            <span className={styles.pill}>WooCommerce</span>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {/* ── URL Input ── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.stepNum}>01</span>
            <h2 className={styles.cardTitle}>Album URL</h2>
          </div>
          <div className={styles.urlRow}>
            <input
              type="url"
              value={albumUrl}
              onChange={(e) => setAlbumUrl(e.target.value)}
              placeholder="https://storename.x.yupoo.com/albums/123456"
              onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
              disabled={scraping}
            />
            <button
              className={styles.btnPrimary}
              onClick={handleScrape}
              disabled={scraping || !albumUrl.trim()}
            >
              {scraping ? (
                <><span className={styles.spinner} /> Scraping…</>
              ) : 'Fetch Album'}
            </button>
          </div>
          {scrapeError && (
            <div className={styles.errorBox}>
              <span className={styles.errorIcon}>⚠</span>
              <pre className={styles.errorText}>{scrapeError}</pre>
            </div>
          )}
          <p className={styles.hint}>
            Supports: <code>storename.x.yupoo.com/albums/ID</code> or <code>x.yupoo.com/photos/storename/albums/ID</code>
          </p>
        </section>

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
              </div>

              {/* Category */}
              <div className={styles.fieldSection}>
                <label>Category</label>
                <div className={styles.catRow}>
                  <select
                    value={catL1}
                    onChange={(e) => { setCatL1(e.target.value); setCatL2(''); setCatL3(''); }}
                  >
                    <option value="">— root —</option>
                    {rootCats.map((c) => (
                      <option key={c.id} value={String(c.id)}>{c.name}</option>
                    ))}
                  </select>

                  {l2Cats.length > 0 && (
                    <select value={catL2} onChange={(e) => { setCatL2(e.target.value); setCatL3(''); }}>
                      <option value="">— level 2 —</option>
                      {l2Cats.map((c) => (
                        <option key={c.id} value={String(c.id)}>{c.name}</option>
                      ))}
                    </select>
                  )}

                  {l3Cats.length > 0 && (
                    <select value={catL3} onChange={(e) => setCatL3(e.target.value)}>
                      <option value="">— level 3 —</option>
                      {l3Cats.map((c) => (
                        <option key={c.id} value={String(c.id)}>{c.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                <div style={{ marginTop: 8 }}>
                  <label>Or type new category (use / for hierarchy, e.g. Sneakers/Nike)</label>
                  <input
                    type="text"
                    value={customCat}
                    onChange={(e) => setCustomCat(e.target.value)}
                    placeholder="Sneakers / Nike"
                  />
                </div>

                {buildCategoryPath().length > 0 && (
                  <div className={styles.catPreview}>
                    {buildCategoryPath().join(' › ')}
                  </div>
                )}
              </div>

              {/* Size */}
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
                            if (next.has(sz)) next.delete(sz);
                            else next.add(sz);
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
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img}
                        alt={`Image ${i + 1}`}
                        loading="lazy"
                        referrerPolicy="no-referrer"
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

              <p className={styles.hint} style={{ marginTop: 12 }}>
                Note: Images may appear broken in preview due to Yupoo's referer policy — they will download correctly during import.
              </p>
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
                    {buildCategoryPath().join(' › ') || <em style={{ opacity: 0.4 }}>none</em>}
                  </span>
                </div>
                <div className={styles.summaryItem}>
                  <span className={styles.summaryLabel}>Status</span>
                  <span className={`${styles.summaryValue} ${styles.draftBadge}`}>Draft</span>
                </div>
              </div>

              <button
                className={styles.btnImport}
                onClick={handleImport}
                disabled={importing || !productName.trim() || selectedImages.size === 0}
              >
                {importing ? (
                  <><span className={styles.spinner} /> Importing…</>
                ) : `Import ${selectedImages.size} image${selectedImages.size !== 1 ? 's' : ''} to WooCommerce`}
              </button>

              {/* Log output */}
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

              {/* Success state */}
              {importDone && (
                <div className={styles.successBox}>
                  <div className={styles.successTitle}>🎉 Product created!</div>
                  <p>The product has been created as a <strong>draft</strong> in WooCommerce. Set your price and publish when ready.</p>
                  <a
                    href={importDone.productUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.btnSuccess}
                  >
                    Open in WordPress →
                  </a>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
