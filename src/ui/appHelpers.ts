/**
 * Small helpers shared by the app shell (presets re-export, default note maps).
 */
export { FM_PRESETS, MONO_PRESETS, applyFMPreset } from '../state/presets';

/** Default note used when a pad is tapped, per track role (percussive vs melodic). */
export function defaultNoteForEngine(engine: string, track: number): number {
  if (engine === 'sample') return 60;
  return track < 4 ? 45 : 57;
}

export function sectionForTrack(_track: number): string {
  return 'GENERAL';
}

export function buildPatternFrom(name: string, tempo: number) {
  return { name, tempo };
}

/** MIDI note number -> readable name (C-1 .. G9, Elektron style octave numbering). */
export function noteName(note: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const n = Math.max(0, Math.min(127, Math.round(note)));
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}
