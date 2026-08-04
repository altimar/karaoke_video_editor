/**
 * Minimal reactive store. The whole app reads/writes through this single source
 * of truth. Subscribers are notified after every mutation, which is how the
 * preview, timeline and panels stay in sync.
 *
 * State is kept mutable & structural (nested Project), and we deep-clone on
 * save/restore so external code can't mutate internals unexpectedly.
 */
import {
  Background,
  Project,
  TextTrack,
  TextStyle,
  createDefaultProject,
  newTrackId,
} from '../types';

type Listener = () => void;

class Store {
  private project: Project = createDefaultProject();
  private listeners = new Set<Listener>();

  /** Subscribers receive a fresh read of the project via getProject(). */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getProject(): Project {
    return this.project;
  }

  /**
   * Replace the whole project (e.g. on load). Clones to be safe. Old (pre-tracks)
   * projects are migrated to the multi-track model so saved files keep working.
   */
  setProject(p: Project): void {
    this.project = migrateProject(structuredClone(p));
    this.emit();
  }

  /**
   * Apply a mutation to the project in place, then notify. Using a mutator keeps
   * call sites concise while still guaranteeing a single notification point.
   */
  mutate(fn: (p: Project) => void): void {
    fn(this.project);
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const store = new Store();

/**
 * Migrate a possibly-old project into the current multi-track model.
 *
 * Old shape (pre-tracks): `lines: Line[]`, `style: Style` (text + background
 * fused), `rendererSettings` at the top level.
 *
 * New shape: `tracks: TextTrack[]` (each with its own `lines`, `TextStyle` and
 * `rendererSettings`), `background: Background` at the top level, plus
 * `activeTrackId`.
 *
 * If the project is already in the new shape it is returned unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function migrateProject(p: any): Project {
  if (Array.isArray(p.tracks) && p.tracks.length > 0 && p.background) {
    // Already multi-track. Ensure an activeTrackId that exists.
    if (!p.tracks.find((t: TextTrack) => t.id === p.activeTrackId)) {
      p.activeTrackId = p.tracks[0].id;
    }
    return p as Project;
  }

  // Old shape → build one track from the legacy fields, split style into
  // TextStyle + Background.
  const oldStyle: any = p.style ?? {};
  const textStyle: TextStyle = {
    fontFamily: oldStyle.fontFamily ?? 'Arial, Helvetica, sans-serif',
    fontSize: oldStyle.fontSize ?? 64,
    fontWeight: oldStyle.fontWeight ?? 700,
    lineHeight: oldStyle.lineHeight ?? 1.4,
    textAlign: oldStyle.textAlign ?? 'center',
    colorBase: oldStyle.colorBase ?? 'rgba(255,255,255,0.35)',
    colorHighlight: oldStyle.colorHighlight ?? '#ffe14d',
    strokeWidth: oldStyle.strokeWidth ?? 3,
    // strokeColor was renamed → strokeColorActive; pick up either, default inactive.
    strokeColorActive: oldStyle.strokeColorActive ?? oldStyle.strokeColor ?? 'rgba(0,0,0,0.85)',
    strokeColorInactive: oldStyle.strokeColorInactive ?? 'rgba(1,1,1,0.85)',
    glowBlur: oldStyle.glowBlur ?? 24,
    glowColor: oldStyle.glowColor ?? 'rgba(255,180,0,0.9)',
    layout: oldStyle.layout ?? 'scroller',
  };
  const background: Background = {
    bgType: oldStyle.bgType ?? 'color',
    bgColor: oldStyle.bgColor ?? '#0e0f1a',
    bgColors: oldStyle.bgColors ?? ['#1a1033', '#0e0f1a'],
    bgImageDataUrl: oldStyle.bgImageDataUrl ?? null,
  };
  const lines = p.lines ?? [{ syllables: [{ text: 'Загрузите текст', startMs: null }] }];
  const track: TextTrack = {
    id: newTrackId(),
    name: 'Дорожка 1',
    lines,
    style: textStyle,
    rendererSettings: p.rendererSettings ?? { scroller: { visibleLines: 8 } },
  };

  return {
    audioFileName: p.audioFileName ?? null,
    durationMs: p.durationMs ?? 0,
    tracks: [track],
    activeTrackId: track.id,
    background,
    fps: p.fps ?? 30,
    width: p.width ?? 1920,
    height: p.height ?? 1080,
    showWaveform: p.showWaveform ?? true,
  };
}
