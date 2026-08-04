/**
 * Audio engine.
 *
 * Two responsibilities:
 *  1. Play/pause/seek the loaded MP3 via an <audio> element for the editing UX.
 *  2. Decode the MP3 once into an AudioBuffer (via AudioContext) — needed both
 *     to know the exact duration and to feed PCM to the MP4 exporter.
 *
 * The <audio> element is used for playback because it's the simplest reliable
 * way to play sound in the browser; AudioContext is only used for decoding.
 */
import { Project } from '../types';
import { VolumePoint } from '../types';
import { gainAtTime } from './volumeAutomation';

export type AudioStateListener = (playing: boolean) => void;
export type TimeListener = (timeMs: number) => void;

export class AudioEngine {
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private url: string | null = null;
  /** Web Audio graph for live playback: source → gain → destination. */
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  /** Currently applied automation, so we can re-apply on seek/replay. */
  private automation: VolumePoint[] = [];

  private audioStateListeners = new Set<AudioStateListener>();
  private timeListeners = new Set<TimeListener>();
  private rafId: number | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('play', () => this.notifyState(true));
    this.audio.addEventListener('pause', () => {
      this.notifyState(false);
      this.stopTimeLoop();
    });
    this.audio.addEventListener('ended', () => {
      this.notifyState(false);
      this.stopTimeLoop();
    });
  }

  get isPlaying(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get currentTimeMs(): number {
    return (this.audio.currentTime || 0) * 1000;
  }

  get durationMs(): number {
    if (this.audio.duration && isFinite(this.audio.duration)) {
      return this.audio.duration * 1000;
    }
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  /** Load an MP3 file: set up playback and decode to AudioBuffer. */
  async load(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.loadBytes(bytes, file.name);
  }

  /** Load audio from raw bytes (e.g. extracted from a KFN file). */
  async loadBytes(bytes: Uint8Array, _fileName: string): Promise<void> {
    // Revoke previous object URL to avoid leaks.
    if (this.url) URL.revokeObjectURL(this.url);
    const blob = new Blob([bytes.buffer as ArrayBuffer]);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    this.audio.load();

    // Decode for the exporter + precise duration. Reuse a single AudioContext.
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    // Build the playback graph once: <audio> → GainNode → destination.
    // createMediaElementSource can be called only ONCE per element, so we do it
    // lazily and keep the node. The <audio> element still drives seek/pause.
    if (!this.sourceNode) {
      this.sourceNode = this.ctx.createMediaElementSource(this.audio);
      this.gainNode = this.ctx.createGain();
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);
    }
    const arrBuf = (bytes.buffer as ArrayBuffer).slice(0);
    // decodeAudioData copies the buffer, so arrBuf can be reused/dropped.
    this.buffer = await this.ctx.decodeAudioData(arrBuf.slice(0));
    // Re-apply automation (if any was set before this load).
    this.applyVolumeAutomation(this.automation, this.durationMs);
  }

  /**
   * Store the volume-automation points. The actual gain is applied each
   * animation frame in the playback time loop (see startTimeLoop), reading the
   * gain for the current playback position. This avoids the clock-drift issues
   * of programming setValueAtTime against MediaElementAudioSourceNode (whose
   * AudioContext clock and <audio> currentTime run independently and drift
   * apart on seek/pause). Imperative .value writes are sample-accurate enough
   * for a UI-driven envelope and stay perfectly in sync with playback.
   */
  applyVolumeAutomation(points: VolumePoint[], _durationMs: number): void {
    this.automation = points;
    // Apply immediately so a change while paused is reflected on next play.
    if (this.gainNode) this.gainNode.gain.value = gainAtTime(points, this.currentTimeMs);
  }

  async play(): Promise<void> {
    if (!this.ctx) return;
    // Browsers suspend AudioContext until a user gesture; resume to be safe.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    try {
      await this.audio.play();
      this.startTimeLoop();
    } catch {
      /* autoplay rejection — ignore, UI reflects paused state */
    }
  }

  pause(): void {
    this.audio.pause();
    this.stopTimeLoop();
  }

  toggle(): void {
    if (this.isPlaying) this.pause();
    else void this.play();
  }

  seek(timeMs: number): void {
    this.audio.currentTime = Math.max(0, timeMs / 1000);
    this.notifyTime(timeMs);
    // Re-program automation from the new playback position so gain is correct
    // after a jump (AudioParam automation is timeline-based, not seek-aware).
    this.applyVolumeAutomation(this.automation, this.durationMs);
  }

  /** Skip by delta milliseconds, keeping within bounds. */
  nudge(deltaMs: number): void {
    const target = Math.max(0, Math.min(this.durationMs, this.currentTimeMs + deltaMs));
    this.seek(target);
  }

  onAudioState(fn: AudioStateListener): () => void {
    this.audioStateListeners.add(fn);
    fn(this.isPlaying);
    return () => this.audioStateListeners.delete(fn);
  }

  onTime(fn: TimeListener): () => void {
    this.timeListeners.add(fn);
    return () => this.timeListeners.delete(fn);
  }

  private startTimeLoop(): void {
    this.stopTimeLoop();
    const tick = () => {
      const timeMs = this.currentTimeMs;
      // Apply the volume envelope for the current playback position every frame.
      // Imperative .value keeps gain in sync with <audio> regardless of seek/pause.
      if (this.gainNode) this.gainNode.gain.value = gainAtTime(this.automation, timeMs);
      this.notifyTime(timeMs);
      if (this.isPlaying) this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTimeLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private notifyState(playing: boolean): void {
    for (const l of this.audioStateListeners) l(playing);
  }

  private notifyTime(timeMs: number): void {
    for (const l of this.timeListeners) l(timeMs);
  }

  /** Apply project duration (in case audio not loaded yet but we know length). */
  applyToProject(_project: Project): void {
    // Hook for future use; duration is read live from the engine.
  }
}

export const audioEngine = new AudioEngine();
