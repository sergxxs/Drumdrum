/**
 * Hardware interaction layer.
 *
 * Turns DOM elements into physical-feeling controls:
 *  • endless encoders that react to vertical drag *and* wheel, with fine mode
 *  • pads with velocity from... nothing (touch has no pressure on iOS), so velocity is
 *    derived from the tap position (lower on the pad = harder), which is the same trick
 *    hardware pads use with their rubber dome geometry.
 *  • no scrolling/zooming/selection anywhere on the panel
 */
export type KnobHandler = (delta: number, fine: boolean) => void;
export type KnobRelease = () => void;

export interface KnobOptions {
  /** pixels of drag per full turn */
  travel?: number;
  onDelta: KnobHandler;
  onRelease?: KnobRelease;
  onFocus?: () => void;
}

/** Attach endless-encoder behaviour to an element. Returns a detach function. */
export function bindKnob(el: HTMLElement, opts: KnobOptions): () => void {
  const travel = opts.travel ?? 160;
  let dragging = false;
  let lastY = 0;
  let lastX = 0;
  let accumulated = 0;
  let pointerId: number | null = null;
  let fine = false;

  const down = (e: PointerEvent) => {
    if (dragging) return;
    dragging = true;
    pointerId = e.pointerId;
    lastY = e.clientY;
    lastX = e.clientX;
    accumulated = 0;
    fine = e.shiftKey;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('dragging');
    opts.onFocus?.();
    e.preventDefault();
    e.stopPropagation();
  };

  const move = (e: PointerEvent) => {
    if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
    // vertical drag is the hardware gesture; horizontal also works and feels natural
    const dy = lastY - e.clientY;
    const dx = e.clientX - lastX;
    lastY = e.clientY;
    lastX = e.clientX;
    accumulated += Math.abs(dy) > Math.abs(dx) ? dy : dx;
    const stepPx = fine ? travel * 6 : travel;
    if (Math.abs(accumulated) >= stepPx / 12) {
      const steps = accumulated / (stepPx / 12);
      accumulated = 0;
      opts.onDelta(steps / 12, fine);
    }
    e.preventDefault();
  };

  const up = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    pointerId = null;
    el.classList.remove('dragging');
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch { /* ignore */ }
    opts.onRelease?.();
    e.preventDefault();
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    opts.onDelta(dir * (e.shiftKey ? 0.08 : 1), e.shiftKey);
  };

  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      opts.onDelta(e.shiftKey ? 0.1 : 1, e.shiftKey);
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      opts.onDelta(e.shiftKey ? -0.1 : -1, e.shiftKey);
      e.preventDefault();
    }
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('keydown', key);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel);
    el.removeEventListener('keydown', key);
  };
}

/** Rotate the knob's visual indicator (-135deg .. +135deg). */
export function setKnobAngle(el: HTMLElement, norm: number) {
  const deg = -135 + Math.max(0, Math.min(1, norm)) * 270;
  el.style.setProperty('--angle', `${deg.toFixed(1)}deg`);
}

/**
 * Velocity from touch geometry: the lower half of the pad plays harder, and the
 * very top edge is a ghost note. This is deterministic and feels like a real pad.
 */
export function padVelocity(rect: DOMRect, clientY: number, clientX: number): number {
  const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  // centre of pad = full, edges softer (natural thumb behaviour)
  const edge = 1 - Math.min(0.35, Math.abs(relX - 0.5) * 0.5);
  const v = 0.35 + relY * 0.65;
  return Math.max(0.15, Math.min(1, v * edge));
}

/** Global guards: no scrolling, no double-tap zoom, no context menu on the panel. */
export function installTouchGuards(root: HTMLElement) {
  const prevent = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('.overlay-list')) return; // lists scroll inside the overlay
    e.preventDefault();
  };
  document.addEventListener('touchmove', prevent, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement)?.closest('.device')) e.preventDefault();
  });
  document.addEventListener('selectstart', (e) => {
    if ((e.target as HTMLElement)?.closest('.device')) e.preventDefault();
  });
  root.addEventListener('dblclick', (e) => e.preventDefault());
  // keep the page from bouncing on iOS
  window.addEventListener('scroll', () => window.scrollTo(0, 0));
}

/**
 * Layout driver.
 *
 * Wide screens get the full hardware faceplate at a fixed aspect ratio, uniformly scaled.
 * Phones (or any viewport whose diagonal is too small for that scale to stay legible) get
 * `compact` mode instead: the *same* controls re-flowed into a full-bleed column so the
 * LCD stays big and the touch targets stay ≥ 40px. Nothing is hidden in compact mode.
 */
export function fitDevice(el: HTMLElement, baseW: number, baseH: number) {
  const apply = () => {
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    // The wide faceplate needs ~1.7x its base aspect to stay readable; below that we
    // re-flow into the compact arrangement (phones, small tablets, split-screen).
    const wideScale = Math.min((vw - 20) / baseW, (vh - 20) / baseH);
    const compact = wideScale < 0.58;
    el.classList.toggle('compact', compact);
    if (compact) {
      // Re-flow to full width, then scale the natural layout down to exactly fit the
      // viewport height. Every phone therefore gets the largest legible arrangement.
      el.style.transform = 'none';
      el.style.transformOrigin = 'top center';
      el.style.width = `calc(${vw}px - 8px)`;
      el.style.height = 'auto';
      const natural = el.offsetHeight || el.getBoundingClientRect().height;
      if (natural > 120) {
        const scale = Math.min(1, (vh - 6) / natural);
        el.style.transform = `scale(${Number(scale.toFixed(4))})`;
      }
      return;
    }
    el.style.transformOrigin = 'center center';
    el.style.width = '';
    el.style.height = '';
    const pad = 10;
    const scale = Math.min((vw - pad * 2) / baseW, (vh - pad * 2) / baseH);
    el.style.transform = `scale(${Number(scale.toFixed(4))})`;
  };
  apply();
  window.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 150));
  return apply;
}

/** Tap tempo helper. */
export class TapTempo {
  private taps: number[] = [];
  tap(): number | null {
    const now = performance.now();
    this.taps.push(now);
    if (this.taps.length > 6) this.taps.shift();
    if (this.taps.length < 2) return null;
    const spans: number[] = [];
    for (let i = 1; i < this.taps.length; i++) spans.push(this.taps[i] - this.taps[i - 1]);
    const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
    if (avg < 120) {
      this.taps = [now];
      return null;
    }
    return Math.max(30, Math.min(300, 60000 / avg));
  }
}

/** Long-press helper (used for "clear all locks" style secondary actions). */
export function onLongPress(el: HTMLElement, fn: () => void, ms = 520): () => void {
  let timer: number | null = null;
  const start = () => {
    timer = window.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('pointerleave', clear);
  return clear;
}
