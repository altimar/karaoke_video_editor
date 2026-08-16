/**
 * Font picker list building (pure logic, probe injected).
 */
import { describe, expect, it } from 'vitest';
import { buildFontList } from '../src/ui/fontPicker';

const all = () => true;
const none = () => false;

describe('buildFontList', () => {
  it('keeps the current font on top even if the probe says unavailable', () => {
    const list = buildFontList('MyCustomFont', none, ['Arial']);
    expect(list[0]).toBe('MyCustomFont');
  });

  it('dedupes case-insensitively against candidates', () => {
    const list = buildFontList('arial', all, ['Arial', 'Georgia']);
    expect(list.filter((f) => f.toLowerCase() === 'arial')).toHaveLength(1);
    expect(list[0]).toBe('arial'); // current wins
  });

  it('splits a multi-font stack and keeps each named part', () => {
    const list = buildFontList('"Comic Sans MS", serif', all, ['Arial']);
    expect(list.slice(0, 2)).toEqual(['Comic Sans MS', 'serif']);
  });

  it('drops candidates the probe rejects', () => {
    const probe = (f: string) => f === 'Georgia';
    const list = buildFontList('', probe, ['Arial', 'Georgia', 'Verdana']);
    expect(list).toEqual(['Georgia', 'system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy']);
  });

  it('always includes generic families even when nothing is installed', () => {
    const list = buildFontList('', none, ['Arial']);
    expect(list).toEqual(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy']);
  });

  it('skips empty parts of a stack', () => {
    const list = buildFontList(' , , Arial', all, ['Georgia']);
    expect(list[0]).toBe('Arial');
  });
});
