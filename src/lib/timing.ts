/**
 * Timing capture controller.
 *
 * In "record" mode, audio plays and pressing Space stamps the current playback
 * time as the start time of the next untimed syllable (in order) of the ACTIVE
 * text track. This lets the user tap along with the song to set syllable starts.
 * Pressing the same flow again advances to the next syllable.
 *
 * You can also re-record from a specific syllable: pass a start index and all
 * syllables from there become untimed and get re-stamped.
 *
 * Timing capture always targets the project's active track. Switching the
 * active track resets the cursor to that track's first untimed syllable on the
 * next `start()`.
 */
import { store } from '../state/store';
import { audioEngine } from './audioEngine';
import { flatSyllables } from './textParser';
import { getActiveTrack } from '../types';

export type RecordStateListener = (recording: boolean, currentIndex: number) => void;

class TimingCapture {
  private recording = false;
  /** Flat index of the syllable that the next Space will stamp. */
  private cursor = 0;
  private listeners = new Set<RecordStateListener>();
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  onState(fn: RecordStateListener): () => void {
    this.listeners.add(fn);
    fn(this.recording, this.cursor);
    return () => this.listeners.delete(fn);
  }

  isRecording(): boolean {
    return this.recording;
  }

  getCursor(): number {
    return this.cursor;
  }

  /**
   * Begin recording on the ACTIVE track. If `fromIndex` is given, syllables from
   * that flat index onward are cleared (set to null) and re-stamped; otherwise
   * recording continues from the first still-untimed syllable of the active track.
   */
  start(fromIndex?: number): void {
    const project = store.getProject();
    const flat = flatSyllables(getActiveTrack(project).lines);
    if (flat.length === 0) return;

    if (fromIndex !== undefined) {
      store.mutate((p) => {
        const f = flatSyllables(getActiveTrack(p).lines);
        for (let i = fromIndex; i < f.length; i++) {
          f[i].syl.startMs = null;
        }
      });
      this.cursor = fromIndex;
    } else {
      const firstUntimed = flat.findIndex((x) => x.syl.startMs === null);
      this.cursor = firstUntimed >= 0 ? firstUntimed : 0;
    }

    this.recording = true;
    this.attachKeyListener();
    this.emit();
    void audioEngine.play();
  }

  /** Stop recording (does not pause audio). */
  stop(): void {
    this.recording = false;
    this.detachKeyListener();
    this.emit();
  }

  /** Stamp current playback time onto the cursor syllable of the active track and advance. */
  stampNow(): void {
    if (!this.recording) return;
    const timeMs = audioEngine.currentTimeMs;
    const project = store.getProject();
    const flat = flatSyllables(getActiveTrack(project).lines);
    if (this.cursor >= flat.length) {
      this.stop();
      return;
    }
    store.mutate((p) => {
      const f = flatSyllables(getActiveTrack(p).lines);
      if (f[this.cursor]) f[this.cursor].syl.startMs = Math.round(timeMs);
    });
    this.cursor++;
    if (this.cursor >= flat.length) {
      this.stop();
    }
    this.emit();
  }

  private attachKeyListener(): void {
    if (this.keyHandler) return;
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        this.stampNow();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.stop();
      }
    };
    // Capture phase so we beat other listeners (e.g. play/pause space handler).
    window.addEventListener('keydown', this.keyHandler, true);
  }

  private detachKeyListener(): void {
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
  }

  private emit(): void {
    for (const l of this.listeners) l(this.recording, this.cursor);
  }
}

export const timingCapture = new TimingCapture();
