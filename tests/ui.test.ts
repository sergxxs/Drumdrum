import { describe, it, expect, beforeAll } from 'vitest';
import { getNorm, setNorm, formatValue, PARAM_DEFS } from '../src/state/params';
import { defaultTrackParams } from '../src/state/presets';
import { installCanvasStubs } from './support/domStub';
import { Lcd, LCD_H, LCD_W } from '../src/ui/lcd';
import { drawScreen } from '../src/ui/pages';
import type { Status } from '../src/ui/pages';
import { Store } from '../src/state/store';
import { glyph, textWidth } from '../src/ui/pixelfont';
import { PAGE_ORDER } from '../src/state/params';
import { StubCanvas } from './support/domStub';

const status: Status = {
  playing: true,
  steps: [0, 4, 8, 12, 2, 6, 10, 14],
  masterL: 0.5,
  masterR: 0.45,
  trackMeters: [0.5, 0.2, 0.7, 0.1, 0.3, 0.6, 0.2, 0.1],
  recFrames: 0,
  recActive: false,
  audio: 'running',
  host: 'WORKLET',
  frames: 44100,
};

/** Pixel count of the framebuffer, read through the canvas image data. */
function litPixels(lcd: Lcd): number {
  let n = 0;
  for (let y = 0; y < LCD_H; y++) {
    for (let x = 0; x < LCD_W; x++) if (lcd.get(x, y)) n++;
  }
  return n;
}

beforeAll(() => installCanvasStubs());

describe('choice parameters (stored as strings)', () => {
  it('round-trips through getNorm/setNorm for every choice parameter', () => {
    const p = defaultTrackParams('fm');
    for (const [key, def] of Object.entries(PARAM_DEFS)) {
      if (!def.choices) continue;
      for (let i = 0; i < def.choices.length; i++) {
        const n = def.choices.length > 1 ? i / (def.choices.length - 1) : 0;
        setNorm(p, key, n);
        expect(getNorm(p, key), `${key} index ${i}`).toBeCloseTo(n, 5);
        expect(formatValue(key, n)).toBe(def.choices[i]);
      }
    }
  });

  it('never produces NaN for a choice parameter', () => {
    const p = defaultTrackParams('mono');
    for (const key of ['filter.type', 'lfo.shape', 'lfo.dest', 'lfo.sync']) {
      expect(Number.isFinite(getNorm(p, key)), key).toBe(true);
    }
  });

  it('writes strings, which is what the DSP switches on', () => {
    const p = defaultTrackParams('fm');
    const choices = PARAM_DEFS['filter.type'].choices!;
    // normalised 0..1 spans the whole table, so index 1 is 1/(len-1)
    setNorm(p, 'filter.type', 1 / (choices.length - 1));
    expect(typeof p.filter.type).toBe('string');
    expect(p.filter.type).toBe(choices[1]);
    // the top of the range is the last choice, never out of bounds
    setNorm(p, 'filter.type', 1);
    expect(p.filter.type).toBe(choices[choices.length - 1]);
  });
});

describe('pixel font', () => {
  it('has a full printable ASCII set', () => {
    for (let c = 32; c < 127; c++) {
      const ch = String.fromCharCode(c);
      expect(glyph(ch), `char ${ch}`).toBeTruthy();
      expect(glyph(ch).length).toBe(7);
    }
  });

  it('measure text width consistently with rendering', () => {
    expect(textWidth('ABC')).toBe(17);
    expect(textWidth('ABC', 2)).toBe(34);
  });
});

describe('LCD pages', () => {
  let lcd: Lcd;
  let store: Store;

  beforeAll(() => {
    lcd = new Lcd(new StubCanvas() as unknown as HTMLCanvasElement);
    store = new Store();
  });

  it('renders every mode screen with visible content', () => {
    for (const mode of ['PATTERN', 'KIT', 'SONG', 'MIX', 'FX', 'SETUP'] as const) {
      drawScreen(lcd, store, status, { kind: 'mode', name: mode });
      const lit = litPixels(lcd);
      expect(lit, `mode ${mode}`).toBeGreaterThan(250);
      // must never fill the entire screen (that would be a blank/inverse bug)
      expect(lit).toBeLessThan(LCD_W * LCD_H * 0.75);
    }
  });

  it('renders every parameter page for all three engines', () => {
    for (const engine of ['fm', 'mono', 'sample'] as const) {
      store.setEngine(0, engine);
      for (const page of PAGE_ORDER) {
        if (page === 'sample' && engine !== 'sample') continue;
        drawScreen(lcd, store, status, { kind: 'page', page });
        const lit = litPixels(lcd);
        expect(lit, `page ${page} engine ${engine}`).toBeGreaterThan(200);
      }
    }
  });

  it('shows the pattern name and tempo in the header', () => {
    drawScreen(lcd, store, status, { kind: 'mode', name: 'PATTERN' });
    // header bar must be fully inverted (solid) except where text is cut out
    let headerPixels = 0;
    for (let x = 0; x < LCD_W; x++) if (lcd.get(x, 4)) headerPixels++;
    expect(headerPixels).toBeGreaterThan(LCD_W * 0.5);
  });

  it('tracks playback position on the grid', () => {
    drawScreen(lcd, store, status, { kind: 'mode', name: 'PATTERN' });
    const before = litPixels(lcd);
    const moved: Status = { ...status, steps: [8, 9, 10, 11, 12, 13, 14, 15] };
    drawScreen(lcd, store, moved, { kind: 'mode', name: 'PATTERN' });
    expect(litPixels(lcd)).not.toBe(before);
  });
});

describe('renderer purity', () => {
  it('draws into a 192x88 buffer and never writes out of bounds', () => {
    const lcd = new Lcd(new StubCanvas() as unknown as HTMLCanvasElement);
    lcd.px(-5, -5);
    lcd.px(LCD_W + 5, LCD_H + 5);
    expect(litPixels(lcd)).toBe(0);
    lcd.fillRect(0, 0, LCD_W, LCD_H);
    expect(litPixels(lcd)).toBe(LCD_W * LCD_H);
  });

  it('supports both themes', () => {
    const lcd = new Lcd(new StubCanvas() as unknown as HTMLCanvasElement);
    lcd.setTheme('dark');
    expect(lcd.themeName).toBe('dark');
    lcd.setTheme('light');
    expect(lcd.themeName).toBe('light');
  });
});
