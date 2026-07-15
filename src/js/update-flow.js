// Shared update-cycle logic used by both the Settings «حول» tab and the
// standalone update window. Owns the three audited Rust commands (check →
// download+install → restart) through the invoke bridge, the busy/phase
// guards, and the raff://update/* event wiring. Callers only render an
// already-typed state via `onChange` — no two windows reimplement the
// state machine or the API calls.

import { api, on } from './store.js';

export function createUpdateFlow({ onChange }) {
  let busy = false;
  let phase = 'idle';

  function set(state, data = {}) {
    phase = state;
    onChange(state, data);
  }

  const errMessage = (err, fallback) => (typeof err === 'string' && err ? err : fallback);

  async function check() {
    if (busy) return;
    busy = true;
    set('checking');
    try {
      const result = await api.checkForUpdate();
      if (result?.status === 'available') {
        set('available', { version: result.version, date: result.date, notes: result.notes });
      } else if (result?.status === 'upToDate') {
        set('uptodate', { currentVersion: result.currentVersion });
      } else {
        set('error', { from: 'check', message: result?.message || 'تعذّر التحقق من التحديث.' });
      }
    } catch (err) {
      set('error', { from: 'check', message: errMessage(err, 'تعذّر التحقق من التحديث.') });
    } finally {
      busy = false;
    }
  }

  async function download() {
    if (busy) return;
    busy = true;
    set('downloading', { downloaded: 0, total: null, percent: null });
    try {
      await api.downloadAndInstallUpdate();
      // Resolves only after install completes; the `installed` event usually
      // already rendered this — rendering again is idempotent and covers a
      // missed event.
      set('installed');
    } catch (err) {
      set('error', { from: 'download', message: errMessage(err, 'تعذّر تنزيل التحديث أو تثبيته.') });
    } finally {
      busy = false;
    }
  }

  async function restart() {
    try {
      // On success the process relaunches and this webview is torn down — the
      // promise never resolves. Only a refused/failed restart returns here.
      await api.restartToUpdate();
    } catch (err) {
      set('error', { from: 'restart', message: errMessage(err, 'تعذّر إعادة التشغيل.') });
    }
  }

  /** Runs `check()` unless an operation is already in flight, or an install is
   *  already staged awaiting restart. Used by the tray menu entry point, which
   *  must show the current state instead of starting a second operation. */
  function checkIfIdle() {
    if (busy || phase === 'installing' || phase === 'installed') return;
    check();
  }

  // Registered once per document (each window is its own module instance),
  // so handlers never accumulate across tab switches or window re-shows.
  on('raff://update/started', (event) =>
    set('downloading', {
      downloaded: 0,
      total: event?.payload?.total ?? null,
      percent: event?.payload?.total == null ? null : 0,
    })
  );
  on('raff://update/progress', (event) =>
    set('downloading', {
      downloaded: event?.payload?.downloaded,
      total: event?.payload?.total ?? null,
      percent: event?.payload?.percent ?? null,
    })
  );
  on('raff://update/installing', () => set('installing'));
  on('raff://update/installed', () => set('installed'));
  on('raff://update/error', (event) =>
    set('error', { from: 'download', message: event?.payload?.message || 'تعذّر تنزيل التحديث أو تثبيته.' })
  );

  return { check, download, restart, checkIfIdle, isBusy: () => busy, getPhase: () => phase };
}
