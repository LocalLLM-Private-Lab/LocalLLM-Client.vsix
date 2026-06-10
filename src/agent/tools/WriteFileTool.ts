import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';
import { resolveWritePath } from './pathUtils';
import { checkSyntaxAfterWrite, syntaxErrorResult } from './syntaxCheck';

export const WriteFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file (and parent directories) if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
    if (typeof args['path'] !== 'string' || !args['path']) {
      return { success: false, output: 'Missing required argument: path (string)' };
    }
    if (typeof args['content'] !== 'string') {
      return { success: false, output: 'Missing required argument: content (string)' };
    }
    const resolved = resolveWritePath(args['path'], workspaceRoot);
    if (!resolved.ok) {
      return { success: false, output: resolved.error };
    }
    const filePath = resolved.path;

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, args['content'], 'utf8');
      const syntaxError = await checkSyntaxAfterWrite(filePath);
      if (syntaxError) {
        return syntaxErrorResult(filePath, syntaxError);
      }
      return { success: true, output: `Wrote ${filePath}` };
    } catch (err) {
      return { success: false, output: String(err) };
    }
  },
};
