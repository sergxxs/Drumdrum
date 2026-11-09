/**
 * Minimal DOM/Canvas stub so the LCD rendering code can be exercised headlessly.
 *
 * There is no browser available in this environment, so this proves the *rendering
 * maths* (glyph packing, layout, clipping, page contents) rather than browser compositing.
 * Browser-only behaviour (touch, audio unlock) is verified manually on the live preview.
 */

export interface RecordedCall {
  op: string;
  args: unknown[];
}

export class StubContext2D {
  calls: RecordedCall[] = [];
  imageSmoothingEnabled = true;
  fillStyle = '#000';
  font = '10px monospace';
  private record(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  clearRect(...a: unknown[]) { this.record('clearRect', ...a); }
  fillRect(...a: unknown[]) { this.record('fillRect', ...a); }
  strokeRect(...a: unknown[]) { this.record('strokeRect', ...a); }
  fillText(...a: unknown[]) { this.record('fillText', ...a); }
  beginPath() { this.record('beginPath'); }
  moveTo(...a: unknown[]) { this.record('moveTo', ...a); }
  lineTo(...a: unknown[]) { this.record('lineTo', ...a); }
  closePath() { this.record('closePath'); }
  stroke() { this.record('stroke'); }
  fill() { this.record('fill'); }
  arc(...a: unknown[]) { this.record('arc', ...a); }
  save() { this.record('save'); }
  restore() { this.record('restore'); }
  translate(...a: unknown[]) { this.record('translate', ...a); }
  scale(...a: unknown[]) { this.record('scale', ...a); }
  drawImage(...a: unknown[]) { this.record('drawImage', ...a); }
  createImageData(w: number, h: number): ImageData {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' } as unknown as ImageData;
  }
  putImageData(...a: unknown[]) { this.record('putImageData', ...a); }
  getImageData(x: number, y: number, w: number, h: number): ImageData {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
  }
}

export class StubCanvas {
  width = 300;
  height = 150;
  style: Record<string, string> = {};
  private ctx = new StubContext2D();
  getContext(): StubContext2D {
    return this.ctx;
  }
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, top: 0, left: 0, right: this.width, bottom: this.height, width: this.width, height: this.height, toJSON: () => ({}) } as DOMRect;
  }
}

/** Install just enough globals for canvas-based modules to run. */
export function installCanvasStubs() {
  const g = globalThis as any;
  if (!g.document) {
    g.document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return new StubCanvas();
        return {
          style: {},
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          appendChild() {},
          addEventListener() {},
          removeEventListener() {},
          remove() {},
          setAttribute() {},
          querySelector: () => null,
        };
      },
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {}, removeChild() {} },
      head: { appendChild() {} },
    };
  }
  if (!g.window) {
    g.window = {
      addEventListener() {},
      removeEventListener() {},
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: number) => clearTimeout(id),
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 2,
      requestAnimationFrame: (fn: (t: number) => void) => setTimeout(() => fn(0), 0),
    };
  }
  if (!g.localStorage) {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  }
  if (!g.ImageData) {
    g.ImageData = class {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        this.data = new Uint8ClampedArray(w * h * 4);
      }
    };
  }
}
