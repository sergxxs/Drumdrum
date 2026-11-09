/** Message protocol between the UI thread and the AudioWorklet. */
import type { Kit, MasterParams, Pattern, Project, SampleMeta, SendParams } from '../state/types';

export interface SampleTransfer {
  meta: SampleMeta;
  left: Float32Array;
  right: Float32Array | null;
}

export type AudioHostMessage =
  | { type: 'init'; project: Project; samples: SampleTransfer[]; sampleIds: string[] }
  | { type: 'pattern'; pattern: Pattern }
  | { type: 'kit'; kit: Kit }
  | { type: 'tempo'; tempo: number }
  | { type: 'swing'; swing: number }
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'trigger'; track: number; note: number; vel: number; lengthFrames?: number }
  | { type: 'release'; track: number; note: number }
  | { type: 'param'; track: number; key: string; value: number }
  | { type: 'master'; master: Partial<MasterParams> }
  | { type: 'sends'; sends: Partial<SendParams> }
  | { type: 'fill'; on: boolean }
  | { type: 'click'; on: boolean }
  | { type: 'songMode'; on: boolean }
  | { type: 'patterns'; patterns: Pattern[] }
  | { type: 'recStart' }
  | { type: 'recStop' }
  | { type: 'sample'; meta: SampleMeta; left: Float32Array; right: Float32Array | null }
  | { type: 'sampleRemove'; id: string }
  | { type: 'chain'; chain: number[]; loop: boolean }
  | { type: 'loadSong'; index: number };

export interface MeterMessage {
  type: 'meters';
  tracks: number[];
  masterL: number;
  masterR: number;
  step: number;
  stepAll: number[];
  pass: number;
  playing: boolean;
  frame: number;
  recFrames: number;
}

export interface RecordingReply {
  type: 'recording';
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export type HostReply =
  | { type: 'ready' }
  | MeterMessage
  | RecordingReply
  | { type: 'error'; message: string };
