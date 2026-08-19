/**
 * Syllable-focus channel: the timeline publishes the syllable a marker
 * selection lands on (click / Tab walk), the lyrics editor subscribes and
 * positions its textarea caret — no imports between the UI modules (same
 * pattern as lib/scrub.ts).
 */
export interface SyllableFocus {
  trackId: string;
  lineIndex: number;
  sylIndex: number;
}

type Listener = (f: SyllableFocus) => void;
const listeners = new Set<Listener>();

/** The timeline selected this syllable — notify the subscribers. */
export function focusSyllable(f: SyllableFocus): void {
  for (const l of listeners) l(f);
}

export function onSyllableFocus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
