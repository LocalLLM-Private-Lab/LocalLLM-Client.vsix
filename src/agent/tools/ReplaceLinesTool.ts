import * as fs from 'fs/promises';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';
import { resolveWritePath } from './pathUtils';
import { checkSyntaxAfterWrite, syntaxErrorResult } from './syntaxCheck';

export const ReplaceLinesTool: ToolDefinition = {
  name: 'replace_lines',
  description:
    'Replace a range of lines in a file with new content. ' +
    'Use this after read_file when you know the exact line numbers to replace — ' +
    'it is more reliable than edit_file because it does not require exact string matching. ' +
    'Lines are 1-indexed and inclusive on both ends. ' +
    'IMPORTANT: replace WHOLE logical blocks (an entire function/method, from its def/first line ' +
    'to the LAST line of its body) — patching small fragments inside an indented block ' +
    'frequently corrupts indentation. ' +
    'Line numbers SHIFT after every edit: always take them from the latest read_file ' +
    'or from the "Resulting region" echo of the previous edit. ' +
    'new_content replaces the entire range; use an empty string to delete lines.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path to edit (relative from workspace root or absolute)',
      },
      start_line: {
        type: 'number',
        description: 'First line to replace (1-indexed, inclusive)',
      },
      end_line: {
        type: 'number',
        description: 'Last line to replace (1-indexed, inclusive)',
      },
      new_content: {
        type: 'string',
        description: 'Replacement text. Replaces lines start_line through end_line entirely.',
      },
    },
    required: ['path', 'start_line', 'end_line', 'new_content'],
  },
  async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
    if (typeof args['path'] !== 'string' || !args['path']) {
      return { success: false, output: 'Missing required argument: path (string)' };
    }
    if (typeof args['start_line'] !== 'number') {
      return { success: false, output: 'Missing required argument: start_line (number)' };
    }
    if (typeof args['end_line'] !== 'number') {
      return { success: false, output: 'Missing required argument: end_line (number)' };
    }
    if (typeof args['new_content'] !== 'string') {
      return { success: false, output: 'Missing required argument: new_content (string)' };
    }

    const resolved = resolveWritePath(args['path'], workspaceRoot);
    if (!resolved.ok) {
      return { success: false, output: resolved.error };
    }
    const filePath = resolved.path;

    const startLine = Math.round(args['start_line']);
    const endLine = Math.round(args['end_line']);

    if (startLine < 1) {
      return { success: false, output: 'start_line must be >= 1' };
    }
    if (endLine < startLine) {
      return { success: false, output: `end_line (${endLine}) must be >= start_line (${startLine})` };
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      return { success: false, output: `Cannot read file: ${String(err)}` };
    }

    const hasCRLF = content.includes('\r\n');
    const norm = hasCRLF ? content.replace(/\r\n/g, '\n') : content;
    // Preserve trailing newline state
    const trailingNewline = norm.endsWith('\n');

    const lines = norm.endsWith('\n')
      ? norm.slice(0, -1).split('\n')
      : norm.split('\n');

    if (startLine > lines.length) {
      return {
        success: false,
        output: `start_line ${startLine} exceeds file length (${lines.length} lines). Read the file first.`,
      };
    }

    const clampedEnd = Math.min(endLine, lines.length);
    const newLines = args['new_content'] === ''
      ? []
      : args['new_content'].replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(clampedEnd);
    const merged = [...before, ...newLines, ...after];

    let result = merged.join('\n');
    if (trailingNewline) result += '\n';
    if (hasCRLF) result = result.replace(/\n/g, '\r\n');

    await fs.writeFile(filePath, result, 'utf8');

    const syntaxError = await checkSyntaxAfterWrite(filePath);
    if (syntaxError) {
      return syntaxErrorResult(filePath, syntaxError);
    }

    // Echo the resulting region (with NEW line numbers) so the model sees
    // what the file actually looks like now. A replacement that misses part
    // of the original block (e.g. leaves a duplicate trailing `else:`) is
    // visible immediately, and subsequent edits use correct line numbers
    // instead of pre-edit ones.
    const echoStartIdx = Math.max(0, startLine - 3);
    const echoEndIdx = Math.min(merged.length, startLine - 1 + newLines.length + 2);
    const width = String(echoEndIdx).length;
    const echo = merged
      .slice(echoStartIdx, echoEndIdx)
      .map((l, i) => `${String(echoStartIdx + i + 1).padStart(width)}\t${l}`)
      .join('\n');

    const replacedCount = clampedEnd - startLine + 1;
    return {
      success: true,
      output:
        `Replaced lines ${startLine}–${clampedEnd} (${replacedCount} line${replacedCount !== 1 ? 's' : ''}) ` +
        `with ${newLines.length} line${newLines.length !== 1 ? 's' : ''} in ${filePath}\n` +
        `Resulting region (line numbers are CURRENT — use these for further edits):\n${echo}`,
    };
  },
};
