import { describe, it, expect } from 'vitest';
import { compressToolResult, MAX_TOOL_RESULT_CHARS } from './toolResultUtils';

describe('compressToolResult', () => {
  it('returns short generic output unchanged', () => {
    const output = 'hello world';
    expect(compressToolResult(output)).toBe(output);
  });

  it('truncates long generic output with head+tail and a size marker', () => {
    const output = 'x'.repeat(3000);
    const result = compressToolResult(output);
    expect(result.length).toBeLessThan(output.length);
    expect(result).toContain('truncated');
    expect(result.startsWith('x'.repeat(800))).toBe(true);
    expect(result.endsWith('x'.repeat(600))).toBe(true);
  });

  describe('read_file', () => {
    it('keeps short read_file output untouched', () => {
      const output = Array.from({ length: 10 }, (_, i) => `  ${i + 1}\tconst x = ${i};`).join('\n');
      expect(compressToolResult(output, 'read_file')).toBe(output);
    });

    it('omits the middle and names the omitted line range', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `${i + 1}\tline ${i + 1}`);
      const output = lines.join('\n');
      const result = compressToolResult(output, 'read_file');
      expect(result).toContain('OMITTED');
      expect(result).toContain('start_line=');
      expect(result).toContain('end_line=');
      // First and last lines must be preserved verbatim.
      expect(result.startsWith('1\tline 1')).toBe(true);
      expect(result.endsWith('500\tline 500')).toBe(true);
    });
  });

  describe('fetch_url', () => {
    it('keeps short fetch_url output untouched', () => {
      const output = 'a short page body';
      expect(compressToolResult(output, 'fetch_url')).toBe(output);
    });

    it('cuts the middle of a long page and reports chars omitted', () => {
      const output = 'a'.repeat(10000) + 'ZZZMARKERZZZ'.repeat(500) + 'b'.repeat(10000);
      const result = compressToolResult(output, 'fetch_url');
      expect(result).toContain('omitted from the MIDDLE');
      expect(result).not.toContain('ZZZMARKERZZZ');
      expect(result.length).toBeLessThan(output.length);
      expect(result.startsWith('a'.repeat(4400))).toBe(true);
      expect(result.endsWith('b'.repeat(1300))).toBe(true);
    });
  });

  describe('web_search', () => {
    it('keeps short web_search output untouched', () => {
      const output = 'Title\n  snippet\n  https://example.com';
      expect(compressToolResult(output, 'web_search')).toBe(output);
    });

    it('keeps whole result blocks and never slices one in half', () => {
      const block = (n: number) =>
        `Result ${n}\n  ${'snippet text '.repeat(10)}for result ${n}\n  https://example.com/${n}`;
      const blocks = Array.from({ length: 30 }, (_, i) => block(i));
      const output = blocks.join('\n\n');
      const result = compressToolResult(output, 'web_search');
      expect(result).toContain('more results omitted');
      // Every kept block must appear in full (title, snippet, and url together).
      for (const line of result.split('\n\n')) {
        if (line.startsWith('Result')) {
          const n = line.match(/^Result (\d+)/)?.[1];
          expect(line).toBe(block(Number(n)));
        }
      }
    });

    it('falls back to a plain cut when a single block exceeds the budget', () => {
      const output = 'z'.repeat(5000);
      const result = compressToolResult(output, 'web_search');
      expect(result).toContain('truncated');
    });
  });

  describe('run_terminal', () => {
    it('extracts error lines when present in large output', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ok`);
      lines[150] = 'Error: something failed unexpectedly';
      const output = lines.join('\n');
      const result = compressToolResult(output, 'run_terminal');
      expect(result).toContain('error lines extracted');
      expect(result).toContain('Error: something failed unexpectedly');
    });

    it('falls back to head+tail with a re-run hint when no error lines exist', () => {
      const output = Array.from({ length: 200 }, (_, i) => `line ${i}: ok`).join('\n');
      const result = compressToolResult(output, 'run_terminal');
      expect(result).toContain('Select-String');
    });

    it('leaves short run_terminal output untouched', () => {
      const output = 'build succeeded';
      expect(compressToolResult(output, 'run_terminal')).toBe(output);
    });
  });

  it('MAX_TOOL_RESULT_CHARS matches the generic truncation threshold', () => {
    const output = 'y'.repeat(MAX_TOOL_RESULT_CHARS);
    expect(compressToolResult(output)).toBe(output);
    expect(compressToolResult(output + 'z')).not.toBe(output + 'z');
  });
});
