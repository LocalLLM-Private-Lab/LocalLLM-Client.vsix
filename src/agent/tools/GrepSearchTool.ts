import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode', '__pycache__']);
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.vsix', '.bin',
]);

export const GrepSearchTool: ToolDefinition = {
  name: 'grep_search',
  description:
    'Search for a pattern inside file contents. Returns matching lines with file path and line number. ' +
    'Use this to find where a function/class/variable is defined or used.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search string or regex pattern',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in (default: workspace root)',
      },
      glob: {
        type: 'string',
        description: 'File extension filter, e.g. "*.ts" or "*.py"',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Case sensitive search (default: true)',
      },
      max_results: {
        type: 'number',
        description: 'Max matching lines to return (default: 50)',
      },
    },
    required: ['pattern'],
  },
  async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
    if (typeof args['pattern'] !== 'string' || !args['pattern']) {
      return { success: false, output: 'Missing required argument: pattern (string)' };
    }
    const pattern = args['pattern'];
    const rawPath = typeof args['path'] === 'string' ? args['path'] : undefined;
    const globFilter = typeof args['glob'] === 'string' ? args['glob'] : undefined;
    const caseSensitive = typeof args['case_sensitive'] === 'boolean' ? args['case_sensitive'] : true;
    const maxResults = typeof args['max_results'] === 'number' ? args['max_results'] : 50;

    const searchRoot = rawPath
      ? path.isAbsolute(rawPath) ? rawPath : path.join(workspaceRoot, rawPath)
      : workspaceRoot;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch {
      return { success: false, output: `Invalid regex pattern: ${pattern}` };
    }

    const globRegex = globFilter ? globToRegex(globFilter) : null;
    const results: string[] = [];

    await walk(searchRoot, workspaceRoot, regex, globRegex, results, maxResults);

    if (results.length === 0) return { success: true, output: '(no matches)' };
    if (results.length === maxResults) results.push(`... (limit ${maxResults} reached)`);
    return { success: true, output: results.join('\n') };
  },
};

async function walk(
  dir: string,
  workspaceRoot: string,
  pattern: RegExp,
  globRegex: RegExp | null,
  results: string[],
  limit: number
): Promise<void> {
  if (results.length >= limit) return;

  const stat = await fs.stat(dir).catch(() => null);
  if (!stat) return;

  if (stat.isFile()) {
    await searchFile(dir, workspaceRoot, pattern, globRegex, results, limit);
    return;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (results.length >= limit) break;
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, workspaceRoot, pattern, globRegex, results, limit);
    } else {
      await searchFile(full, workspaceRoot, pattern, globRegex, results, limit);
    }
  }
}

async function searchFile(
  filePath: string,
  workspaceRoot: string,
  pattern: RegExp,
  globRegex: RegExp | null,
  results: string[],
  limit: number
): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return;

  if (globRegex && !globRegex.test(path.basename(filePath))) return;

  const content = await fs.readFile(filePath, 'utf8').catch(() => null);
  if (!content) return;

  const relative = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && results.length < limit; i++) {
    // Reset lastIndex for global flag if set
    pattern.lastIndex = 0;
    if (pattern.test(lines[i])) {
      results.push(`${relative}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
