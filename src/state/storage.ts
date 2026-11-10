/**
 * Persistence: IndexedDB (project JSON + sample audio as Float32 blobs) with a
 * localStorage fallback for the project document. Autosave keeps the last N snapshots.
 */
import type { Project, SampleMeta } from './types';

const DB_NAME = 'hybrid-groovebox';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_SAMPLES = 'samples';
const LS_KEY = 'hybrid-groovebox:project';
const LS_AUTOSAVE = 'hybrid-groovebox:autosave';

export interface StoredSample {
  meta: SampleMeta;
  left: Float32Array;
  right: Float32Array | null;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS);
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) db.createObjectStore(STORE_SAMPLES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result: T | null = null;
      const req = fn(os);
      if (req) {
        req.onsuccess = () => {
          result = req.result as T;
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/* ---------------------------------------------------------------- project --- */

export async function saveProject(project: Project, slot = 'autosave'): Promise<boolean> {
  const doc = { ...project, savedAt: Date.now() };
  const ok = await withStore(STORE_PROJECTS, 'readwrite', (s) => s.put(doc, slot));
  // local fallback keeps the UI usable if IndexedDB is blocked (private mode)
  let local = false;
  try {
    localStorage.setItem(slot === 'autosave' ? LS_AUTOSAVE : LS_KEY, JSON.stringify(doc));
    local = true;
  } catch {
    /* quota / private mode */
  }
  return ok !== null || local;
}

export async function loadProject(slot = 'autosave'): Promise<Project | null> {
  const doc = await withStore<Project>(STORE_PROJECTS, 'readonly', (s) => s.get(slot));
  if (doc) return migrate(doc);
  try {
    const raw = localStorage.getItem(slot === 'autosave' ? LS_AUTOSAVE : LS_KEY);
    if (raw) return migrate(JSON.parse(raw) as Project);
  } catch {
    /* ignore */
  }
  return null;
}

export async function listProjects(): Promise<{ slot: string; name: string; savedAt: number }[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const os = tx.objectStore(STORE_PROJECTS);
      const out: { slot: string; name: string; savedAt: number }[] = [];
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          const v = cur.value as Project;
          out.push({ slot: String(cur.key), name: v.name, savedAt: v.savedAt ?? 0 });
          cur.continue();
        }
      };
      tx.oncomplete = () => resolve(out.sort((a, b) => b.savedAt - a.savedAt));
      tx.onerror = () => resolve(out);
    } catch {
      resolve([]);
    }
  });
}

export async function deleteProject(slot: string): Promise<void> {
  await withStore(STORE_PROJECTS, 'readwrite', (s) => s.delete(slot));
}

/* ---------------------------------------------------------------- samples --- */

export async function saveSample(sample: StoredSample): Promise<boolean> {
  const rec = {
    meta: sample.meta,
    left: sample.left,
    right: sample.right,
  };
  const ok = await withStore(STORE_SAMPLES, 'readwrite', (s) => s.put(rec, sample.meta.id));
  return ok !== null;
}

export async function loadSample(id: string): Promise<StoredSample | null> {
  const rec = await withStore<StoredSample>(STORE_SAMPLES, 'readonly', (s) => s.get(id));
  return rec ?? null;
}

export async function loadAllSamples(): Promise<StoredSample[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_SAMPLES, 'readonly');
      const os = tx.objectStore(STORE_SAMPLES);
      const out: StoredSample[] = [];
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push(cur.value as StoredSample);
          cur.continue();
        }
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(out);
    } catch {
      resolve([]);
    }
  });
}

export async function deleteSample(id: string): Promise<void> {
  await withStore(STORE_SAMPLES, 'readwrite', (s) => s.delete(id));
}

/* ----------------------------------------------------------------- export --- */

/** Trigger a browser download (iOS Safari will offer "Save to Files"). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
}

/* --------------------------------------------------------------- migrations --- */

export function migrate(p: Project): Project {
  // Forward-compatible defaults for projects saved by older builds.
  if (!p.settings) {
    p.settings = {
      masterVol: 0.8, showVelocity: true, contrast: 0.6, click: false, recQuant: 0,
      midiCh: 1, autosave: true, scale: 1,
    };
  }
  if (!p.master && p.kits?.[0]) p.master = p.kits[0].master;
  if (!p.chain) p.chain = [];
  if (p.chainLoop === undefined) p.chainLoop = true;
  if (!Array.isArray(p.samples)) p.samples = [];
  // Older builds shipped a WIDTH insert that duplicated master.width and did nothing on
  // its own; drop it so the chain only contains effects that actually process audio.
  if (Array.isArray(p.master?.chain)) {
    p.master.chain = p.master.chain.filter((c) => c.type !== 'WIDTH');
    if (p.master.chain.length === 0) {
      p.master.chain = [
        { type: 'DIST', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
        { type: 'CRUSH', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
        { type: 'MOD', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
        { type: 'RING', on: false, mix: 0.2, p1: 0.5, p2: 0.5, p3: 0.5 },
      ];
    }
  }
  return p;
}
