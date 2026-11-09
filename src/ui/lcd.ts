/**
 * LCD — a low-resolution 1-bit framebuffer, like the display in a hardware groovebox.
 *
 * Everything is drawn into a 192x88 pixel buffer and blitted to a canvas that is CSS
 * upscaled with `image-rendering: pixelated`. Glyphs come from the built-in bitmap font,
 * so text stays crisp and unmistakably "instrument", never like a web font.
 *
 * Visual language (matching the faceplate concept): pale blue backlight, near-black
 * pixels, checkerboard dither for fills, and a bold inverted header bar.
 */
import { GLYPH_H, GLYPH_W, glyph } from './pixelfont';

export const LCD_W = 192;
export const LCD_H = 88;

export type Ink = 'ink' | 'light';

const THEMES = {
  // Elektron Monomachine-ish: blue-grey glass, dark pixels
  light: { bg: [176, 192, 214], fg: [18, 22, 30], dim: [96, 108, 128], glow: [255, 255, 255] },
  // inverted: black glass with pale pixels (the photo's design language)
  dark: { bg: [16, 18, 24], fg: [178, 194, 224], dim: [84, 96, 124], glow: [0, 0, 0] },
} as const;

export class Lcd {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf: Uint8Array;
  private image: ImageData;
  private theme: keyof typeof THEMES = 'light';
  /** an offscreen 1x canvas we blit through, to keep the on-screen canvas crisp */
  private raw: HTMLCanvasElement;
  private rawCtx: CanvasRenderingContext2D;
  private raf = 0;
  private dirty = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = LCD_W;
    canvas.height = LCD_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.buf = new Uint8Array(LCD_W * LCD_H);
    this.image = this.ctx.createImageData(LCD_W, LCD_H);
    this.raw = document.createElement('canvas');
    this.raw.width = LCD_W;
    this.raw.height = LCD_H;
    this.rawCtx = this.raw.getContext('2d')!;
  }

  setTheme(theme: keyof typeof THEMES) {
    this.theme = theme;
    this.dirty = true;
  }

  get themeName() {
    return this.theme;
  }

  /* --------------------------------------------------------------- drawing --- */

  clear() {
    this.buf.fill(0);
  }

  px(x: number, y: number) {
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
    this.buf[y * LCD_W + x] = 1;
  }

  unpx(x: number, y: number) {
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
    this.buf[y * LCD_W + x] = 0;
  }

  get(x: number, y: number) {
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return 0;
    return this.buf[y * LCD_W + x];
  }

  hLine(x: number, y: number, w: number) {
    for (let i = 0; i < w; i++) this.px(x + i, y);
  }

  vLine(x: number, y: number, h: number) {
    for (let i = 0; i < h; i++) this.px(x, y + i);
  }

  rect(x: number, y: number, w: number, h: number) {
    this.hLine(x, y, w);
    this.hLine(x, y + h - 1, w);
    this.vLine(x, y, h);
    this.vLine(x + w - 1, y, h);
  }

  fillRect(x: number, y: number, w: number, h: number) {
    for (let j = 0; j < h; j++) this.hLine(x, y + j, w);
  }

  ditherRect(x: number, y: number, w: number, h: number) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (((x + i + y + j) & 1) === 0) this.px(x + i, y + j);
      }
    }
  }

  invert(x: number, y: number, w: number, h: number) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const xx = x + i;
        const yy = y + j;
        if (xx < 0 || yy < 0 || xx >= LCD_W || yy >= LCD_H) continue;
        const idx = yy * LCD_W + xx;
        this.buf[idx] = this.buf[idx] ? 0 : 1;
      }
    }
  }

  /** Draw text. `inverse` draws a filled bar behind the glyphs. */
  text(
    x: number, y: number, str: string,
    opts: { inverse?: boolean; scale?: number; pad?: number; bold?: boolean } = {},
  ) {
    const scale = opts.scale ?? 1;
    const pad = opts.pad ?? 0;
    const s = str.toUpperCase();
    if (opts.inverse) {
      const w = s.length * (GLYPH_W + 1) * scale + pad * 2 - scale;
      this.fillRect(x - pad, y - pad, w + 2 * pad, GLYPH_H * scale + pad * 2);
    }
    let cx = x;
    for (let i = 0; i < s.length; i++) {
      const g = glyph(s[i]);
      for (let r = 0; r < GLYPH_H; r++) {
        const bits = g[r];
        if (!bits) continue;
        for (let c = 0; c < GLYPH_W; c++) {
          if (bits & (1 << (GLYPH_W - 1 - c))) {
            if (opts.inverse) {
              for (let sy = 0; sy < scale; sy++) {
                for (let sx = 0; sx < scale; sx++) this.unpx(cx + c * scale + sx, y + r * scale + sy);
              }
            } else {
              for (let sy = 0; sy < scale; sy++) {
                for (let sx = 0; sx < scale; sx++) this.px(cx + c * scale + sx, y + r * scale + sy);
              }
            }
          }
        }
      }
      cx += (GLYPH_W + 1) * scale;
    }
  }

  /** Text clipped/padded to an exact width in characters. */
  textFixed(x: number, y: number, str: string, chars: number, opts: Parameters<Lcd['text']>[3] = {}) {
    const s = str.length > chars ? str.slice(0, chars) : str.padEnd(chars, ' ');
    this.text(x, y, s, opts);
  }

  textRight(xRight: number, y: number, str: string, opts: Parameters<Lcd['text']>[3] = {}) {
    const scale = opts.scale ?? 1;
    const w = str.length * (GLYPH_W + 1) * scale - scale;
    this.text(xRight - w, y, str, opts);
  }

  /** A 7x7 checkbox with an optional print. */
  box(x: number, y: number, on: boolean, size = 7) {
    this.rect(x, y, size, size);
    if (on) this.fillRect(x + 2, y + 2, size - 4, size - 4);
  }

  /** Draw a small LED-ish marker (used for trig conditions / p-lock flag). */
  marker(x: number, y: number, kind: 'lock' | 'cond' | 'mute' | 'solo') {
    if (kind === 'lock') {
      // padlock
      this.hLine(x + 1, y, 3);
      this.vLine(x, y + 1, 4);
      this.vLine(x + 4, y + 1, 4);
      this.hLine(x, y + 4, 5);
      this.px(x + 2, y + 2);
    } else if (kind === 'cond') {
      this.px(x, y + 4); this.px(x + 1, y + 3); this.px(x + 2, y + 2);
      this.px(x + 3, y + 1); this.px(x + 4, y);
    } else if (kind === 'mute') {
      this.text(x, y, 'M');
    } else {
      this.text(x, y, 'S');
    }
  }

  /**
   * Waveform display from a peak array. `style` chooses filled / outline / bar.
   */
  wave(
    x: number, y: number, w: number, h: number, data: ArrayLike<number>,
    style: 'fill' | 'line' | 'bars' = 'fill',
  ) {
    const n = data.length;
    if (n === 0 || w <= 0 || h <= 0) return;
    const mid = y + Math.floor(h / 2);
    if (style === 'bars') {
      for (let i = 0; i < w; i++) {
        const v = data[Math.min(n - 1, Math.floor((i / w) * n))];
        const bh = Math.max(1, Math.round(v * (h / 2)));
        for (let j = 0; j < bh; j++) {
          this.px(x + i, mid - j);
          this.px(x + i, mid + j);
        }
      }
      return;
    }
    if (style === 'line') {
      for (let i = 0; i < w; i++) {
        const v = data[Math.min(n - 1, Math.floor((i / w) * n))];
        const j = Math.round(v * (h / 2 - 1));
        this.px(x + i, mid - j);
        this.px(x + i, mid + j);
      }
      return;
    }
    // filled with dither so it reads as a screen, not a solid block
    for (let i = 0; i < w; i++) {
      const v = data[Math.min(n - 1, Math.floor((i / w) * n))];
      const bh = Math.max(1, Math.round(v * (h / 2)));
      for (let j = 0; j < bh; j++) {
        if ((i + j) & 1) continue;
        this.px(x + i, mid - j);
        this.px(x + i, mid + j);
      }
    }
  }

  /** ADSR envelope visualisation inside a box. */
  envelope(x: number, y: number, w: number, h: number, a: number, d: number, s: number, r: number) {
    this.rect(x, y, w, h);
    const innerW = w - 3;
    const innerH = h - 3;
    const ax = Math.round(innerW * (0.05 + a * 0.3));
    const dx = Math.round(innerW * (0.05 + d * 0.28));
    const rx = Math.round(innerW * (0.05 + r * 0.3));
    const sux = Math.max(x + 2, x + 1 + innerW - rx);
    const pts: [number, number][] = [
      [x + 1, y + h - 2],
      [x + 1 + ax, y + 2],
      [x + 1 + ax + dx, y + 2 + Math.round((1 - s) * innerH)],
      [sux, y + 2 + Math.round((1 - s) * innerH)],
      [x + w - 2, y + h - 2],
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number) {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let guard = 0;
    for (;;) {
      this.px(x0, y0);
      if ((x0 === x1 && y0 === y1) || guard++ > 512) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  /** Range bar (encoder value indicator). */
  valueBar(
    x: number, y: number, w: number, value: number,
    opts: { bipolar?: boolean; h?: number } = {},
  ) {
    const h = opts.h ?? 5;
    this.rect(x, y, w, h);
    const inner = w - 2;
    if (opts.bipolar) {
      const mid = x + 1 + Math.floor(inner / 2);
      this.vLine(mid, y + 1, h - 2);
      const v = (value - 0.5) * 2;
      const len = Math.round(Math.abs(v) * (inner / 2 - 1));
      if (v >= 0) {
        for (let i = 1; i <= len; i++) this.vLine(mid + i, y + 2, h - 3);
      } else {
        for (let i = 1; i <= len; i++) this.vLine(mid - i, y + 2, h - 3);
      }
    } else {
      const len = Math.round(value * inner);
      for (let i = 0; i < len; i++) {
        if (i % 2 === 0 || len < 8) this.vLine(x + 1 + i, y + 2, h - 3);
      }
    }
  }

  /* ----------------------------------------------------------------- blit --- */

  /** Present the framebuffer. Called once per animation frame by the app. */
  present() {
    const img = this.image;
    const data = img.data;
    const theme = THEMES[this.theme];
    const [fgR, fgG, fgB] = theme.fg;
    const [bgR, bgG, bgB] = theme.bg;
    const [dR, dG, dB] = theme.dim;
    const buf = this.buf;
    for (let i = 0, p = 0; i < buf.length; i++, p += 4) {
      if (buf[i]) {
        data[p] = fgR; data[p + 1] = fgG; data[p + 2] = fgB;
      } else {
        data[p] = bgR; data[p + 1] = bgG; data[p + 2] = bgB;
      }
      data[p + 3] = 255;
      void dR; void dG; void dB;
    }
    this.rawCtx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.raw, 0, 0);
    this.dirty = false;
  }

  markDirty() {
    this.dirty = true;
  }

  get needsPresent() {
    return this.dirty;
  }
}
