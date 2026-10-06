// Generic bulk runner. Core (`runBulk`) is DOM-free so it can be unit tested; `BulkPanel` renders progress.
import { el, clear, show, sleep, formatNumber } from './ui.js';
import { describeError } from './api.js';

export const READ_CONCURRENCY = 4;
export const WRITE_GAP_MS = 1000; // GitHub guidance: ≥1 s between mutating requests, strictly sequential.

function isAbort(err) { return err?.name === 'AbortError'; }
function isRateLimited(err) { return err?.isRateLimit === true || err?.code === 'rate_limited'; }

/**
 * Run `perItemFn(item, ctx)` over `items`.
 * opts: { concurrency=1, minGapMs=0, signal, maxRateRetries=3, onProgress(status), now(), sleep(ms, signal), itemKey(item) }
 * Returns { results: [{item, key, status: 'ok'|'failed'|'cancelled', value?, error?, attempts}], cancelled }
 * Mutating work must use concurrency 1 and minGapMs ≥ 1000 (see `writeOptions`).
 */
export async function runBulk(items, perItemFn, opts = {}) {
  const {
    concurrency = 1, minGapMs = 0, signal, maxRateRetries = 3, onProgress,
    now = () => Date.now(), sleep: sleepFn = sleep, itemKey = (it) => it?.id ?? it?.name ?? String(it),
  } = opts;
  const results = items.map((item) => ({ item, key: itemKey(item), status: 'queued', attempts: 0 }));
  let next = 0;
  let done = 0;
  let lastStart = -Infinity;
  let cancelled = false;
  const report = (extra = {}) => onProgress?.({ done, total: items.length, running: results.filter((r) => r.status === 'running').length, results, ...extra });

  async function worker() {
    while (true) {
      if (signal?.aborted) { cancelled = true; return; }
      const idx = next++;
      if (idx >= items.length) return;
      const r = results[idx];
      // Enforce the minimum gap between request starts (only meaningful when concurrency === 1).
      const wait = lastStart + minGapMs - now();
      if (wait > 0) {
        try { await sleepFn(wait, signal); } catch (err) { if (isAbort(err)) { r.status = 'cancelled'; cancelled = true; report(); return; } throw err; }
      }
      if (signal?.aborted) { r.status = 'cancelled'; cancelled = true; report(); return; }
      r.status = 'running';
      report();
      let rateRetries = 0;
      while (true) {
        lastStart = now();
        r.attempts += 1;
        try {
          r.value = await perItemFn(r.item, { signal, attempt: r.attempts });
          r.status = 'ok';
          break;
        } catch (err) {
          if (isAbort(err) || signal?.aborted) { r.status = 'cancelled'; cancelled = true; break; }
          if (isRateLimited(err) && rateRetries < maxRateRetries) {
            rateRetries += 1;
            const waitS = Math.min(Math.max(Number(err.retryAfter) || 5, 1), 120);
            r.status = 'waiting';
            r.error = `Rate limited – waiting ${waitS}s`;
            report({ rateWait: waitS });
            try { await sleepFn(waitS * 1000, signal); } catch (e) { if (isAbort(e)) { r.status = 'cancelled'; cancelled = true; break; } throw e; }
            r.status = 'running';
            continue;
          }
          r.status = 'failed';
          r.error = describeError(err);
          r.errorCode = err?.code || err?.name || 'error';
          break;
        }
      }
      if (r.status === 'cancelled') { report(); return; }
      done += 1;
      report();
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker);
  await Promise.all(workers);
  for (const r of results) if (r.status === 'queued' || r.status === 'running' || r.status === 'waiting') r.status = 'cancelled';
  return { results, cancelled };
}

export const writeOptions = (extra = {}) => ({ concurrency: 1, minGapMs: WRITE_GAP_MS, ...extra });
export const readOptions = (extra = {}) => ({ concurrency: READ_CONCURRENCY, minGapMs: 0, ...extra });

/** Build a JSON log (no secrets: only repo identifiers and error text). */
export function buildLog({ action, results, startedAt, finishedAt, cancelled }) {
  return {
    action,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    cancelled: !!cancelled,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'failed').length,
      cancelled: results.filter((r) => r.status === 'cancelled').length,
    },
    items: results.map((r) => ({
      key: r.key, label: labelOf(r.item), status: r.status, attempts: r.attempts, error: r.error ?? null, code: r.errorCode ?? null,
    })),
  };
}

export function labelOf(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  return item.label || item.full_name || item.name || String(item.id ?? '');
}

// --- UI panel -------------------------------------------------------------------------------

const STATUS_CLASS = {
  queued: 'text-slate-500', running: 'text-sky-300', waiting: 'text-amber-300',
  ok: 'text-emerald-300', failed: 'text-rose-300', cancelled: 'text-slate-400',
};
const STATUS_TEXT = { queued: 'queued', running: 'running…', waiting: 'waiting', ok: 'ok', failed: 'failed', cancelled: 'cancelled' };

/**
 * Progress panel. `runAction({ title, action, items, perItemFn, options, onItemOk, onFinish })` renders into `host`.
 */
export class BulkPanel {
  constructor(host) {
    this.host = host;
    this.controller = null;
  }

  async run({ title, action, items, perItemFn, options = {}, onItemOk, onFinish }) {
    const host = this.host;
    clear(host);
    show(host, true);
    this.controller = new AbortController();
    const { signal } = this.controller;
    const startedAt = Date.now();

    const bar = el('div', { class: 'progress-bar w-0' });
    const counter = el('span', { class: 'text-sm tabular-nums text-slate-300', text: `0 / ${formatNumber(items.length)}` });
    const status = el('span', { class: 'text-sm text-slate-400', text: 'Running…' });
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-ghost py-1.5', onClick: () => { this.controller?.abort(); status.textContent = 'Cancelling after current item…'; cancelBtn.disabled = true; } }, 'Cancel');
    const retryBtn = el('button', { type: 'button', class: 'btn btn-ghost py-1.5' }, 'Retry failed');
    const logBtn = el('button', { type: 'button', class: 'btn btn-ghost py-1.5' }, 'Download log (JSON)');
    const closeBtn = el('button', { type: 'button', class: 'btn btn-ghost py-1.5', 'aria-label': 'Close progress panel', onClick: () => { clear(host); show(host, false); } }, 'Close');
    show(retryBtn, false); show(logBtn, false); show(closeBtn, false);
    const list = el('ul', { class: 'max-h-64 divide-y divide-white/5 overflow-y-auto text-sm', 'aria-label': 'Per-item results' });
    const rows = new Map();
    for (const it of items) {
      const st = el('span', { class: `${STATUS_CLASS.queued} w-20 shrink-0 text-xs`, text: STATUS_TEXT.queued });
      const err = el('span', { class: 'text-xs text-rose-200/80 break-words' });
      const li = el('li', { class: 'flex items-start gap-3 px-3 py-1.5' },
        st, el('span', { class: 'min-w-0 flex-1 truncate', text: labelOf(it), title: labelOf(it) }), err);
      rows.set(it, { li, st, err });
      list.append(li);
    }
    host.append(el('div', { class: 'glass-strong p-4 space-y-3', role: 'region', 'aria-label': `${title} progress`, 'aria-live': 'polite' },
      el('div', { class: 'flex flex-wrap items-center gap-3' },
        el('h3', { class: 'font-semibold', text: title }), counter, status,
        el('div', { class: 'ml-auto flex flex-wrap gap-2' }, cancelBtn, retryBtn, logBtn, closeBtn)),
      el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(items.length), 'aria-valuenow': '0' }, bar),
      list));
    const progressEl = bar.parentElement;

    const onProgress = ({ done, total, results, rateWait }) => {
      counter.textContent = `${formatNumber(done)} / ${formatNumber(total)}`;
      bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '100%';
      progressEl.setAttribute('aria-valuenow', String(done));
      if (rateWait) status.textContent = `GitHub rate limit hit – waiting ${rateWait}s…`;
      else if (!signal.aborted) status.textContent = 'Running…';
      for (const r of results) {
        const row = rows.get(r.item);
        if (!row) continue;
        row.st.className = `${STATUS_CLASS[r.status]} w-20 shrink-0 text-xs`;
        row.st.textContent = STATUS_TEXT[r.status];
        row.err.textContent = r.status === 'failed' || r.status === 'waiting' ? (r.error || '') : '';
        if (r.status === 'running') row.li.scrollIntoView?.({ block: 'nearest' });
      }
    };

    const wrapped = async (item, ctx) => {
      const value = await perItemFn(item, ctx);
      try { onItemOk?.(item, value); } catch { /* UI hooks must not fail the run */ }
      return value;
    };

    const { results, cancelled } = await runBulk(items, wrapped, { ...options, signal, onProgress });
    const finishedAt = Date.now();
    const ok = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed');
    status.textContent = cancelled ? `Cancelled – ${ok} done, ${failed.length} failed` : failed.length ? `Finished – ${ok} ok, ${failed.length} failed` : `Finished – ${ok} ok`;
    cancelBtn.disabled = true; show(cancelBtn, false);
    show(closeBtn, true); show(logBtn, true);
    logBtn.addEventListener('click', () => downloadJson(`${action}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`,
      buildLog({ action, results, startedAt, finishedAt, cancelled })));
    const retryable = results.filter((r) => r.status === 'failed' || r.status === 'cancelled').map((r) => r.item);
    if (retryable.length) {
      show(retryBtn, true);
      retryBtn.addEventListener('click', () => this.run({ title, action, items: retryable, perItemFn, options, onItemOk, onFinish }), { once: true });
    }
    onFinish?.({ results, cancelled });
    return { results, cancelled };
  }
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
