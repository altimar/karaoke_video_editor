/**
 * Tests for the export file base name: «Группа - Название» from song metadata
 * with a filesystem-safe fallback chain.
 */
import { test } from 'vitest';
import { songBaseName } from '../src/lib/songTitle';
import { Project, createProjectMetadata } from '../src/types';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

function projectWith(artist: string, title: string): Project {
  const meta = createProjectMetadata();
  meta.artist = artist;
  meta.title = title;
  return { metadata: meta } as Project;
}

test('artist + title → «Группа - Название»', () => {
  assert(songBaseName(projectWith('Lumen', 'Буря')) === 'Lumen - Буря', 'both fields');
});

test('only one field → that field alone', () => {
  assert(songBaseName(projectWith('Lumen', '')) === 'Lumen', 'artist only');
  assert(songBaseName(projectWith('', 'Буря')) === 'Буря', 'title only');
});

test('empty metadata → fallback', () => {
  assert(songBaseName(projectWith('', ''), 'song-file') === 'song-file', 'audio filename fallback');
  assert(songBaseName(projectWith('', '')) === 'karaoke', 'default fallback');
});

test('filesystem-unsafe characters are replaced', () => {
  const p = projectWith('AC/DC', 'Back In Black: Best?');
  assert(songBaseName(p) === 'AC_DC - Back In Black_ Best_', `unsafe chars replaced (got "${songBaseName(p)}")`);
});
