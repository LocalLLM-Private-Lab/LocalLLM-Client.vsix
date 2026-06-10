import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';

export const ReadFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read the contents of a file. Output includes line numbers (format: "N\\tcontent") ' +
    'so you can use replace_lines with exact line numbers. ' +
    'Use start_line/end_line to read a specific range of a large file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative file path' },
      start_line: { type: 'number', description: 'First line to read, 1-indexed (default: 1)' },
      end_line: { type: 'number', description: 'Last line to read, 1-indexed inclusive (default: end of file)' },
    },
    required: ['path'],
  },
  async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
    if (typeof args['path'] !== 'string' || !args['path']) {
      return { success: false, output: 'Missing required argument: path (string)' };
    }
    const filePath = path.isAbsolute(args['path'])
      ? args['path']
      : path.join(workspaceRoot, args['path']);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split('\n');

      const start = typeof args['start_line'] === 'number' ? Math.max(1, args['start_line']) : 1;
      const end = typeof args['end_line'] === 'number' ? Math.min(args['end_line'], lines.length) : lines.length;
      const slice = lines.slice(start - 1, end);

      const width = String(end).length;
      const numbered = slice
        .map((line, i) => `${String(start + i).padStart(width)}\t${line}`)
        .join('\n');

      return { success: true, output: numbered };
    } catch (err) {
      return { success: false, output: String(err) };
    }
  },
};
