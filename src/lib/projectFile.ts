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
 *   ├── audio/<role>.<ext> — raw audio bytes per role (minus / back / original)
 *   └── background.<ext> — raw background image bytes (when an image bg is set)
 *
 * The JSON's media fields (`audioFileName` on each AudioTrack, the background
 * `bgImageDataUrl`) reference the container entries; on save the bulky bytes
 * are moved into separate ZIP entries and re-inlined on load.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { AudioRole, AudioTrack, Project } from '../types';

/** Magic entry name for the project metadata inside the container. */
const PROJECT_JSON = 'project.json';
/** Prefix for audio entries: `audio/minus.mp3`, `audio/back.mp3`, … */
const AUDIO_PREFIX = 'audio/';
/** Magic entry name for the background image inside the container. */
const BG_ENTRY = 'background';

/** Result of saving a project: the Blob + the chosen file name. */
export interface SaveProjectResult {
  blob: Blob;
  filename: string;
}

/** Result of loading a project: the Project + raw audio bytes per role. */
export interface LoadProjectResult {
  project: Project;
  audioByRole: Map<AudioRole, Uint8Array>;
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
 * Each role's audio + the background image are stored as separate raw-byte
 * entries; the metadata JSON keeps only filenames/references.
 */
export function saveProject(project: Project, audioByRole: Map<AudioRole, Uint8Array>): SaveProjectResult {
  const meta = JSON.parse(JSON.stringify(project)) as Project;
  const files: Record<string, Uint8Array> = {};

  // Audio → one entry per role that has bytes; the track keeps its filename.
  for (const track of meta.tracks) {
    if (track.type !== 'audio') continue;
    const bytes = audioByRole.get(track.role);
    if (bytes && track.audioFileName) {
      files[`${AUDIO_PREFIX}${track.role}.${extOf(track.audioFileName)}`] = bytes;
    } else {
      // No bytes loaded → clear the filename so load doesn't expect an entry.
      track.audioFileName = '';
    }
  }

  // Background image → separate entry; replace the data URL with a marker.
  let bgMarker: string | null = null;
  if (meta.background.bgType === 'image' && meta.background.bgImageDataUrl) {
    const decoded = decodeDataUrl(meta.background.bgImageDataUrl);
    if (decoded) {
      files[`${BG_ENTRY}.${decoded.ext}`] = decoded.bytes;
      bgMarker = `${BG_ENTRY}.${decoded.ext}`;
    }
  }
  meta.background.bgImageDataUrl = bgMarker;

  files[PROJECT_JSON] = strToU8(JSON.stringify(meta, null, 2));
  const zipped = zipSync(files, { level: 0 });

  const base = (project.tracks.find((t): t is AudioTrack => t.type === 'audio' && t.audioFileName.length > 0)?.audioFileName ?? 'karaoke-project');
  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    filename: `${base.replace(/\.[^.]+$/, '')}.karaokeproject`,
  };
}

/**
 * Load a `.karaokeproject` ZIP container: parse the metadata JSON and re-inline
 * the per-role audio + background image bytes back into the Project model.
 */
export function loadProject(data: Uint8Array): LoadProjectResult {
  const unzipped = unzipSync(data);
  if (!unzipped[PROJECT_JSON]) {
    throw new Error('project.json не найден в файле проекта');
  }
  const meta = JSON.parse(strFromU8(unzipped[PROJECT_JSON])) as Project;

  // Collect each role's raw bytes from the audio/* entries.
  const audioByRole = new Map<AudioRole, Uint8Array>();
  for (const name of Object.keys(unzipped)) {
    if (!name.startsWith(AUDIO_PREFIX)) continue;
    const role = name.slice(AUDIO_PREFIX.length).split('.')[0] as AudioRole;
    if (role === 'original' || role === 'lead' || role === 'minus' || role === 'back') {
      audioByRole.set(role, unzipped[name]);
    }
  }

  // Re-inline the background image from its entry marker.
  const bgMarker = meta.background.bgImageDataUrl;
  if (meta.background.bgType === 'image' && bgMarker && unzipped[bgMarker]) {
    meta.background.bgImageDataUrl = encodeDataUrl(unzipped[bgMarker], extOf(bgMarker));
  } else {
    meta.background.bgImageDataUrl = null;
  }

  return { project: meta, audioByRole };
}
