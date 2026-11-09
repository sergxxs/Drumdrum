# HYBRID GROOVEBOX — Implementation Plan

8-track hybrid groovebox (Elektron-inspired) for iPhone Safari. The repository started
empty (a README only), so this is a clean-room build: TypeScript + Vite, no runtime
dependencies, everything DSP written from scratch.

## 0. Repository findings (step 1–2 of the brief)

- `sergxxs/Drumdrum` contained only `README.md` and an initial commit.
- No framework, no toolchain, no audio code → nothing to preserve, free choice of stack.
- Nodes/22, Vite 8, Vitest available. No browser binaries are downloadable in this
  sandbox → verification must not depend on a headless browser.

## 1. Architecture decision — host-agnostic DSP

```
                    ┌──────────────────────────────┐
   UI (DOM/Canvas)  │  AudioEngine (src/audio)     │   AudioWorklet / Offline render
        │           │  ├── TrackEngine × 8         │◀── same code, same result
        ▼           │  │   ├── FMEngine  (A)      │
   Store (patterns, │  │   ├── MonoEngine (B)     │
   kits, p-locks)   │  │   └── SampleEngine (C)   │
        │           │  ├── EffectsEngine (per track + 2 sends + master)
        └──────────▶│  ├── MixerEngine             │
                    │  └── SequencerEngine ────────┘
                    └──────────────────────────────┘
```

The synthesis, sequencer and effects code is **plain TypeScript with no Web Audio
dependency**. `AudioEngine.renderFrame()` pulls one stereo sample block at a time from a
sample-accurate sequencer. Two hosts consume it:

- `LiveHost` — an `AudioWorkletProcessor` (falls back to a `ScriptProcessorNode` on Safari
  builds without module worklets). Receives commands/parameter changes via port messages.
- `OfflineHost` — synchronous render loop used by export and by Node unit tests.

Consequence: export is bit-identical to what you hear, and every audio/sequencer feature
is testable without a browser (`npm test`).

## 2. Modules

`src/audio/` — `dsp.ts` (RNG, filters, envelopes, waveshapers, saturators, delay line),
`fm.ts` (4-operator FM, 8 algorithms), `mono.ts` (8 distinct digital synth engines),
`sample.ts` (sampler, slicing, playback modes), `effects.ts`, `track.ts`, `mixer.ts`,
`engine.ts` (top-level + master chain), `recorder.ts`, `wav.ts`, `mp3.ts`.

`src/seq/` — `pattern.ts`, `trig.ts` (Euclid, probability, conditions), `sequencer.ts`
(sample-accurate clock, p-locks, motion automation, song mode, live recording).

`src/state/` — `store.ts` (project model, undo-less but autosaving), `presets.ts`,
`storage.ts` (IndexedDB with localStorage fallback for project + sample blobs).

`src/ui/` — `lcd.ts` (low-res framebuffer ink renderer, 4×5 pixel font, 1-bit dithering,
status flags), `pages.ts` (11 LCD pages), `hardware.ts` (encoders, pads, transport, LED
states), `dialogs.ts` (encoder-driven modal lists), `app.ts` (wiring), `styles.css`.

## 3. Sequencer

- 64 steps max, adjustable length, 1×/2×/3×/4× track speed, swing, tempo.
- Per-step: note/velocity/duration/micro-timing/conditional trig + arbitrary parameter locks.
- Trig conditions: 1:2 1:3 1:4 2:2 2:4 3:4 50% 25% Fill NotFill First Last (Elektron
  `PRE`-style chain evaluation per track).
- Motion recording: encoder edits during playback are written to the active track's
  automation lanes and applied sample-accurately; live recording quantised to the step grid.
- Song mode: chain of patterns with repeat counts; pattern chain / loop; autosave.

## 4. Verification (step 13 "no fake buttons")

- `vitest` suites assert real audio: FM/mono/sample engines produce non-silent, distinct,
  correctly-tuned output; filter sweeps move spectral centroid; p-locks alter rendered
  audio; trig conditions fire only on the right steps; WAV/MP3 encoders emit valid files;
  storage round-trips; sequencer timing stays sample-accurate.
- `npm run smoke` renders a demo performance in Node and prints RMS/peak per track.
- Manual browser pass on the live preview (touch, audio unlock, import/export).

## 5. Known limitations (documented, not hidden)

- MP3 via vendored LAME (public domain / LGPL port) — encoding is ~5–10× realtime.
- Time-stretch is a simple granular overlap-add (documented in the SAMPLE page help).
- No MIDI hardware I/O; `Setup` exposes MIDI note map + Web MIDI device list where the
  browser supports it.
