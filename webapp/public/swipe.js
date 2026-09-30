// Swipe gestures for cards and list rows.
//
// Touch uses touch events with a non-passive touchmove, so a gesture can
// claim the finger (preventDefault) once it knows its direction; mouse and
// pen use pointer events. Modes:
//   'free' - a card: every direction is ours (the card has touch-action:none).
//   'row'  - a list row: horizontal drags are ours, vertical ones scroll the
//            page, unless the finger was held still first (holdForVertical),
//            which turns the next vertical drag into ours.

export const HOLD_MS = 350;
let active = 0;
export function isDragging() { return active > 0; }

export function gesture(el, { mode = 'free', holdForVertical = false, onDrag, onEnd, onHold }) {
  let s = null;
  let suppressUntil = 0;

  function start(x, y, pointerId = null) {
    s = { x, y, dx: 0, dy: 0, axis: null, held: false, moved: false, timer: 0, pointerId };
    if (holdForVertical) {
      s.timer = setTimeout(() => {
        if (s && !s.moved) { s.held = true; onHold && onHold(true); }
      }, HOLD_MS);
    }
  }

  function move(x, y, ev) {
    if (!s) return;
    const dx = x - s.x;
    const dy = y - s.y;
    if (!s.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      s.moved = true;
      clearTimeout(s.timer);
      if (mode === 'free') s.axis = 'free';
      else if (s.held) s.axis = 'v';
      else if (Math.abs(dx) > Math.abs(dy)) s.axis = 'h';
      else { s = null; return; } // a scroll: let the page have it
      active++;
      // Capture only once it is a drag: capturing on press would retarget
      // the click of a plain tap away from a link inside the element.
      if (s.pointerId != null) { try { el.setPointerCapture(s.pointerId); } catch { /* synthetic events */ } }
    }
    if (ev.cancelable) ev.preventDefault();
    s.dx = s.axis === 'v' ? 0 : dx;
    s.dy = s.axis === 'h' ? 0 : dy;
    onDrag && onDrag(s.dx, s.dy, s);
  }

  function end(cancelled) {
    if (!s) return;
    clearTimeout(s.timer);
    const g = s;
    s = null;
    if (g.axis) active = Math.max(0, active - 1);
    if (g.axis || g.held) suppressUntil = Date.now() + 500;
    if (g.held && onHold) onHold(false);
    if (!g.axis) return;
    onEnd && onEnd(cancelled ? 0 : g.dx, cancelled ? 0 : g.dy, g);
  }

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { end(true); return; }
    const t = e.touches[0];
    start(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (t) move(t.clientX, t.clientY, e);
  }, { passive: false });
  el.addEventListener('touchend', () => end(false));
  el.addEventListener('touchcancel', () => end(true));

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    start(e.clientX, e.clientY, e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    move(e.clientX, e.clientY, e);
  });
  el.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') end(false); });
  el.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') end(true); });

  // A drag must not also count as a tap on whatever is under the finger.
  el.addEventListener('click', (e) => {
    if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// Card and article-row verdicts: absolute, by distance.
export function verdictFor(dx, dy, allowSkip = true) {
  if (allowSkip && dy < -110 && Math.abs(dy) > Math.abs(dx)) return 'skip';
  if (dx > 200) return 2;
  if (dx > 90) return 1;
  if (dx < -200) return -2;
  if (dx < -90) return -1;
  return null;
}

// "Mina bedömningar" rows: one step per swipe, or withdraw.
export function stepFor(dx, dy, held) {
  if (held && dy < -140) return 'withdraw';
  if (dx > 90) return 'up';
  if (dx < -90) return 'down';
  return null;
}

export function vibrate() {
  try { navigator.vibrate && navigator.vibrate(10); } catch { /* unsupported */ }
}
