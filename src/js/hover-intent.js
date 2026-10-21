// Hover with intent, for the preview beside the panel (decisions ت٣٢).
//
// An item counts as wanted only once the pointer has RESTED on it: `dwellMs`
// on one item without drifting more than `tolerance` px from where it
// settled. Passing over rows on the way somewhere restarts the wait on every
// item, so it never fires. Once the preview is open, resting on another item
// follows it after the shorter `followMs`. Leaving both the panel and the
// preview closes it after `closeMs` — long enough to cross the gap between
// them, which lands on the preview and holds it.
//
// It only reports; what "open" and "close" mean is the caller's.

/** How long the pointer has to rest on one item before it counts as wanted. */
export const DWELL_MS = 300;

export function createHoverIntent({
  dwellMs = DWELL_MS,
  followMs = 150,
  closeMs = 300,
  tolerance = 8,
  isOpen,
  onRest,
  onAway,
}) {
  let settled = null; // { id, x, y } — where the current wait started
  let restTimer = null;
  let awayTimer = null;

  const stopRest = () => {
    clearTimeout(restTimer);
    restTimer = null;
    settled = null;
  };
  const stopAway = () => {
    clearTimeout(awayTimer);
    awayTimer = null;
  };

  return {
    /** The pointer is over item `id`, at (x, y). */
    over(id, x, y) {
      stopAway();
      if (settled && settled.id === id && Math.hypot(x - settled.x, y - settled.y) <= tolerance) return;
      stopRest();
      settled = { id, x, y };
      restTimer = setTimeout(() => {
        restTimer = null;
        settled = null;
        onRest(id);
      }, isOpen() ? followMs : dwellMs);
    },
    /** Inside, but over no item (the header, the footer, a gap): wait for nothing. */
    between() {
      stopRest();
      stopAway();
    },
    /** On the preview itself: it stays. */
    hold() {
      stopRest();
      stopAway();
    },
    /** Outside the panel and the preview. */
    away() {
      stopRest();
      stopAway();
      awayTimer = setTimeout(() => {
        awayTimer = null;
        onAway();
      }, closeMs);
    },
    cancel() {
      stopRest();
      stopAway();
    },
  };
}
