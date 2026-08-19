/**
 * Audio engine — multi-voice playback.
 *
 * A project has four fixed audio roles: 'original' (the full reference mix,
 * used for timing capture), 'minus' (instrumental), 'back' (backing vocals),
 * and 'lead' (the extracted lead vocal). Each loaded role becomes a "voice":
 * an <audio> element → MediaElementSource → GainNode → destination. Voices sum
 * at the shared AudioContext destination.
 *
 * Two playback modes select WHICH voices are audible:
 *  - playback (`play`): lead + minus + back if any are loaded, else original.
 *    The lead vocal is audible in the editor so the user hears the singer while
 *    working, but it is NOT mixed into the video export (see export.ts).
 *  - record  (`playForRecord`): original if loaded, else lead + minus + back.
 *
 * All started voices stay sample-aligned because they start from the same seek
 * position at the same instant. currentTimeMs / durationMs are read from the
 * "primary" voice of the active set.
 */
import { AudioRole, VolumePoint } from '../types';
import { gainAtTime } from './volumeAutomation';

export type AudioStateListener = (playing: boolean) => void;
export type TimeListener = (timeMs: number) => void;

/** One loaded audio source: element + Web Audio graph + decoded buffer + envelope. */
interface Voice {
  role: AudioRole;
  audio: HTMLAudioElement;
  sourceNode: MediaElementAudioSourceNode;
  gainNode: GainNode;
  buffer: AudioBuffer | null;
  url: string | null;
  automation: VolumePoint[];
  /** Mute/Solo flags, applied as a 0/1 factor on top of the envelope gain. */
  muted: boolean;
  solo: boolean;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private voices = new Map<AudioRole, Voice>();
  /** Roles currently playing (subset of loaded roles, chosen by the play mode). */
  private activeRoles: AudioRole[] = [];
  /** The role used as the time/duration reference. */
  private primaryRole: AudioRole | null = null;
  /** Playback rate (0.25..2, pitch preserved) — timing capture on fast songs. */
  private rate = 1;

  private audioStateListeners = new Set<AudioStateListener>();
  private timeListeners = new Set<TimeListener>();
  private rafId: number | null = null;

  /** Lazily create the shared AudioContext (browsers need a user gesture). */
  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  /** Build (once per role) the voice graph: <audio> → gain → destination. */
  private ensureVoice(role: AudioRole, ctx: AudioContext): Voice {
    const existing = this.voices.get(role);
    if (existing) return existing;
    const audio = new Audio();
    audio.preload = 'auto';
    const sourceNode = ctx.createMediaElementSource(audio);
    const gainNode = ctx.createGain();
    sourceNode.connect(gainNode);
    gainNode.connect(ctx.destination);
    audio.addEventListener('play', () => this.notifyState(true));
    audio.addEventListener('pause', () => this.onElementPause());
    audio.addEventListener('ended', () => this.onElementPause());
    const voice: Voice = { role, audio, sourceNode, gainNode, buffer: null, url: null, automation: [], muted: false, solo: false };
    this.voices.set(role, voice);
    return voice;
  }

  /** Load raw audio bytes into a role's voice. Replaces any prior audio there. */
  async loadBytes(role: AudioRole, bytes: Uint8Array, _fileName: string): Promise<void> {
    const ctx = this.ensureCtx();
    const v = this.ensureVoice(role, ctx);
    if (v.url) URL.revokeObjectURL(v.url);
    const blob = new Blob([bytes.buffer as ArrayBuffer]);
    v.url = URL.createObjectURL(blob);
    v.audio.src = v.url;
    v.audio.load();
    v.audio.playbackRate = this.rate;
    const arrBuf = (bytes.buffer as ArrayBuffer).slice(0);
    v.buffer = await ctx.decodeAudioData(arrBuf.slice(0));
    // Apply any automation already set on this voice (× mute/solo factor).
    v.gainNode.gain.value = this.roleGain(v, this.currentTimeMs);
  }

  /** Clear (unload) a role's audio — the slot becomes empty. */
  clear(role: AudioRole): void {
    const v = this.voices.get(role);
    if (!v) return;
    v.audio.pause();
    v.audio.removeAttribute('src');
    v.audio.load();
    if (v.url) URL.revokeObjectURL(v.url);
    v.url = null;
    v.buffer = null;
    if (this.primaryRole === role) this.primaryRole = null;
    this.activeRoles = this.activeRoles.filter((r) => r !== role);
  }

  /** Decoded buffer for a role (for export), or null if not loaded. */
  getBuffer(role: AudioRole): AudioBuffer | null {
    return this.voices.get(role)?.buffer ?? null;
  }

  /** True if a role has audio loaded. */
  has(role: AudioRole): boolean {
    return !!this.voices.get(role)?.buffer;
  }

  /** Current playback rate (1 = normal; pitch is preserved by the browser). */
  get playbackRate(): number {
    return this.rate;
  }

  /** Set the playback rate for every voice (also applied to voices loaded later). */
  setPlaybackRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(2, rate));
    for (const v of this.voices.values()) {
      v.audio.playbackRate = this.rate;
    }
  }

  /** Store a role's volume-automation envelope; gain is applied per RAF tick. */
  applyVolumeAutomation(role: AudioRole, points: VolumePoint[]): void {
    const v = this.voices.get(role);
    if (!v) return;
    v.automation = points;
    v.gainNode.gain.value = this.roleGain(v, this.currentTimeMs);
  }

  /**
   * Update a role's mute/solo flags. The mute/solo factor is applied on top of
   * the volume-automation envelope every RAF tick (and immediately here). A role
   * is silent when it is muted, OR when any role is solo-ed and this one is not.
   */
  setMuteSolo(role: AudioRole, muted: boolean, solo: boolean): void {
    const v = this.voices.get(role);
    if (!v) return;
    v.muted = muted;
    v.solo = solo;
    // Apply immediately at the current position (a solo toggle affects all roles).
    const t = this.currentTimeMs;
    for (const voice of this.voices.values()) {
      if (voice.buffer) voice.gainNode.gain.value = this.roleGain(voice, t);
    }
  }

  /** Effective gain factor for a voice at time t: envelope × mute/solo factor. */
  private roleGain(v: Voice, timeMs: number): number {
    const envelope = gainAtTime(v.automation, timeMs);
    if (v.muted) return 0;
    // If any loaded voice is solo-ed, only solo voices are audible.
    const anySolo = this.anySoloActive();
    if (anySolo && !v.solo) return 0;
    return envelope;
  }

  /** True if at least one loaded voice has solo=true. */
  private anySoloActive(): boolean {
    for (const v of this.voices.values()) {
      if (v.buffer && v.solo) return true;
    }
    return false;
  }

  // --- Playback mode selection ---

  /** Roles for normal playback: lead + minus + back if any are loaded, else original. */
  private playbackRoles(): AudioRole[] {
    const loaded = (rs: AudioRole[]) => rs.filter((r) => this.has(r));
    const mix = loaded(['lead', 'minus', 'back']);
    if (mix.length > 0) return mix;
    return loaded(['original']);
  }

  /** Roles for timing-capture playback: original if loaded, else lead + minus + back. */
  private recordRoles(): AudioRole[] {
    if (this.has('original')) return ['original'];
    return (['lead', 'minus', 'back'] as AudioRole[]).filter((r) => this.has(r));
  }

  get isPlaying(): boolean {
    for (const r of this.activeRoles) {
      const v = this.voices.get(r);
      if (v && !v.audio.paused && !v.audio.ended) return true;
    }
    return false;
  }

  get currentTimeMs(): number {
    const v = this.primaryVoice();
    return v ? (v.audio.currentTime || 0) * 1000 : 0;
  }

  get durationMs(): number {
    const v = this.primaryVoice();
    if (v && v.audio.duration && isFinite(v.audio.duration)) return v.audio.duration * 1000;
    if (v && v.buffer) return v.buffer.duration * 1000;
    // Fallback: longest loaded voice.
    let max = 0;
    for (const voice of this.voices.values()) {
      if (voice.buffer) max = Math.max(max, voice.buffer.duration * 1000);
    }
    return max;
  }

  /** The voice used as the time/duration reference. */
  private primaryVoice(): Voice | null {
    if (this.primaryRole) return this.voices.get(this.primaryRole) ?? null;
    // Default to the first loaded voice.
    for (const voice of this.voices.values()) {
      if (voice.buffer) return voice;
    }
    return null;
  }

  /** Start playback of the normal mix (minus+back, else original). */
  async play(): Promise<void> {
    await this.startRoles(this.playbackRoles());
  }

  /** Start playback for timing capture (original, else minus+back). */
  async playForRecord(): Promise<void> {
    await this.startRoles(this.recordRoles());
  }

  /** Start a chosen set of roles together from the current position. */
  private async startRoles(roles: AudioRole[]): Promise<void> {
    if (roles.length === 0) return;
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    this.activeRoles = roles;
    this.primaryRole = roles[0];
    const t = this.currentTimeMs / 1000;
    // Start all voices from the same position simultaneously.
    await Promise.all(
      roles.map(async (r) => {
        const v = this.voices.get(r);
        if (!v) return;
        try {
          v.audio.currentTime = t;
          await v.audio.play();
        } catch {
          /* autoplay rejection — ignore */
        }
      }),
    );
    this.startTimeLoop();
  }

  pause(): void {
    for (const r of this.activeRoles) {
      this.voices.get(r)?.audio.pause();
    }
    this.stopTimeLoop();
  }

  toggle(): void {
    if (this.isPlaying) this.pause();
    else void this.play();
  }

  seek(timeMs: number): void {
    const t = Math.max(0, timeMs / 1000);
    // Seek every loaded voice so any subset can resume from here.
    for (const v of this.voices.values()) {
      if (v.buffer) v.audio.currentTime = t;
    }
    this.notifyTime(timeMs);
    // Re-apply each voice's envelope (× mute/solo factor) from the new position.
    for (const v of this.voices.values()) {
      if (v.buffer) v.gainNode.gain.value = this.roleGain(v, timeMs);
    }
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
      // Apply each active voice's envelope (× mute/solo factor) for the position.
      for (const r of this.activeRoles) {
        const v = this.voices.get(r);
        if (v) v.gainNode.gain.value = this.roleGain(v, timeMs);
      }
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

  /** When any voice pauses/ends, stop the loop once none are playing. */
  private onElementPause(): void {
    if (!this.isPlaying) {
      this.notifyState(false);
      this.stopTimeLoop();
    }
  }

  private notifyState(playing: boolean): void {
    for (const l of this.audioStateListeners) l(playing);
  }

  private notifyTime(timeMs: number): void {
    for (const l of this.timeListeners) l(timeMs);
  }
}

export const audioEngine = new AudioEngine();
