/**
 * Crash-recovery autosave.
 *
 * The project MODEL (text, timings, styles, automation, background settings —
 * everything that lives in project.json) is snapshotted into IndexedDB with a
 * debounce after every change. The MEDIA BYTES (audio per role + the
 * background video) live outside the model — they are kept in a SEPARATE
 * store and synced only when their identity changes (len + head/tail sample),
 * so the debounced model writes never rewrite hundreds of megabytes.
 *
 * On the next app start, if a snapshot exists, a restore bar is offered
 * («Восстановить / ✕»); restoring rehydrates the model AND reloads the media
 * into the audio engine / background video, so waveforms, the filmstrip and
 * playback come back fully.
 *
 * Deliberate properties:
 *  - the DEFAULT empty project is never saved (opening the app can't clobber
 *    a recovery snapshot) — "has content" = audio loaded, duration known, or
 *    more than the placeholder syllable typed;
 *  - unchanged projects are not re-written (serialized compare); unchanged
 *    media is not re-written either (identity compare);
 *  - quota failures degrade gracefully: the model still restores, missing
 *    media shows "not loaded — re-pick the file" hints;
 *  - dismissing the bar deletes BOTH stores (an explicit rejection);
 *    restoring keeps them (a restored-but-unedited project stays recoverable).
 *
 * E2E seam: localStorage['test-autosave-delay-ms'] overrides the debounce.
 */
import { store } from '../state/store';
import { AudioRole, Project, getAudioTrackByRole } from '../types';
import { getAudioBytesMap } from './audioLoader';
import { getBgVideoBytes, loadBgVideo } from './backgroundVideo';
import { audioEngine } from './audioEngine';

const DB_NAME = 'karaoke-autosave';
const DB_VERSION = 2;
const STORE = 'snapshots';
const MEDIA_STORE = 'media';
const KEY = 'project';
const META_KEY = 'media-meta';
const SAVE_DELAY_MS = 4000;

interface Snapshot {
  savedAt: number;
  project: Project;
}

/** Cheap media identity: length + head/tail samples (16 bytes each). */
interface MediaMeta {
  len: number;
  head: string;
  tail: string;
}

function saveDelay(): number {
  try {
    return Number(localStorage.getItem('test-autosave-delay-ms') ?? 0) || SAVE_DELAY_MS;
  } catch {
    return SAVE_DELAY_MS;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(MEDIA_STORE)) req.result.createObjectStore(MEDIA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

function hasContent(p: Project): boolean {
  if (p.durationMs > 0) return true;
  if (p.tracks.some((t) => t.type === 'audio' && t.audioFileName)) return true;
  return p.tracks.some(
    (t) => t.type === 'text' && (t.lines.length > 1 || (t.lines[0]?.syllables.length ?? 0) > 1),
  );
}

// --- Media sync (identity-based, no big rewrites) ---

function mediaIdentity(bytes: Uint8Array): MediaMeta {
  const head = new TextDecoder().decode(bytes.subarray(0, 16));
  const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 16)));
  return { len: bytes.length, head, tail };
}

/** In-memory copy of the stored media identities (seeded from the meta record). */
let storedMeta: Record<string, MediaMeta> = {};

async function loadStoredMeta(): Promise<void> {
  try {
    storedMeta = (await withStore<Record<string, MediaMeta> | undefined>(MEDIA_STORE, 'readonly', (s) => s.get(META_KEY))) ?? {};
  } catch {
    storedMeta = {};
  }
}

/** The current media candidates: audio roles + the background video. */
function currentMedia(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [role, bytes] of getAudioBytesMap()) out.set(`audio:${role}`, bytes);
  const bg = getBgVideoBytes();
  if (bg) out.set('bgvideo', bg);
  return out;
}

async function syncMedia(): Promise<void> {
  const nextMeta: Record<string, MediaMeta> = {};
  for (const [key, bytes] of currentMedia()) {
    const id = mediaIdentity(bytes);
    nextMeta[key] = id;
    const prev = storedMeta[key];
    if (prev && prev.len === id.len && prev.head === id.head && prev.tail === id.tail) continue;
    try {
      await withStore(MEDIA_STORE, 'readwrite', (s) => s.put(bytes, key));
    } catch {
      /* quota — best-effort: keep the model snapshot useful without media */
    }
  }
  // Drop stored media whose sources are gone (role cleared / bg reset).
  for (const key of Object.keys(storedMeta)) {
    if (!(key in nextMeta)) {
      try {
        await withStore(MEDIA_STORE, 'readwrite', (s) => s.delete(key));
      } catch {
        /* best-effort */
      }
    }
  }
  storedMeta = nextMeta;
  try {
    await withStore(MEDIA_STORE, 'readwrite', (s) => s.put(storedMeta, META_KEY));
  } catch {
    /* best-effort */
  }
}

// --- Model snapshot ---

let saveTimer: number | null = null;
let lastSavedJson = '';

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void (async () => {
      try {
        const p = store.getProject();
        if (!hasContent(p)) return;
        const json = JSON.stringify(p);
        if (json !== lastSavedJson) {
          await withStore(STORE, 'readwrite', (s) => s.put({ savedAt: Date.now(), project: p } as Snapshot, KEY));
          lastSavedJson = json;
        }
        await syncMedia();
      } catch {
        /* autosave is best-effort — never disturb the app */
      }
    })();
  }, saveDelay());
}

/** Read the snapshot (null when absent or unreadable). */
async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const snap = await withStore<Snapshot | undefined>(STORE, 'readonly', (s) => s.get(KEY));
    return snap ?? null;
  } catch {
    return null;
  }
}

async function deleteSnapshot(): Promise<void> {
  try {
    await withStore(STORE, 'readwrite', (s) => s.clear());
    await withStore(MEDIA_STORE, 'readwrite', (s) => s.clear());
    lastSavedJson = '';
    storedMeta = {};
  } catch {
    /* best-effort */
  }
}

/** Reload the saved media into the engines (audio voices + bg video). */
async function restoreMedia(project: Project): Promise<void> {
  const wanted: Array<[string, Uint8Array]> = [];
  try {
    const keys = await withStore<IDBValidKey[]>(MEDIA_STORE, 'readonly', (s) => s.getAllKeys());
    for (const key of keys) {
      if (key === META_KEY || typeof key !== 'string') continue;
      const bytes = await withStore<Uint8Array | undefined>(MEDIA_STORE, 'readonly', (s) => s.get(key));
      if (bytes) wanted.push([key, bytes]);
    }
  } catch {
    return; // media unreadable — the model still restores
  }
  for (const [key, bytes] of wanted) {
    try {
      if (key.startsWith('audio:')) {
        const role = key.slice('audio:'.length) as AudioRole;
        // The model already carries the filename/duration — engine-only load.
        if (getAudioTrackByRole(project, role)?.audioFileName) {
          await audioEngine.loadBytes(role, bytes, '');
        }
      } else if (key === 'bgvideo' && project.background.bgType === 'video') {
        await loadBgVideo(bytes);
      }
    } catch {
      /* one failed medium must not block the rest */
    }
  }
}

/** The startup restore bar: «found an autosave — restore it?». */
async function promptRestore(): Promise<void> {
  const snap = await readSnapshot();
  if (!snap || !hasContent(snap.project)) return;

  const bar = document.createElement('div');
  bar.className = 'autosave-bar';
  bar.dataset.testid = 'autosave-bar';

  const text = document.createElement('span');
  text.textContent = `Автосохранение от ${new Date(snap.savedAt).toLocaleTimeString()} — восстановить проект?`;

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'primary';
  restoreBtn.textContent = 'Восстановить';
  restoreBtn.dataset.testid = 'autosave-restore';
  restoreBtn.addEventListener('click', () => {
    store.setProject(snap.project);
    void restoreMedia(snap.project);
    bar.remove();
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = '✕';
  dismissBtn.title = 'Отклонить и удалить автосохранение';
  dismissBtn.dataset.testid = 'autosave-dismiss';
  dismissBtn.addEventListener('click', () => {
    bar.remove();
    void deleteSnapshot();
  });

  bar.appendChild(text);
  bar.appendChild(restoreBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
}

/** Wire autosave into the app (call once from main.ts). */
export function initAutosave(): void {
  void loadStoredMeta();
  store.subscribe(scheduleSave);
  void promptRestore();
}
