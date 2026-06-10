import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '__pycache__']);

export const GlobSearchTool: ToolDefinition = {
  name: 'glob_search',
  description:
    'Find files by name pattern. Supports * (any chars in segment) and ** (any depth). ' +
    'Examples: "src/**/*.ts", "**/*.test.js", "*.json"',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      max_results: { type: 'number', description: 'Maximum results (default 50)' },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
    if (typeof args['pattern'] !== 'string' || !args['pattern']) {
      return { success: false, output: 'Missing required argument: pattern (string)' };
    }
    const pattern = args['pattern'];
    const maxResults = typeof args['max_results'] === 'number' ? args['max_results'] : 50;

    try {
      const results = await globMatch(workspaceRoot, pattern, maxResults);
      return { success: true, output: results.join('\n') || '(no matches)' };
    } catch (err) {
      return { success: false, output: String(err) };
    }
  },
};

async function globMatch(root: string, pattern: string, limit: number): Promise<string[]> {
  // glob パターンを正規表現に変換
  // ** は任意の深さのパスにマッチ、* は単一セグメント内にマッチ
  const regexStr =
    '^' +
    pattern
      .replace(/\\/g, '/')
      .replace(/[.+^${}()|[\]]/g, '\\$&')   // 正規表現特殊文字をエスケープ（* ? は除く）
      .replace(/\*\*\//g, '(?:.+/)?')         // **/ → 0個以上のディレクトリ
      .replace(/\*\*/g, '.*')                 // ** 単独 → 任意文字列
      .replace(/\*/g, '[^/]*')                // * → セグメント内任意
      .replace(/\?/g, '[^/]') +               // ? → セグメント内1文字
    '$';

  const regex = new RegExp(regexStr);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) return;

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(full);
      } else if (regex.test(relative)) {
        results.push(relative);
      }
    }
  }

  await walk(root);
  return results;
}
