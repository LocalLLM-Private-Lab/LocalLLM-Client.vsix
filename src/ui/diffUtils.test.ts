import { describe, it, expect } from 'vitest';
import { splitLines, buildLineDiff, diffForReplaceLines, diffForWriteFile, diffForEditFile } from './diffUtils';

describe('splitLines', () => {
  it('splits on \\n', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('normalizes \\r\\n to \\n', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });

  it('drops a single trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('treats a lone newline as an empty file (trailing newline stripped)', () => {
    expect(splitLines('\n')).toEqual([]);
  });
});

describe('buildLineDiff', () => {
  it('collapses identical input into a single gap marker', () => {
    const lines = ['a', 'b', 'c'];
    const result = buildLineDiff(lines, lines);
    expect(result).toEqual([{ kind: 'gap', text: '… 3 unchanged lines …' }]);
  });

  it('reports every line as add when old is empty', () => {
    const result = buildLineDiff([], ['a', 'b']);
    expect(result).toEqual([
      { kind: 'add', newNo: 1, text: 'a' },
      { kind: 'add', newNo: 2, text: 'b' },
    ]);
  });

  it('reports every line as del when new is empty', () => {
    const result = buildLineDiff(['a', 'b'], []);
    expect(result).toEqual([
      { kind: 'del', oldNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, text: 'b' },
    ]);
  });

  it('shows a single changed line with surrounding context', () => {
    const oldLines = ['1', '2', '3', '4', '5'];
    const newLines = ['1', '2', 'X', '4', '5'];
    const result = buildLineDiff(oldLines, newLines);
    const kinds = result.map(r => r.kind);
    expect(kinds).toContain('del');
    expect(kinds).toContain('add');
    // All 5 lines are within CONTEXT(3) of the single change, so nothing is gapped.
    expect(kinds).not.toContain('gap');
  });

  it('inserts a gap marker for unchanged runs beyond the context window', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[10] = 'CHANGED';
    const result = buildLineDiff(oldLines, newLines);
    expect(result.some(r => r.kind === 'gap')).toBe(true);
  });
});

describe('diffForReplaceLines', () => {
  it('replaces the given 1-indexed inclusive line range', () => {
    const content = 'a\nb\nc\nd\n';
    const result = diffForReplaceLines(content, 2, 3, 'X\nY');
    const rendered = result.map(l => l.text).join('\n');
    expect(rendered).toContain('X');
    expect(rendered).toContain('Y');
    expect(result.some(l => l.kind === 'del' && l.text === 'b')).toBe(true);
    expect(result.some(l => l.kind === 'del' && l.text === 'c')).toBe(true);
  });

  it('clamps end_line beyond file length', () => {
    const content = 'a\nb\n';
    // Should not throw despite endLine exceeding the file's line count.
    expect(() => diffForReplaceLines(content, 1, 100, 'X')).not.toThrow();
  });

  it('supports deleting a range by passing empty new content', () => {
    const content = 'a\nb\nc\n';
    const result = diffForReplaceLines(content, 2, 2, '');
    expect(result.some(l => l.kind === 'add')).toBe(false);
    expect(result.some(l => l.kind === 'del' && l.text === 'b')).toBe(true);
  });
});

describe('diffForWriteFile', () => {
  it('shows every line as add for a brand-new file', () => {
    const result = diffForWriteFile(null, 'a\nb\nc');
    expect(result).toEqual([
      { kind: 'add', newNo: 1, text: 'a' },
      { kind: 'add', newNo: 2, text: 'b' },
      { kind: 'add', newNo: 3, text: 'c' },
    ]);
  });

  it('diffs against existing content when the file already exists', () => {
    const result = diffForWriteFile('a\nb\n', 'a\nX\n');
    expect(result.some(l => l.kind === 'del' && l.text === 'b')).toBe(true);
    expect(result.some(l => l.kind === 'add' && l.text === 'X')).toBe(true);
  });
});

describe('diffForEditFile', () => {
  it('produces a line-numbered diff when old_str is found in the file', () => {
    const fileContent = 'function foo() {\n  return 1;\n}\n';
    const result = diffForEditFile(fileContent, 'return 1;', 'return 2;');
    expect(result.some(l => l.kind === 'del' && l.oldNo !== undefined)).toBe(true);
    expect(result.some(l => l.kind === 'add' && l.newNo !== undefined)).toBe(true);
  });

  it('falls back to a plain -/+ diff when old_str is not found', () => {
    const result = diffForEditFile('unrelated content', 'missing text', 'new text');
    expect(result).toEqual([
      { kind: 'del', text: 'missing text' },
      { kind: 'add', text: 'new text' },
    ]);
  });

  it('falls back to a plain -/+ diff when fileContent is null (new file)', () => {
    const result = diffForEditFile(null, 'old', 'new');
    expect(result).toEqual([
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });
});
