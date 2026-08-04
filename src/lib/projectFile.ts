/**
 * Native project file format (`.karaokeproject`).
 *
 * A ZIP container (stored, no compression — MP3/JPG are already compressed) so
 * the format is inspectable with any archive tool and easy to extend with more
 * media/layers in the future (a desktop app can treat it as a document bundle).
 *
 * Structure:
 *   project.karaokeproject (ZIP)
 *   ├── project.json   — project metadata (NO embedded media bytes)
 *   ├── audio.<ext>    — raw audio bytes (when present)
 *   └── background.<ext> — raw background image bytes (when an image bg is set)
 *
 * The JSON's media fields (`audioFileName`, `background.bgImageDataUrl`) are
 * rewritten to point at the container entries on save, and re-inlined as data
 * URLs on load — so the in-memory Project model is unchanged.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Project } from '../types';

/** Magic entry name for the project metadata inside the container. */
const PROJECT_JSON = 'project.json';
/** Magic entry name for the audio file inside the container. */
const AUDIO_ENTRY = 'audio';
/** Magic entry name for the background image inside the container. */
const BG_ENTRY = 'background';

/** Result of saving a project: the Blob + the chosen file name. */
export interface SaveProjectResult {
  blob: Blob;
  filename: string;
}

/** Result of loading a project: the Project + raw audio bytes (if any). */
export interface LoadProjectResult {
  project: Project;
  audioBytes: Uint8Array | null;
  audioFileName: string | null;
}

/**
 * Decode a `data:image/<ext>;base64,...` URL into raw bytes + extension.
 * Returns null for non-image or malformed data URLs.
 */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:image\/([a-zA-Z0-9]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, ext };
  } catch {
    return null;
  }
}

/** Encode raw bytes into a `data:image/<ext>;base64,...` URL. */
function encodeDataUrl(bytes: Uint8Array, ext: string): string {
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:image/${mime};base64,${btoa(bin)}`;
}

/** Extract the extension from a filename, lowercased without the dot. */
function extOf(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'mp3';
}

/**
 * Save a project to a `.karaokeproject` ZIP container (stored, no compression).
 * Media (audio + background image) are stored as separate raw-byte entries.
 * The metadata JSON keeps references (entry names) instead of embedded bytes.
 *
 * @param project  The in-memory project.
 * @param audioBytes  Raw audio bytes (null if no audio is loaded).
 * @returns The ZIP Blob and a suggested filename.
 */
export function saveProject(project: Project, audioBytes: Uint8Array | null): SaveProjectResult {
  // Deep clone so we don't mutate the live project.
  const meta = JSON.parse(JSON.stringify(project)) as Project;

  const files: Record<string, Uint8Array> = {};

  // Audio → separate entry; keep only the original filename in metadata.
  if (audioBytes && meta.audioFileName) {
    const ext = extOf(meta.audioFileName);
    files[`${AUDIO_ENTRY}.${ext}`] = audioBytes;
  }

  // Background image → separate entry; replace the data URL with a marker so
  // load knows an image entry exists (the actual bytes live in the ZIP).
  let bgMarker: string | null = null;
  if (meta.background.bgType === 'image' && meta.background.bgImageDataUrl) {
    const decoded = decodeDataUrl(meta.background.bgImageDataUrl);
    if (decoded) {
      files[`${BG_ENTRY}.${decoded.ext}`] = decoded.bytes;
      bgMarker = `${BG_ENTRY}.${decoded.ext}`;
    }
  }
  // Remove the bulky data URL from metadata; it's restored on load from the entry.
  meta.background.bgImageDataUrl = bgMarker;

  files[PROJECT_JSON] = strToU8(JSON.stringify(meta, null, 2));

  // zipSync with level 0 = store (no compression). MP3/JPG are already compressed.
  const zipped = zipSync(files, { level: 0 });

  const base = (project.audioFileName?.replace(/\.[^.]+$/, '') || 'karaoke-project');
  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    filename: `${base}.karaokeproject`,
  };
}

/**
 * Load a `.karaokeproject` ZIP container: parse the metadata JSON and re-inline
 * the audio + background image bytes back into the Project model.
 *
 * @param data  Raw bytes of the .karaokeproject file.
 * @returns The project + raw audio bytes (to feed AudioEngine).
 */
export function loadProject(data: Uint8Array): LoadProjectResult {
  const unzipped = unzipSync(data);

  if (!unzipped[PROJECT_JSON]) {
    throw new Error('project.json не найден в файле проекта');
  }
  const meta = JSON.parse(strFromU8(unzipped[PROJECT_JSON])) as Project;

  // Find the audio entry (audio.<ext>) and return its raw bytes.
  let audioBytes: Uint8Array | null = null;
  let audioFileName: string | null = meta.audioFileName;
  for (const name of Object.keys(unzipped)) {
    if (name.startsWith(AUDIO_ENTRY + '.')) {
      audioBytes = unzipped[name];
      break;
    }
  }

  // Re-inline the background image: the metadata holds the entry name as a marker.
  const bgMarker = meta.background.bgImageDataUrl;
  if (meta.background.bgType === 'image' && bgMarker && unzipped[bgMarker]) {
    const ext = extOf(bgMarker);
    meta.background.bgImageDataUrl = encodeDataUrl(unzipped[bgMarker], ext);
  } else {
    // No image entry — clear the marker so it isn't mistaken for a data URL.
    meta.background.bgImageDataUrl = null;
  }

  return { project: meta, audioBytes, audioFileName };
}
