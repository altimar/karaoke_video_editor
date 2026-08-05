/**
 * Audio loading bridge between the UI (timeline headers, controls) and the
 * audio engine + project model.
 *
 * Raw audio bytes per role are kept OUT of the project (it only stores
 * filenames). This module holds the bytes map (for export) and orchestrates
 * loading/clearing a role: decode into the engine, store bytes, update the
 * project track's filename. Both the timeline (per-role load via header click)
 * and controls (KFN/project import) go through here.
 */
import { audioEngine } from './audioEngine';
import { store } from '../state/store';
import { AudioRole, getAudioTrackByRole } from '../types';

/** Raw audio bytes per role, used by KFN/project export. */
const bytesByRole = new Map<AudioRole, Uint8Array>();

/** Read-only access to the per-role bytes map (for export). */
export function getAudioBytesMap(): Map<AudioRole, Uint8Array> {
  return new Map(bytesByRole);
}

/** Load a file into a role: decode + store bytes + update the project. */
export async function loadAudioIntoRole(role: AudioRole, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await audioEngine.loadBytes(role, bytes, file.name);
  bytesByRole.set(role, bytes);
  store.mutate((p) => {
    const at = getAudioTrackByRole(p, role);
    if (at) {
      at.audioFileName = file.name;
    }
    // Update duration to the longest loaded voice.
    p.durationMs = audioEngine.durationMs;
  });
}

/**
 * Clear a role's audio (with confirmation handled by the caller). The track slot
 * stays; only its audio is removed.
 */
export function clearAudioRole(role: AudioRole): void {
  audioEngine.clear(role);
  bytesByRole.delete(role);
  store.mutate((p) => {
    const at = getAudioTrackByRole(p, role);
    if (at) {
      at.audioFileName = '';
      at.volumeAutomation = [];
    }
  });
}

/** Bulk-replace the bytes map (used by project/KFN import after decoding). */
export function setAudioBytesMap(map: Map<AudioRole, Uint8Array>): void {
  bytesByRole.clear();
  for (const [k, v] of map) bytesByRole.set(k, v);
}
