/**
 * Minimal reactive store. The whole app reads/writes through this single source
 * of truth. Subscribers are notified after every mutation, which is how the
 * preview, timeline and panels stay in sync.
 *
 * State is kept mutable & structural (nested Project), and we deep-clone on
 * restore so external code can't mutate internals unexpectedly.
 */
import { Project, createDefaultProject } from '../types';

type Listener = () => void;

class Store {
  private project: Project = createInitialProject();
  private listeners = new Set<Listener>();

  /** Subscribers receive a fresh read of the project via getProject(). */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getProject(): Project {
    return this.project;
  }

  /** Replace the whole project (e.g. on load). Clones to be safe. */
  setProject(p: Project): void {
    this.project = structuredClone(p);
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

/** A minimal empty project to start from (one untitled text track). */
function createInitialProject(): Project {
  return createDefaultProject();
}
