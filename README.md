# HYBRID GROOVEBOX

An 8-track hybrid synthesizer and drum machine for the browser, built for iPhone.
Three engines per track, an Elektron-style sequencer with parameter locks, trigger
conditions and motion recording, a real effects chain, and a hardware faceplate with a
192×88 pixel LCD.

**This is an instrument, not a mockup.** Every knob moves a DSP parameter, every step
triggers a note, every effect processes audio, and every export writes a real file.
The test suite proves it: 66 tests render audio and assert on the samples.

```bash
npm install
npm run dev        # http://localhost:5173  (dev server, rebuilds the worklet on change)
npm run build      # production build -> dist/
npm test           # 81 audio / sequencer / storage / export / UI tests
npm run smoke      # headless render of the factory project, prints per-track levels
node scripts/boot-check.mjs              # boots the app headlessly and drives every control
npx vite-node scripts/demo-export.ts     # renders docs/demo/factory-pattern.mp3
npx vite-node scripts/lcd-shots.ts       # renders all 14 screens to docs/lcd/*.png
```

**Listen to it first:** `docs/demo/factory-pattern.mp3` (8 bars, 192 kbps) and
`docs/demo/factory-pattern.wav` are produced by the app's own export path from the
factory project — no external DAW, no overdubs.

---

## 1. What you get

| Area | Implementation |
| --- | --- |
| Engines | 4-op FM (8 algorithms), 8 digital synth models, sampler |
| Tracks | 8, freely configurable, independent engine / filter / FX / sequence |
| Sequencer | 64 steps, per-track length & speed, swing, p-locks, trig conditions, motion recording, live recording, song mode, pattern chain |
| Effects | per-track distortion + chorus/flanger/phaser, ping-pong delay send, FDN reverb send, 4-slot master insert chain (drive, bitcrush, mod, ringmod) + 3-band EQ + stereo width + compressor |
| Display | 192×88 1-bit LCD with a hand-built 5×7 bitmap font, 14 screens |
| Controls | VALUE encoder, 4 parameter encoders (A–D), 8 pads, 6 mode buttons, transport, 13 function keys, mute/solo, 2 trim encoders |
| Export | WAV 16-bit and MP3 (LAME) — master mix, song, single track, or all 8 tracks |
| Storage | project + samples in IndexedDB (localStorage fallback), autosave, named slots |
| Delivered audio | `docs/demo/factory-pattern.{mp3,wav}` rendered through the real export engine |

## 2. Architecture

```
              ┌───────────────────────────── UI (src/ui) ─────────────────────────────┐
              │ hardware panel · LCD page renderers · pixel font · dialogs · gestures │
              └───────────────▲───────────────────────────────┬───────────────────────┘
                     meters   │                               │ parameter edits (normalised)
              ┌───────────────┴───────────────────────────────▼───────────────────────┐
              │ Store (src/state): project, kits, patterns, samples, undo, autosave   │
              └───────────────┬───────────────────────────────────────────────────────┘
                              │ messages (patterns, kit, param, transport)
              ┌───────────────▼───────────────────────────────────────────────────────┐
              │ AudioService — AudioWorklet host, ScriptProcessor fallback            │
              ├───────────────────────────────────────────────────────────────────────┤
              │ AudioEngine (src/audio/engine.ts) — THE one audio path                │
              │  ├── TrackEngine ×8  ── FMEngine / MonoEngine / SampleEngine           │
              │  │      └── filter (SVF / ladder) · LFO · choke · pan · sends          │
              │  ├── SequencerEngine (src/seq) — sample-accurate step clock            │
              │  ├── Effects (delay bus, reverb bus, master chain)                    │
              │  └── Recorder (live master capture)                                   │
              └───────────────▲───────────────────────────────────────────────────────┘
                              │ identical code, no Web Audio dependency
              ┌───────────────┴───────────────┐
              │ OfflineHost (export)          │ Node (tests, smoke render)             │
              └───────────────────────────────┘
```

The important decision: **the DSP has no Web Audio dependency.** `AudioEngine.processInto()`
renders stereo blocks from a sample-accurate frame counter. An `AudioWorkletProcessor`
calls it in real time; the exporter and the test suite call it offline. That is why
"what you export is what you heard" is a structural guarantee rather than a promise, and
why the whole instrument can be tested without a browser.

Live parameter edits are sent as `{track, key, value}` messages; the worklet writes them
into the same kit objects the DSP reads. Parameter locks and motion automation are merged
into a per-track *effective* parameter struct once per block, so the stored kit is never
mutated by the sequencer.

## 3. Sound engines

### A — FM (`src/audio/fm.ts`)
Four sine operators, 8 routing algorithms, per-operator ADSR (which is what makes
percussive FM possible), per-operator feedback, global FM index in radians, harmonic
carrier doubling, noise injection, amp modulation, pitch envelope, glide, saturation.
Ratio table of 32 musical ratios (0.25× … 32×) plus fixed-frequency mode.
Presets: KICK, SNARE, METALLIC, BELL, DIGI BASS, GLASS, PERC, FX RISE.

### B — MONO (`src/audio/mono.ts`)
Eight genuinely different oscillator architectures, not presets of one engine:

| Engine | Method |
| --- | --- |
| ANALOG | dual detuned saw/pulse crossfade, PWM, sub osc, sync |
| WAVETBL | 6 additive wavetables (24-term spectra), continuous morph + phase warp + formant |
| P.DIST | Casio-CZ style phase-distortion transfer function with resonant window |
| SID | pulse + PWM + ring mod + hard sync + bit-crushed stepped output |
| DNOISE | sample-rate-reduced noise through a tuned comb (chip noise / Karplus) |
| METAL | 6–8 inharmonic partials with noise transient burst |
| RINGMD | ring modulation with feedback-FM and wave folding |
| DIGITAL | bit-manipulated phase accumulator with rate reduction |

### C — SAMPLE (`src/audio/sample.ts`)
Trim start/end, forward & ping-pong loop, reverse, pitch (+rate), slice mapping across
notes, choke groups (cross-track), waveshaper (crush/fold/drive), ADSR, linear-phase-free
granular OLA time-stretch, transient detection, peak envelope for the display.
Import from iPhone Files: WAV is parsed by our own decoder (8/16/24/32-bit PCM + float),
MP3/M4A/AIFF go through the browser decoder, everything is resampled to the engine rate
and stored in IndexedDB. Factory samples (vocal formant, tape hiss, metallic clang, a
slicing-ready break, a sub sine) are synthesised at boot, so the sampler is usable before
you import anything.

## 4. Sequencer

- 64 steps, independent per-track length and speed (1×, ½, ⅓, ¼ → polyrhythms).
- Swing on odd steps, tempo 30–300, tap tempo.
- **Parameter locks**: hold P/LOCK (◎), turn any encoder — the value is stored on the
  current step. Locks are applied at note-on *and held* until the next trig (Elektron
  semantics), so a locked filter survives the whole decay.
- **Trig conditions**: 1:2 1:3 1:4 2:2 2:3 2:4 3:4 50% 25% FILL NOTFILL FIRST LAST.
  Probability uses a seeded PRNG so renders are reproducible.
- **Motion recording**: hold MOTION (∿); encoder moves are written to automation lanes and
  replayed per step (p-locks override lanes).
- **Live recording**: arm LIVE REC, hit pads — hits are quantised into the pattern.
- **Song mode / chain**: the audio thread advances patterns itself at pattern boundaries.
- Timing is an absolute frame counter: steps land on the exact sample (`5512.5` frames per
  16th at 120 BPM is asserted in the tests, ±1 frame).

## 5. Using it

| Control | Action |
| --- | --- |
| Pads 1–8 | select track · tap to play (velocity from pad position) |
| Encoders A–D | edit the 4 parameters of the visible page |
| Page ◀ ▶ / tap an encoder label | SOUND · FILTER · AMP · LFO · FX · MOD (and SAMPLE) |
| VALUE | fine edit · tempo · scroll lists · confirm |
| PATTERN / KIT / SONG / MIX / FX / SETUP | screen modes; turning an encoder "peeks" the parameter page |
| Center (OK) | PATTERN: open the trig editor · KIT: engine picker |
| PATTERN long-press | FILL switch (drives FILL / NOTFILL conditions) |
| ◎ / ∿ | parameter lock / motion record |
| REC | record the master output · SELECT: export dialog · MP3/WAV: format |
| ♩ | tap tempo |

Everything is also reachable by tapping: pads, mode buttons, transport, function row,
overlay lists.

## 6. Export

Offline render through the same engine (2 bars / 4 / 8 / whole song / individual tracks /
single track), normalised to −0.4 dBFS, then either:

- **WAV** — 16-bit PCM 44.1 kHz stereo, written by our own encoder.
- **MP3** — 192 kbps stereo via the vendored LAME port (`public/vendor/lame.all.js`).

Files are delivered through a normal download link, so iOS offers *Save to Files*.
Live `REC` captures the master bus from the worklet (transferred back as Float32 buffers)
and saves the same way.

## 7. iPhone notes

- Audio unlocks on the first touch (`AudioContext.resume()`), then the worklet loads.
- If `audioWorklet` is unavailable (older WebKit, some embedded browsers), the app falls
  back to a `ScriptProcessorNode` running the *same* engine. The SETUP page shows which
  host is live.
- No page scroll, no pinch zoom, no text selection, no double-tap zoom; `touch-action`
  and `overscroll-behavior` are set, and the viewport is locked.
- **Layout**: on wide screens the faceplate is uniformly scaled. On phones/small windows
  (`wideScale < 0.58`) the same controls reflow into a compact column which is then scaled
  to fit the viewport exactly — the LCD lands at roughly 1.7–2× its native pixel scale on
  an iPhone in landscape, and every touch target stays ≥ 26 CSS px after scaling.
- Autosave on every edit (debounced) and on tab hide; reload restores the project.

## 8. Known limitations (honest list)

- **Time-stretch** is a 2-grain overlap-add stretcher. At 0.5× / 2× it is usable but
  smears transients; a phase vocoder would be the proper fix.
- **MP3 encoding** runs on the main thread (~5–10× faster than realtime) with a progress
  bar, because LAME has no worker-friendly entry point in this port.
- **Velocity** on iOS comes from the pad position (strike point), not touch pressure.
- **No MIDI hardware**; the SETUP page exposes a channel and the note map is fixed
  (pads = C3..G4 by track). Web MIDI output would be the next step.
- **Polyphony** is 8 voices per track; voice stealing takes the quietest voice.
- **Free-running LFOs** are updated once per audio block (256 frames ≈ 5.8 ms), which is
  inaudible at ≤40 Hz but is not per-sample.
- The master **width** control is a single stereo-width parameter on the master bus; it is
  deliberately *not* also a chain insert (an older build had both, which meant one of
  them did nothing — the duplicate is removed and migrated away).
- Songs play through *pattern* boundaries only (no mid-pattern jumps).
- The patterns/kit/sample lists scroll with the VALUE encoder or by scrolling the overlay;
  there is no search field yet.

## 9. Tests

| File | Covers |
| --- | --- |
| `tests/audio.test.ts` | every FM/mono/sample preset is audible, notes are in tune, FM index adds sidebands, all 8 mono models differ, slice/reverse/choke behaviour, filter & pan & reverb & distortion affect the signal |
| `tests/sequencer.test.ts` | sample-accurate grid, swing, per-track speed, track length, mute, p-locks reach the DSP and change audio, automation precedence, all trig conditions, song/chain advancement with repeat counts, metronome, arrangement editing, store actions |
| `tests/storage-export.test.ts` | WAV header correctness + round-trip, 8/16/24/32-bit import against hand-built RIFF files, malformed-file rejection, transient detection, save/load/migrate, per-track export files, song export, determinism, all 8 tracks audible through the exporter, every master insert measurably processes audio, mono/wide width correlation |
| `tests/worklet.test.ts` | loads the built worklet bundle, asserts silence before init, audio after, parameter messages, meter messages |
| `tests/ui.test.ts` | the 5×7 font is complete, all 6 modes + every parameter page render visible content without filling the screen, out-of-bounds safety, choice-parameter round-tripping (filter type, LFO shape/destination) |

`scripts/boot-check.mjs` additionally boots `index.html` in a real DOM (linkedom), stubs
Web Audio, and drives every button, encoder, pad, dialog and an export — asserting that
the FX-send and master encoders actually move state.

`scripts/lcd-shots.ts` renders all 14 screens through the production page renderers to
`docs/lcd/*.png`, so screen regressions are visible without a browser.

## 10. Project layout

```
index.html                 faceplate markup
src/main.ts                entry point
src/audio/                 dsp primitives, 3 engines, track, effects, engine, host, export codecs
src/seq/                   sequencer clock + trig condition logic
src/state/                 types, parameter dictionary, presets, store, persistence
src/ui/                    LCD renderer, font, page renderers, hardware gestures, app shell
src/export/render.ts       offline render + WAV/MP3 writing
scripts/                   build, dev (worklet bundling), smoke render, boot check, LCD shots
tests/                     vitest suites + headless DOM stub
docs/lcd/*.png             rendered screens (generated by scripts/lcd-shots.ts)
docs/demo/*.mp3,.wav       listenable export of the factory project
PLAN.md                    the implementation plan written before coding
```
