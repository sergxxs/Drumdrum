/**
 * LCD page renderers.
 *
 * Each function paints one screen of the instrument at 192x88. They read directly from
 * the store (single source of truth) plus a small `Status` object fed by the audio
 * service, so what you see is always the state the DSP is actually using.
 */
import { Lcd, LCD_H, LCD_W } from './lcd';
import {
  ENGINE_PAGES, PAGE_ORDER, PARAM_DEFS,
  formatValue, getNorm, normToValue, pageKnobs, pageTitle,
} from '../state/params';
import { condLabel } from '../seq/trig';
import { FM_ALGOS } from '../audio/fm';
import { MONO_ENGINE_INFO } from '../audio/mono';
import { FILTER_TYPES, LFO_DESTS, LFO_SHAPES, TRIG_CONDS } from '../state/types';
import type { PageId } from '../state/params';
import type { Store } from '../state/store';
import type { EngineKind, TrackParams } from '../state/types';

export interface Status {
  playing: boolean;
  /** step index per track (playhead) */
  steps: number[];
  masterL: number;
  masterR: number;
  trackMeters: number[];
  recFrames: number;
  recActive: boolean;
  audio: 'idle' | 'starting' | 'running' | 'error' | 'suspended';
  host: string;
  frames: number;
}

export type Screen =
  | { kind: 'mode'; name: 'PATTERN' | 'KIT' | 'SONG' | 'MIX' | 'FX' | 'SETUP' }
  | { kind: 'page'; page: PageId };

export function drawScreen(lcd: Lcd, store: Store, status: Status, screen: Screen) {
  lcd.clear();
  if (screen.kind === 'mode') {
    switch (screen.name) {
      case 'PATTERN': drawPattern(lcd, store, status); break;
      case 'KIT': drawKit(lcd, store, status); break;
      case 'SONG': drawSong(lcd, store, status); break;
      case 'MIX': drawMix(lcd, store, status); break;
      case 'FX': drawFxMode(lcd, store, status, store.ui.fxRow); break;
      case 'SETUP': drawSetup(lcd, store, status); break;
    }
  } else {
    drawParamPage(lcd, store, status, screen.page);
  }
}

/* ------------------------------------------------------------------ chrome --- */

function header(lcd: Lcd, store: Store, left: string, right: string) {
  lcd.fillRect(0, 0, LCD_W, 9);
  lcd.text(2, 1, left.toUpperCase().slice(0, 20), { inverse: true });
  lcd.textRight(LCD_W - 2, 1, right.toUpperCase(), { inverse: true });
  lcd.hLine(0, 9, LCD_W);
}

function footer(lcd: Lcd, text: string, right = '') {
  lcd.hLine(0, LCD_H - 11, LCD_W);
  lcd.text(2, LCD_H - 9, text.toUpperCase().slice(0, 26));
  if (right) lcd.textRight(LCD_W - 2, LCD_H - 9, right.toUpperCase());
}

function trackTag(p: TrackParams): string {
  return p.engine === 'fm' ? 'FM' : p.engine === 'mono' ? 'MN' : 'SP';
}

/** Small horizontal slider with label + value, used on every param page. */
function slider(
  lcd: Lcd, x: number, y: number, w: number, key: string, norm: number,
  opts: { focus?: boolean; locked?: boolean; automated?: boolean; label?: string } = {},
) {
  const def = PARAM_DEFS[key];
  const label = (opts.label ?? def?.label ?? key).slice(0, 4);
  lcd.text(x, y, label);
  if (opts.focus) lcd.text(x + 25, y, '▶');
  if (opts.locked) lcd.text(x + 34, y, '\u00a7');
  else if (opts.automated) lcd.text(x + 34, y, '~');
  lcd.textRight(x + w, y, formatValue(key, norm));
  lcd.valueBar(x, y + 8, w - 30, norm, { bipolar: !!def?.bipolar, h: 5 });
}

/**
 * MASTER FX page: the modular insert chain. Each row is a real effect in the master
 * audio path — box = enabled, bar = wet amount. The right column is the master bus
 * (EQ, width, drive, compressor).
 */
function drawFxMode(lcd: Lcd, store: Store, status: Status, selRow = 0) {
  const m = store.project.master;
  header(lcd, store, 'FX CHAIN', m.compOn ? 'COMP' : 'NO CMP');
  const chain = m.chain;
  chain.slice(0, 6).forEach((fx, i) => {
    const y = 12 + i * 8;
    const isSel = i === selRow % Math.max(1, chain.length);
    if (isSel) lcd.ditherRect(0, y - 1, 120, 8);
    lcd.text(2, y, String(i + 1));
    lcd.text(10, y, fx.type.padEnd(5, ' ').slice(0, 5));
    lcd.box(44, y, fx.on, 6);
    lcd.valueBar(54, y, 34, fx.mix, { h: 5 });
    lcd.text(92, y, `${String(Math.round(fx.mix * 100)).padStart(3, ' ')}%`);
  });
  // master bus column
  const mx = 124;
  lcd.text(mx, 11, 'MASTER');
  const rows: [string, string][] = [
    ['EQ L', `${m.eqLow >= 0 ? '+' : ''}${m.eqLow.toFixed(0)}`],
    ['EQ M', `${m.eqMid >= 0 ? '+' : ''}${m.eqMid.toFixed(0)}`],
    ['EQ H', `${m.eqHigh >= 0 ? '+' : ''}${m.eqHigh.toFixed(0)}`],
    ['WIDTH', String(Math.round(m.width * 100))],
    ['DRIVE', String(Math.round(m.drive * 100))],
    ['VOL', String(Math.round(m.volume * 100))],
  ];
  rows.forEach(([k, v], i) => {
    const y = 20 + i * 8;
    lcd.text(mx, y, k);
    lcd.textRight(LCD_W - 2, y, v);
  });
  const gr = Math.max(0, 1 - store.project.master.compThresh);
  footer(lcd, 'A:ON C:MIX D:WIDTH', `RED ${Math.round(gr * 10)}`);
}

/* --------------------------------------------------------------- PATTERN ---- */

function drawPattern(lcd: Lcd, store: Store, status: Status) {
  const pat = store.pattern;
  const len = store.trackLength;
  const cursor = store.ui.cursor;
  const viewSteps = 16;
  const pageStart = Math.floor(cursor / viewSteps) * viewSteps;
  header(
    lcd,
    store,
    pat.name,
    `${pat.tempo.toFixed(1)} ${status.playing ? '\u25b6' : '\u25a0'} ${store.project.currentTrack + 1}/${len}`,
  );

  const rowH = 8;
  const gridX = 56;
  const cellW = 8;
  const cellInner = 6;
  for (let t = 0; t < 8; t++) {
    const y = 12 + t * rowH;
    const tp = pat.tracks[t];
    const p = store.trackParams(t);
    const isCur = t === store.project.currentTrack;
    if (isCur) lcd.ditherRect(0, y - 1, LCD_W, rowH);
    // track number, current marker, mute flag, name, engine tag
    lcd.text(1, y, String(t + 1));
    if (isCur) lcd.text(7, y, '▶');
    if (tp.muted || p.mute) lcd.text(7, y, 'M');
    else if (p.solo) lcd.text(7, y, 'S');
    lcd.text(14, y, store.kit.tracks[t].name.slice(0, 4));
    lcd.text(38, y, trackTag(p));
    // steps
    for (let i = 0; i < viewSteps; i++) {
      const stepIndex = pageStart + i;
      if (stepIndex >= len) break;
      const s = tp.steps[stepIndex];
      const x = gridX + i * cellW;
      const cellY = y;
      const cellH = 7;
      const isPlaying = status.playing && status.steps[t] === stepIndex;
      if (isPlaying) {
        lcd.fillRect(x, cellY, cellInner, cellH);
      } else if (s.on) {
        // velocity height fill (hardware-style trig brightness)
        const h = Math.max(2, Math.round((s.vel || 0.5) * (cellH - 1)));
        lcd.fillRect(x, cellY + (cellH - h), cellInner, h);
      } else {
        // empty slot: 4 corner dots keep the grid readable without noise
        lcd.px(x, cellY + cellH - 1);
        lcd.px(x + cellInner - 1, cellY + cellH - 1);
        lcd.px(x, cellY);
        lcd.px(x + cellInner - 1, cellY);
      }
      // beat markers every 4 steps
      if ((stepIndex + 1) % 4 === 0 && !isPlaying) lcd.vLine(x + cellInner, cellY, cellH);
      // p-lock and condition flags
      if (Object.keys(s.locks).length > 0) lcd.px(x + 1, cellY + 1);
      if (s.cond !== 'ALWAYS') lcd.px(x + 2, cellY + 1);
      if (stepIndex === cursor) lcd.rect(x - 1, cellY - 1, cellInner + 2, cellH + 2);
    }
  }
  // bottom info line: step readout + locks
  const step = pat.tracks[store.project.currentTrack].steps[cursor];
  const condText = condLabel(step.cond);
  const lockCount = Object.keys(step.locks).length;
  const pageInfo = `${Math.floor(cursor / viewSteps) + 1}/${Math.ceil(len / viewSteps)}`;
  footer(
    lcd,
    `STP ${String(cursor + 1).padStart(2, '0')} ${step.on ? `N${step.note} V${Math.round(step.vel * 100)}` : '---'} ${condText}${lockCount ? ` LK${lockCount}` : ''}`,
    `${store.ui.pLockMode ? 'PLOCK' : store.ui.motionMode ? 'MOTION' : ''} ${pageInfo}`,
  );
}

/* -------------------------------------------------------------------- KIT --- */

function drawKit(lcd: Lcd, store: Store, status: Status) {
  header(lcd, store, `KIT ${store.kit.name}`, `TRK ${store.project.currentTrack + 1}`);
  const rowH = 8;
  for (let t = 0; t < 8; t++) {
    const y = 11 + t * rowH;
    const p = store.trackParams(t);
    const isCur = t === store.project.currentTrack;
    if (isCur) lcd.ditherRect(0, y - 1, LCD_W, rowH);
    lcd.text(1, y, String(t + 1));
    lcd.text(8, y, store.kit.tracks[t].name.slice(0, 8));
    lcd.text(60, y, trackTag(p));
    // engine detail line
    let detail = '';
    if (p.engine === 'fm') detail = `${FM_ALGOS[Math.round(p.fm.algorithm)].name} I${Math.round(p.fm.index * 100)}`;
    else if (p.engine === 'mono') detail = MONO_ENGINE_INFO[p.mono.engine].name;
    else {
      const meta = p.sample.sampleId ? store.samples.get(p.sample.sampleId) : null;
      const name = meta?.name ?? (p.sample.sampleId ? p.sample.sampleId.replace('factory-', '') : 'EMPTY');
      detail = `${name}/${p.sample.slices > 1 ? `${p.sample.slices}SL` : '1SH'}`;
    }
    lcd.text(74, y, detail.slice(0, 11));
    // level meter
    const m = status.trackMeters[t] ?? 0;
    const mw = Math.round(Math.min(1, m * 1.6) * 24);
    if (mw > 0) lcd.fillRect(LCD_W - 26, y + 1, mw, 5);
    lcd.textRight(LCD_W - 2, y, `${Math.round(p.volume * 100)}`);
  }
  footer(lcd, 'A:ENGINE  C:PREV/NEXT  D:VOLUME', store.ui.keyboardMode ? 'KEYS' : '');
}

/* ------------------------------------------------------------------- SONG --- */

function drawSong(lcd: Lcd, store: Store, status: Status) {
  const song = store.song;
  header(lcd, store, `SONG ${song.name}`, status.playing ? 'PLAYING' : 'STOPPED');
  lcd.text(2, 12, 'CHAIN');
  let x = 2;
  for (let i = 0; i < store.project.chain.length && i < 12; i++) {
    const idx = store.project.chain[i];
    const label = `P${String(idx + 1).padStart(2, '0')}`;
    const w = label.length * 6 - 1 + 4;
    if (x + w > LCD_W - 2) break;
    lcd.rect(x, 11, w, 9);
    lcd.text(x + 2, 12, label);
    x += w + 2;
  }
  lcd.text(2, 26, 'SONG ARRANGE');
  for (let i = 0; i < song.steps.length && i < 5; i++) {
    const y = 36 + i * 9;
    const s = song.steps[i];
    lcd.text(4, y, `${i + 1}. P${String(s.pattern + 1).padStart(2, '0')} x${s.repeats}`);
    lcd.valueBar(70, y, 60, Math.min(1, s.repeats / 8), { h: 5 });
  }
  footer(lcd, 'A:ADD STEP  C:REPEATS  D:LOOP', store.project.chainLoop ? 'LOOP' : '');
}

/* -------------------------------------------------------------------- MIX --- */

function drawMix(lcd: Lcd, store: Store, status: Status) {
  const master = store.project.master;
  header(lcd, store, 'MIX', `MST ${Math.round(master.volume * 100)}`);
  const colW = 22;
  const meterTop = 11;
  const meterH = 30;
  for (let t = 0; t < 8; t++) {
    const x = 3 + t * colW;
    const p = store.trackParams(t);
    const isCur = t === store.project.currentTrack;
    // vertical level meter with segment gaps, like a hardware LED ladder
    lcd.rect(x, meterTop, 9, meterH);
    const meter = Math.min(1, (status.trackMeters[t] ?? 0) * 1.5);
    const mh = Math.round(meter * (meterH - 2));
    for (let i = 0; i < mh; i++) {
      if (i % 3 === 2) continue;
      lcd.fillRect(x + 1, meterTop + meterH - 1 - i, 7, 1);
    }
    // volume fader
    const faderY = meterTop + meterH + 2;
    lcd.valueBar(x, faderY, 9, p.volume, { h: 13 });
    // pan indicator
    const panY = faderY + 15;
    lcd.hLine(x + 1, panY, 7);
    const panX = Math.round(x + 4 + p.pan * 3);
    lcd.fillRect(panX, panY - 1, 1, 3);
    // number + mute/solo state on the bottom row
    const numY = panY + 4;
    lcd.text(x + 2, numY, String(t + 1));
    if (p.mute) lcd.text(x + 1, numY - 7, 'M');
    else if (p.solo) lcd.text(x + 1, numY - 7, 'S');
    if (isCur) lcd.rect(x - 2, meterTop - 1, 13, numY - meterTop + 8);
  }
  const sel = store.track;
  const name = store.kit.tracks[store.trackIndex].name;
  const panText = Math.abs(sel.pan) < 0.02 ? 'C' : `${sel.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(sel.pan) * 100)}`;
  footer(lcd, `${store.trackIndex + 1} ${name} ${panText}`, `VOL ${Math.round(sel.volume * 100)}`);
}

/* ---------------------------------------------------------------- SETUP ----- */

function drawSetup(lcd: Lcd, store: Store, status: Status) {
  header(lcd, store, 'SETUP', status.audio.toUpperCase());
  const rows: [string, string][] = [
    ['HOST', status.host],
    ['AUDIO', status.audio === 'running' ? `RUN ${store.project.settings.masterVol.toFixed(2)}` : status.audio.toUpperCase()],
    ['CLICK', store.project.settings.click ? 'ON' : 'OFF'],
    ['AUTOSAVE', store.project.settings.autosave ? 'ON' : 'OFF'],
    ['QUANTISE', store.project.settings.recQuant ? `1/${store.project.settings.recQuant}` : 'OFF'],
    ['MIDI CH', String(store.project.settings.midiCh)],
    ['LCD', store.ui.page === 'sample' ? 'SAMPLE' : 'CONTRAST'],
    ['SAMPLES', String(store.samples.size)],
  ];
  rows.forEach(([k, v], i) => {
    const y = 11 + i * 8;
    lcd.text(2, y, k);
    lcd.textRight(90, y, v);
  });
  // master meters right side
  const mx = 104;
  lcd.text(mx, 11, 'OUT L/R');
  for (let i = 0; i < 2; i++) {
    const v = i === 0 ? status.masterL : status.masterR;
    lcd.valueBar(mx, 20 + i * 8, 84, Math.min(1, v * 1.4), { h: 6 });
  }
  lcd.text(mx, 40, 'CLOCK');
  lcd.text(mx, 48, `${(status.frames / 44100).toFixed(1)}S`);
  lcd.text(mx, 56, `TEMPO ${store.pattern.tempo.toFixed(1)}`);
  footer(lcd, 'C:TEMPO D:METRONOME', 'PAGE ↕');
}

/* ------------------------------------------------------------- PARAM PAGES --- */

function drawParamPage(lcd: Lcd, store: Store, status: Status, page: PageId) {
  const p = store.track;
  const keys = pageKnobs(page, p.engine);
  const trackName = store.kit.tracks[store.project.currentTrack].name;
  const right = page === 'sound' ? `${trackTag(p)} ${status.playing ? '▶' : '■'}` : `${store.project.currentTrack + 1} ${trackTag(p)}`;
  header(lcd, store, `${pageTitle(page)} ${trackName}`, right);

  // left column: parameter sliders
  const sliderX = 3;
  const sliderW = 104;
  const focus = store.ui.knobFocus;
  const step = store.currentStep();
  // Monomachine-style engines name their four macros per model, so surface that.
  const monoLabels = p.engine === 'mono'
    ? (page === 'sound'
      ? MONO_ENGINE_INFO[p.mono.engine]
      : page === 'mod' ? null : null)
    : null;
  const engineLabels = p.engine === 'sample' && page === 'sound'
    ? ['PITCH', 'DECAY', 'RATE', 'STRETCH']
    : null;
  keys.forEach((key, i) => {
    if (!key) return;
    const y = 13 + i * 15;
    const norm = getNorm(p, key);
    const locked = step.locks[key] !== undefined;
    const automated = !!store.trackPattern.automation[key];
    let label: string | undefined;
    if (monoLabels) label = [monoLabels.p1, monoLabels.p2, monoLabels.p3, monoLabels.p4][i];
    if (engineLabels) label = engineLabels[i];
    slider(lcd, sliderX, y, sliderW, key, norm, {
      focus: i === focus, locked, automated, label,
    });
  });

  /* right side visualisation, engine/page specific */
  const vx = 112;
  const vy = 12;
  const vw = LCD_W - vx - 2;
  const vh = 62;
  if (page === 'sound') {
    if (p.engine === 'fm') drawFMVisual(lcd, p, vx, vy, vw, vh);
    else if (p.engine === 'mono') drawMonoVisual(lcd, p, vx, vy, vw, vh);
    else drawSampleVisual(lcd, store, p, vx, vy, vw, vh, false);
  } else if (page === 'filter') {
    drawFilterCurve(lcd, p, vx, vy, vw, vh);
  } else if (page === 'amp') {
    drawAmpEnv(lcd, p, vx, vy, vw, vh);
  } else if (page === 'lfo') {
    drawLfo(lcd, p, vx, vy, vw, vh);
  } else if (page === 'fx') {
    drawFxVisual(lcd, store, p, vx, vy, vw, vh);
  } else if (page === 'mod') {
    drawModVisual(lcd, p, vx, vy, vw, vh);
  } else if (page === 'sample') {
    drawSampleVisual(lcd, store, p, vx, vy, vw, vh, true);
  }

  // footer: page + focused value, giant
  const fk = keys[focus];
  if (fk) {
    footer(lcd, `${'ABCD'[focus]} ${PARAM_DEFS[fk]?.label ?? ''}`, formatValue(fk, getNorm(p, fk)));
  } else {
    footer(lcd, pageTitle(page), '');
  }
}

/* --------------------------------------------------------- visualisations --- */

/**
 * FM algorithm diagram: operators are placed by their role in the algorithm graph
 * (depth from the output), modulators on top, carriers at the bottom. Boxes fill up
 * with their live output level, so this doubles as a modulation-depth meter.
 */
function drawFMVisual(lcd: Lcd, p: TrackParams, x: number, y: number, w: number, h: number) {
  const algoIndex = Math.round(p.fm.algorithm);
  const alg = FM_ALGOS[algoIndex];
  lcd.text(x, y, `ALG${algoIndex + 1} ${alg.name}`);
  // depth: carriers 0, their modulators 1, ...
  const depth = [0, 0, 0, 0];
  for (let iter = 0; iter < 4; iter++) {
    for (const [m, c] of alg.edges) depth[m] = Math.max(depth[m], depth[c] + 1);
  }
  const maxDepth = Math.max(...depth);
  const boxW = 17;
  const boxH = 11;
  const gx = x + 1;
  const gy = y + 10;
  const rowH = 14;
  const colOf = (i: number) => {
    // keep original operator order left-to-right within a row
    let col = 0;
    for (let j = 0; j < i; j++) if (depth[j] === depth[i]) col++;
    return col;
  };
  const rowCount = (d: number) => depth.filter((v) => v === d).length;
  const posX = (i: number) => {
    const d = depth[i];
    const n = rowCount(d);
    const slotW = Math.floor((w - 2) / Math.max(n, 1));
    return gx + colOf(i) * slotW;
  };
  const posY = (i: number) => gy + (maxDepth - depth[i]) * rowH;
  // routing first (so boxes draw on top)
  for (const [m, c] of alg.edges) {
    const x0 = posX(m) + boxW / 2;
    const y0 = posY(m) + boxH;
    const x1 = posX(c) + boxW / 2;
    const y1 = posY(c);
    lcd.line(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
  }
  for (let i = 0; i < 4; i++) {
    const o = p.fm.ops[i];
    const level = o.level;
    const bx = posX(i);
    const by = posY(i);
    lcd.fillRect(bx, by, boxW, boxH);
    lcd.text(bx + 1, by + 2, `O${i + 1}`, { inverse: true });
    // level meter inside box (right side)
    const meterH = boxH - 4;
    const filled = Math.round(level * meterH);
    for (let k = 0; k < filled; k++) lcd.px(bx + boxW - 3, by + boxH - 2 - k);
    lcd.unpx(bx + boxW - 2, by + boxH - 2);
  }
  // fixed bottom status row so it never collides with the operator graph
  const y2 = y + h - 7;
  lcd.text(x, y2, `N${Math.round(p.fm.noise * 9)} FB${Math.round(p.fm.ops[0].feedback * 9)} IDX${Math.round(p.fm.index * 9)}`);
}

/** Mono engine: one cycle of the actual engine's waveshape, drawn approximately. */
function drawMonoVisual(lcd: Lcd, p: TrackParams, x: number, y: number, w: number, h: number) {
  const info = MONO_ENGINE_INFO[p.mono.engine];
  lcd.text(x, y, info.name);
  lcd.text(x, y + 7, info.blurb.slice(0, 20));
  const mid = y + 30 + Math.floor((h - 30) / 2);
  const innerH = Math.floor((h - 34) / 2);
  lcd.rect(x, y + 28, w, h - 30);
  const cycles = 2;
  const points = w - 2;
  for (let i = 0; i < points; i++) {
    const t = (i / points) * cycles;
    const ph = t % 1;
    const v = shapeValue(p.mono.engine, ph, p.mono.p1, p.mono.p2, p.mono.p3);
    const yy = mid - Math.round(v * innerH);
    lcd.px(x + 1 + i, yy);
    if (i > 0) {
      const prev = shapeValue(p.mono.engine, ((i - 1) / points) * cycles % 1, p.mono.p1, p.mono.p2, p.mono.p3);
      lcd.line(x + i, mid - Math.round(prev * innerH), x + 1 + i, yy);
    }
  }
}

function shapeValue(engine: string, ph: number, p1: number, p2: number, p3: number): number {
  switch (engine) {
    case 'analog': {
      const saw = 2 * ph - 1;
      const sq = ph < 0.5 ? 1 : -1;
      return saw * (1 - p3) + sq * p3;
    }
    case 'wavetable': {
      const pos = p1 * 5;
      const a = Math.sin(2 * Math.PI * ph) + 0.3 * Math.sin(2 * Math.PI * 3 * ph);
      const b = Math.sin(2 * Math.PI * ph * (1 + Math.floor(pos)));
      return a * (1 - (pos % 1)) + b * (pos % 1);
    }
    case 'phasedist': {
      const d = 0.02 + p1 * 0.96;
      const pp = ph < d ? (ph / d) * 0.5 : 0.5 + ((ph - d) / (1 - d)) * 0.5;
      return Math.sin(2 * Math.PI * pp);
    }
    case 'sid': return ph < 0.1 + p1 * 0.8 ? 1 : -1;
    case 'dnoise': return Math.sin(2 * Math.PI * ph * (1 + p2 * 6)) * (0.5 + 0.5 * Math.sin(ph * 90));
    case 'metallic': return (Math.sin(2 * Math.PI * ph) + Math.sin(2 * Math.PI * ph * 2.76) * 0.6) / 1.6;
    case 'ringmod': return Math.sin(2 * Math.PI * ph) * Math.sin(2 * Math.PI * ph * (0.5 + p1 * 8));
    default: return Math.sin(2 * Math.PI * ph) * (1 + p1 * Math.sin(2 * Math.PI * ph * 4));
  }
}

/** Sample waveform with trim/loop/slice markers. */
function drawSampleVisual(
  lcd: Lcd, store: Store, p: TrackParams, x: number, y: number, w: number, h: number, detailed: boolean,
) {
  const s = p.sample;
  const meta = s.sampleId ? store.samples.get(s.sampleId) : null;
  lcd.text(x, y, (meta?.name ?? 'NO SAMPLE').slice(0, 14));
  const waveY = y + 9;
  const waveH = h - (detailed ? 26 : 18);
  lcd.rect(x, waveY, w, waveH);
  if (!meta) {
    lcd.text(x + 6, waveY + Math.floor(waveH / 2) - 3, 'LOAD SAMPLE');
    return;
  }
  const peaks = meta.peaks.length ? meta.peaks : [0];
  lcd.wave(x + 1, waveY + 1, w - 2, waveH - 2, peaks, 'fill');
  const innerW = w - 3;
  const markerX = (v: number) => x + 1 + Math.round(Math.max(0, Math.min(1, v)) * innerW);
  // start / end markers
  lcd.vLine(markerX(s.start), waveY, waveH);
  lcd.vLine(markerX(s.end), waveY, waveH);
  // loop markers (dotted)
  if (s.loopMode !== 'off') {
    for (let yy = waveY; yy < waveY + waveH; yy += 2) {
      lcd.px(markerX(s.start + (s.end - s.start) * s.loopStart), yy);
      lcd.px(markerX(s.start + (s.end - s.start) * s.loopEnd), yy);
    }
  }
  // slices
  if (s.slices > 1) {
    for (let i = 0; i <= s.slices; i++) {
      const v = s.start + (s.end - s.start) * (i / s.slices);
      for (let yy = waveY + 1; yy < waveY + 4; yy++) lcd.px(markerX(v), yy);
    }
  }
  if (detailed && meta.transients.length) {
    for (const t of meta.transients) {
      if (t >= s.start && t <= s.end) {
        const mx = markerX(t);
        lcd.text(mx, waveY + waveH - 8, '·');
      }
    }
  }
  if (detailed) {
    lcd.text(x, waveY + waveH + 2, s.loopMode === 'off' ? '1SHOT' : s.loopMode === 'forward' ? 'LOOP' : 'PING');
    lcd.text(x + 34, waveY + waveH + 2, s.reverse ? 'REV' : 'FWD');
    lcd.textRight(x + w, waveY + waveH + 2, `${s.slices}SL ${s.pitch >= 0 ? '+' : ''}${s.pitch}ST`);
  }
}

/** Filter magnitude response curve (approximation of the actual topology). */
function drawFilterCurve(lcd: Lcd, p: TrackParams, x: number, y: number, w: number, h: number) {
  const f = p.filter;
  lcd.text(x, y, `${f.type} ${f.cutoff >= 1000 ? `${(f.cutoff / 1000).toFixed(1)}K` : Math.round(f.cutoff)}`);
  const gh = h - 12;
  lcd.rect(x, y + 10, w, gh);
  const q = 0.7 + f.reso * 14;
  const pos = (i: number) => x + 1 + i;
  const toY = (mag: number) => y + 10 + gh - 2 - Math.round(Math.max(0, Math.min(1.4, mag)) / 1.4 * (gh - 4));
  const pts: number[] = [];
  for (let i = 0; i < w - 2; i++) {
    const freq = 20 * Math.pow(1000, i / (w - 2));
    const w0 = freq / f.cutoff;
    let mag: number;
    const denom = Math.sqrt(Math.pow(1 - w0 * w0, 2) + Math.pow(w0 / q, 2));
    switch (f.type) {
      case 'LP12': mag = 1 / denom; break;
      case 'LP24': mag = 1 / (denom * denom); break;
      case 'HP12': mag = (w0 * w0) / denom; break;
      case 'BP12': mag = (w0 / q) / denom; break;
      default: mag = Math.abs(1 - w0 * w0) / denom; break;
    }
    pts.push(toY(mag * (1 + f.drive * 0.6)));
  }
  for (let i = 1; i < pts.length; i++) lcd.line(pos(i - 1), pts[i - 1], pos(i), pts[i]);
  // cutoff grid line
  const cx = Math.round(pos((w - 2) * (Math.log(f.cutoff / 20) / Math.log(1000))));
  for (let yy = y + 11; yy < y + 10 + gh; yy += 3) lcd.px(cx, yy);
}

function drawAmpEnv(lcd: Lcd, p: TrackParams, x: number, y: number, w: number, h: number) {
  lcd.text(x, y, `ENV ${Math.round(p.amp.vel * 100)}% VEL`);
  lcd.envelope(x, y + 9, w, h - 11, p.amp.atk, p.amp.dec, p.amp.sus, p.amp.rel);
}

function drawLfo(lcd: Lcd, p: TrackParams, x: number, y: number, w: number, h: number) {
  const l = p.lfo;
  lcd.text(x, y, `${l.shape} ${l.sync ? 'SYNC' : `${l.speed.toFixed(1)}HZ`}`);
  lcd.text(x, y + 7, `${l.dest} ${Math.round(l.depth * 100)}%`);
  const top = y + 16;
  const gh = h - 18;
  lcd.rect(x, top, w, gh);
  const mid = top + Math.floor(gh / 2);
  const amp = (gh / 2 - 2) * Math.max(0.05, l.depth);
  const points = w - 2;
  for (let i = 0; i < points; i++) {
    const ph = (i / points) * 2;
    let v = 0;
    switch (l.shape) {
      case 'TRI': v = 4 * Math.abs((ph % 1) - 0.5) - 1; break;
      case 'SAW': v = (ph % 1) * 2 - 1; break;
      case 'SQR': v = (ph % 1) < 0.5 ? 1 : -1; break;
      case 'S&H': v = Math.sin(Math.floor(ph * 4) * 12.9898) * 0.9; break;
      case 'RAMP': v = 1 - (ph % 1) * 2; break;
      default: v = Math.sin(ph * Math.PI * 2); break;
    }
    lcd.px(x + 1 + i, mid - Math.round(v * amp));
  }
  lcd.hLine(x + 1, mid, w - 2);
}

function drawFxVisual(lcd: Lcd, store: Store, p: TrackParams, x: number, y: number, w: number, h: number) {
  lcd.text(x, y, 'SEND LEVELS');
  const rows: [string, number][] = [
    ['DELAY', p.sendA],
    ['REVERB', p.sendB],
    ['DIST', p.fx.distortion],
    ['MOD', p.fx.mod],
  ];
  rows.forEach(([label, v], i) => {
    const yy = y + 10 + i * 9;
    lcd.text(x, yy, label);
    lcd.valueBar(x + 38, yy + 1, w - 38, v, { h: 5 });
  });
  const m = store.project.master;
  const chainOn = m.chain.filter((c) => c.on).map((c) => c.type);
  lcd.text(x, y + h - 10, `${m.compOn ? 'COMP' : '----'} ${chainOn.length ? chainOn.join('+').slice(0, 10) : ''}`);
  lcd.text(x, y + h - 3, `MAS ${Math.round(m.volume * 100)} DRV ${Math.round(m.drive * 100)}`);
}

function drawModVisual(lcd: Lcd, p: TrackParams, x: number, y: number, w: number, h: number) {
  const keys = ENGINE_PAGES[p.engine].mod;
  lcd.text(x, y, 'MODULATION');
  keys.forEach((k, i) => {
    const yy = y + 11 + i * 11;
    lcd.text(x, yy, (PARAM_DEFS[k]?.label ?? '').slice(0, 7));
    lcd.valueBar(x + 42, yy + 1, w - 42, getNorm(p, k), {
      h: 6, bipolar: !!PARAM_DEFS[k]?.bipolar,
    });
  });
  lcd.text(x, y + h - 8, `LFO→${p.lfo.dest}`);
}

/* ------------------------------------------------------- page strip helper --- */

export function pageStrip(page: PageId): string {
  return PAGE_ORDER.map((p) => (p === page ? `[${pageTitle(p)}]` : pageTitle(p))).join(' ');
}

export const SCREEN_PAGES = PAGE_ORDER;

export function normalizeSteps(list: number[], total: number): number[] {
  return list.map((s) => s % Math.max(1, total));
}

export function engineLabel(e: EngineKind): string {
  return e === 'fm' ? 'FM' : e === 'mono' ? 'MONO' : 'SMPL';
}

export function trigCondAt(i: number) {
  return TRIG_CONDS[i];
}

export function paramValueText(key: string, params: TrackParams) {
  return formatValue(key, getNorm(params, key));
}

export function paramRealValue(key: string, norm: number) {
  return normToValue(key, norm);
}


