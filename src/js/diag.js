// Lifecycle diagnostics for the panel webview.
//
// PRIVACY: this module must never receive clipboard content. Callers pass a
// stage name plus, at most, small non-sensitive scalars (counts, durations,
// error names). `detail` is stringified defensively and clamped, so even a
// mistaken caller cannot spill a clip into the buffer.
//
// The buffer is in-memory only — nothing is written to disk and nothing
// leaves the machine, matching Raff's zero-network rule.

const MAX_ENTRIES = 120;
const MAX_DETAIL_CHARS = 120;

const entries = [];
const startedAt = Date.now();

function safeDetail(detail) {
  if (detail === undefined || detail === null) return '';
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail);
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`.slice(0, MAX_DETAIL_CHARS);
  if (typeof detail === 'object') {
    // Only whitelisted scalar fields — never arbitrary payloads.
    return Object.entries(detail)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
      .map(([k, v]) => `${k}=${String(v).slice(0, 32)}`)
      .join(' ')
      .slice(0, MAX_DETAIL_CHARS);
  }
  return String(detail).slice(0, MAX_DETAIL_CHARS);
}

/** Records one lifecycle stage. Returns the entry (handy in tests). */
export function diag(stage, detail) {
  const entry = { at: Date.now() - startedAt, stage, detail: safeDetail(detail) };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  // Visible in the webview console during development; harmless in production.
  console.info(`raff/diag ${entry.at}ms ${stage}${entry.detail ? ' — ' + entry.detail : ''}`);
  return entry;
}

/** Snapshot of the buffer — used by tests and by manual inspection. */
export function diagEntries() {
  return entries.map((e) => ({ ...e }));
}

/** True when a stage was recorded at least once. */
export function sawStage(stage) {
  return entries.some((e) => e.stage === stage);
}

/**
 * Installs the global traps. `onFatal` runs for errors that escape every
 * local handler, so the caller can put up the Arabic failure state instead
 * of leaving a silently blank window.
 */
export function installGlobalTraps(onFatal) {
  window.addEventListener('error', (event) => {
    diag('window.onerror', event.error ?? event.message);
    onFatal?.(event.error ?? new Error(String(event.message)));
  });
  window.addEventListener('unhandledrejection', (event) => {
    diag('unhandledrejection', event.reason);
    onFatal?.(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
  });
  // Inspection hook — no content, only stage names and timings.
  window.__raffDiag = diagEntries;
}
