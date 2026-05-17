'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './page.module.css';

// ── Types ─────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'scraping' | 'scraped' | 'importing' | 'done' | 'failed';

interface JobRow {
  id: number;
  url: string;
  raw_name: string | null;
  raw_category: string | null;
  raw_price: string | null;
  status: JobStatus;
  error: string | null;
  created_at: string;
  album: {
    translated_name: string;
    album_id: string;
    store_slug: string;
    image_count: number;
  } | null;
  product: {
    wc_product_id: number;
    wc_product_url: string;
    images_uploaded: number;
    images_failed: number;
  } | null;
}

interface Stats {
  pending: number;
  scraping: number;
  scraped: number;
  importing: number;
  done: number;
  failed: number;
}

const STATUS_ORDER: JobStatus[] = ['pending', 'scraping', 'scraped', 'importing', 'done', 'failed'];

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Pending',
  scraping: 'Scraping',
  scraped: 'Scraped',
  importing: 'Importing',
  done: 'Done',
  failed: 'Failed',
};

const STATUS_ICON: Record<JobStatus, string> = {
  pending: '○',
  scraping: '◌',
  scraped: '◎',
  importing: '↑',
  done: '✓',
  failed: '✗',
};

// ── Helpers ───────────────────────────────────────────────────────────────

function parseSampleLines(input: string): number {
  return input.split('\n').filter((l) => l.trim()).length;
}

// ── Main Component ────────────────────────────────────────────────────────

export default function BatchPage() {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    queued: number;
    invalid: number;
    invalidLines: string[];
  } | null>(null);
  const [submitError, setSubmitError] = useState('');

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filterStatus, setFilterStatus] = useState<JobStatus | 'all'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [retrying, setRetrying] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasActiveJobs = stats
    ? stats.pending + stats.scraping + stats.scraped + stats.importing > 0
    : false;

  // ── Polling ───────────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/batch/status');
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data.jobs ?? []);
      setStats(data.stats ?? null);
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const interval = hasActiveJobs ? 2000 : 8000;
    pollRef.current = setInterval(fetchStatus, interval);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [hasActiveJobs, fetchStatus]);

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!input.trim()) return;
    setSubmitting(true);
    setSubmitError('');
    setSubmitResult(null);

    try {
      const res = await fetch('/api/batch/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSubmitError(data.error || 'Submit failed');
        return;
      }
      setSubmitResult(data);
      setInput('');
      await fetchStatus();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Retry ─────────────────────────────────────────────────────────────────

  async function handleRetry() {
    const ids = Array.from(selectedIds).length > 0
      ? Array.from(selectedIds)
      : jobs.filter((j) => j.status === 'failed').map((j) => j.id);
    if (ids.length === 0) return;

    setRetrying(true);
    try {
      const res = await fetch('/api/batch/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds: ids }),
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedIds(new Set());
        await fetchStatus();
      }
    } finally {
      setRetrying(false);
    }
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllFailed() {
    const failed = jobs.filter((j) => j.status === 'failed').map((j) => j.id);
    setSelectedIds(new Set(failed));
  }

  // ── Filtered jobs ─────────────────────────────────────────────────────────

  const filtered = filterStatus === 'all'
    ? jobs
    : jobs.filter((j) => j.status === filterStatus);

  const urlCount = parseSampleLines(input);
  const totalDone = stats?.done ?? 0;
  const totalJobs = jobs.length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.logo}>
            <div className={styles.logoPulse} />
            Yupoo <span className={styles.logoDim}>Batch Importer</span>
          </div>
          {stats && totalJobs > 0 && (
            <div className={styles.headerStats}>
              {STATUS_ORDER.map((s) => (stats[s] > 0 || s === 'done') && (
                <span key={s} className={`${styles.statPill} ${styles[`stat_${s}`]}`}>
                  {stats[s]} {s}
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className={styles.main}>

        {/* ── Input Card ── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.stepBadge}>01</div>
            <h2 className={styles.cardTitle}>Add URLs</h2>
          </div>

          <div className={styles.formatHint}>
            <code>URL</code>
            <span className={styles.sep}>·</span>
            <code>URL | Name</code>
            <span className={styles.sep}>·</span>
            <code>URL | Category/Sub</code>
            <span className={styles.sep}>·</span>
            <code>URL | Name | Category/Sub | Price</code>
            <span className={styles.sep}>·</span>
            <code>URL | Category/Sub | Price</code>
          </div>
          <div className={styles.formatRules}>
            <span>Field 2 is auto-detected: <strong>contains /</strong> → category, <strong>no /</strong> → name.</span>
            <span>Name and description are AI-generated when omitted.</span>
          </div>

          <textarea
            className={styles.urlInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              `https://store.x.yupoo.com/albums/123456\n` +
              `https://store.x.yupoo.com/albums/789012 | Boots\n` +
              `https://store.x.yupoo.com/albums/345678 | Men/Sneakers/Nike\n` +
              `https://store.x.yupoo.com/albums/901234 | Men/Sneakers/Nike | 89.99\n` +
              `https://store.x.yupoo.com/albums/111111 | Air Max 90 | Men/Sneakers/Nike | 120.00`
            }
            rows={8}
            spellCheck={false}
          />

          <div className={styles.submitRow}>
            <button
              className={styles.btnSubmit}
              onClick={handleSubmit}
              disabled={submitting || !input.trim()}
            >
              {submitting
                ? <><span className={styles.spinner} /> Queueing…</>
                : `Queue ${urlCount > 0 ? urlCount : ''} URL${urlCount !== 1 ? 's' : ''} →`}
            </button>
            {submitResult && (
              <span className={styles.submitSuccess}>
                ✓ {submitResult.queued} job{submitResult.queued !== 1 ? 's' : ''} queued
                {submitResult.invalid > 0 && ` · ${submitResult.invalid} invalid`}
              </span>
            )}
            {submitError && <span className={styles.submitError}>✗ {submitError}</span>}
          </div>

          {submitResult?.invalidLines && submitResult.invalidLines.length > 0 && (
            <div className={styles.invalidList}>
              <strong>Invalid URLs skipped:</strong>
              {submitResult.invalidLines.map((l, i) => (
                <code key={i}>{l}</code>
              ))}
            </div>
          )}
        </section>

        {/* ── Progress Overview ── */}
        {stats && totalJobs > 0 && (
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div className={styles.stepBadge}>02</div>
              <h2 className={styles.cardTitle}>Progress</h2>
              <span className={styles.progressSummary}>
                {totalDone} / {totalJobs} done
              </span>
              {hasActiveJobs && <span className={styles.liveDot} title="Live" />}
            </div>

            {/* Progress bar */}
            <div className={styles.progressBar}>
              {STATUS_ORDER.map((s) => {
                const count = stats[s];
                if (count === 0) return null;
                const pct = (count / totalJobs) * 100;
                return (
                  <div
                    key={s}
                    className={`${styles.progressSegment} ${styles[`seg_${s}`]}`}
                    style={{ width: `${pct}%` }}
                    title={`${count} ${s}`}
                  />
                );
              })}
            </div>

            {/* Stat pills */}
            <div className={styles.statGrid}>
              {STATUS_ORDER.map((s) => (
                <button
                  key={s}
                  className={`${styles.statCard} ${filterStatus === s ? styles.statCardActive : ''} ${styles[`statCard_${s}`]}`}
                  onClick={() => setFilterStatus(filterStatus === s ? 'all' : s)}
                >
                  <span className={styles.statCount}>{stats[s]}</span>
                  <span className={styles.statLabel}>{STATUS_LABEL[s]}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ── Job Table ── */}
        {jobs.length > 0 && (
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div className={styles.stepBadge}>03</div>
              <h2 className={styles.cardTitle}>
                Jobs
                {filterStatus !== 'all' && (
                  <span className={styles.filterTag}>
                    {STATUS_LABEL[filterStatus]}
                    <button className={styles.clearFilter} onClick={() => setFilterStatus('all')}>✕</button>
                  </span>
                )}
              </h2>
              <div className={styles.tableActions}>
                {stats?.failed && stats.failed > 0 ? (
                  <>
                    <button className={styles.btnGhost} onClick={selectAllFailed}>
                      Select failed
                    </button>
                    <button
                      className={styles.btnRetry}
                      onClick={handleRetry}
                      disabled={retrying}
                    >
                      {retrying ? 'Retrying…' : `↺ Retry${selectedIds.size > 0 ? ` (${selectedIds.size})` : ' all failed'}`}
                    </button>
                  </>
                ) : null}
                <button className={styles.btnGhost} onClick={fetchStatus}>↻ Refresh</button>
              </div>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.thCheck} />
                    <th>#</th>
                    <th>Product</th>
                    <th>Status</th>
                    <th>Price</th>
                    <th>Images</th>
                    <th>WC</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((job) => (
                    <tr
                      key={job.id}
                      className={`${styles.tr} ${styles[`tr_${job.status}`]} ${selectedIds.has(job.id) ? styles.trSelected : ''}`}
                      onClick={() => toggleSelect(job.id)}
                    >
                      <td className={styles.tdCheck}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(job.id)}
                          onChange={() => {}}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className={styles.tdId}>{job.id}</td>
                      <td className={styles.tdName}>
                        <div className={styles.nameMain}>
                          {job.album?.translated_name || job.raw_name || '—'}
                        </div>
                        <div className={styles.nameSub}>
                          {job.url.replace('https://', '').slice(0, 60)}
                        </div>
                        {job.error && (
                          <div className={styles.errorText}>{job.error}</div>
                        )}
                      </td>
                      <td className={styles.tdStatus}>
                        <span className={`${styles.statusBadge} ${styles[`badge_${job.status}`]}`}>
                          <span className={styles.statusIcon}>{STATUS_ICON[job.status]}</span>
                          {STATUS_LABEL[job.status]}
                        </span>
                      </td>
                      <td className={styles.tdPrice}>
                        {job.raw_price ? `$${job.raw_price}` : <span style={{opacity:.3}}>—</span>}
                      </td>
                      <td className={styles.tdImages}>
                        {job.product
                          ? `${job.product.images_uploaded}${job.product.images_failed > 0 ? ` (${job.product.images_failed} failed)` : ''}`
                          : job.album?.image_count
                          ? job.album.image_count
                          : '—'}
                      </td>
                      <td className={styles.tdWc}>
                        {job.product ? (
                          <a
                            href={job.product.wc_product_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.wcLink}
                            onClick={(e) => e.stopPropagation()}
                          >
                            #{job.product.wc_product_id} →
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ── Empty state ── */}
        {jobs.length === 0 && !submitting && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>⬆</div>
            <p>Paste your Yupoo album URLs above and hit Queue to start.</p>
          </div>
        )}

      </main>
    </div>
  );
}