/**
 * Base name (extension-less) for exported files: «Группа - Название» when the
 * song metadata is filled, else the given fallback (usually the audio file
 * name). Filesystem-unsafe characters are replaced with underscores so the
 * name is safe to download on any OS.
 */
import { Project } from '../types';

export function songBaseName(project: Project, fallback = 'karaoke'): string {
  const meta = project.metadata;
  const clean = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_').trim();
  const artist = meta ? clean(meta.artist) : '';
  const title = meta ? clean(meta.title) : '';
  if (artist && title) return `${artist} - ${title}`;
  if (artist || title) return artist || title;
  return fallback;
}
