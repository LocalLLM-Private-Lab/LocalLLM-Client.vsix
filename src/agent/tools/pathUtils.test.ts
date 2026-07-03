import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveWritePath } from './pathUtils';

const ROOT = path.resolve('/workspace');

describe('resolveWritePath', () => {
  it('resolves a simple relative path inside the workspace', () => {
    const result = resolveWritePath('src/file.ts', ROOT);
    expect(result).toEqual({ ok: true, path: path.resolve(ROOT, 'src/file.ts') });
  });

  it('resolves nested relative paths', () => {
    const result = resolveWritePath('a/b/c.ts', ROOT);
    expect(result).toEqual({ ok: true, path: path.resolve(ROOT, 'a/b/c.ts') });
  });

  it('rejects parent-directory traversal', () => {
    const result = resolveWritePath('../outside.txt', ROOT);
    expect(result.ok).toBe(false);
  });

  it('rejects deeply nested traversal that still escapes the root', () => {
    const result = resolveWritePath('a/b/../../../outside.txt', ROOT);
    expect(result.ok).toBe(false);
  });

  it('rejects an absolute path outside the workspace', () => {
    const outside = path.resolve('/etc/passwd');
    const result = resolveWritePath(outside, ROOT);
    expect(result.ok).toBe(false);
  });

  it('accepts an absolute path that is inside the workspace', () => {
    const inside = path.resolve(ROOT, 'src/file.ts');
    const result = resolveWritePath(inside, ROOT);
    expect(result).toEqual({ ok: true, path: inside });
  });

  it('rejects the workspace root itself (empty relative path)', () => {
    const result = resolveWritePath('.', ROOT);
    expect(result.ok).toBe(false);
  });

  it('includes the offending path in the error message', () => {
    const result = resolveWritePath('../secret.env', ROOT);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('../secret.env');
  });
});
