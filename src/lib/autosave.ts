/**
 * Crash-recovery autosave.
 *
 * The project MODEL (text, timings, styles, automation, background settings —
 * everything that lives in project.json) is snapshotted into IndexedDB with a
 * debounce after every change. On the next app start, if a snapshot exists, a
 * restore bar is offered («Восстановить / ✕»).
 *
 * Deliberate properties:
 *  - the DEFAULT empty project is never saved (opening the app can't clobber
 *    a recovery snapshot) — "has content" = audio loaded, duration known, or
 *    more than the placeholder syllable typed;
 *  - unchanged projects are not re-written (serialized compare);
 *  - AUDIO BYTES ARE NOT SAVED (they live outside the model, like everywhere
 *    else) — restore brings back lyrics/timings/settings, files must be
 *    re-loaded;
 *  - dismissing the bar deletes the snapshot (an explicit rejection);
 *    restoring keeps it (a restored-but-unedited project stays recoverable).
 *
 * E2E seam: localStorage['test-autosave-delay-ms'] overrides the debounce.
 */
import { store } from '../state/store';
import { Project } from '../types';

const DB_NAME = 'karaoke-autosave';
const STORE = 'snapshots';
const KEY = 'project';
const SAVE_DELAY_MS = 4000;

interface Snapshot {
  savedAt: number;
  project: Project;
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
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
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
        if (json === lastSavedJson) return;
        await withStore('readwrite', (s) => s.put({ savedAt: Date.now(), project: p } as Snapshot, KEY));
        lastSavedJson = json;
      } catch {
        /* autosave is best-effort — never disturb the app */
      }
    })();
  }, saveDelay());
}

/** Read the snapshot (null when absent or unreadable). */
async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const snap = await withStore<Snapshot | undefined>('readonly', (s) => s.get(KEY));
    return snap ?? null;
  } catch {
    return null;
  }
}

async function deleteSnapshot(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(KEY));
    lastSavedJson = '';
  } catch {
    /* best-effort */
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
  store.subscribe(scheduleSave);
  void promptRestore();
}
