import * as fs from 'fs/promises';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';
import { resolveWritePath } from './pathUtils';
import { checkSyntaxAfterWrite, syntaxErrorResult } from './syntaxCheck';

export const EditFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string with a new string. ' +
    'REQUIRED: always include the path parameter (relative path from workspace root, e.g. "src/main.py"). ' +
    'old_str must appear exactly once in the file — include enough surrounding context lines to make it unique. ' +
    'Use write_file instead if you need to create a new file or rewrite the entire content.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path to edit',
      },
      old_str: {
        type: 'string',
        description: 'The exact string to find and replace (must be unique in the file)',
      },
      new_str: {
        type: 'string',
        description: 'The replacement string',
      },
    },
    required: ['path', 'old_str', 'new_str'],
  },
  async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
    if (typeof args['path'] !== 'string' || !args['path']) {
      return { success: false, output: 'Missing required argument: path (string)' };
    }
    if (typeof args['old_str'] !== 'string') {
      return { success: false, output: 'Missing required argument: old_str (string)' };
    }
    if (typeof args['new_str'] !== 'string') {
      return { success: false, output: 'Missing required argument: new_str (string)' };
    }
    const resolved = resolveWritePath(args['path'], workspaceRoot);
    if (!resolved.ok) {
      return { success: false, output: resolved.error };
    }
    const filePath = resolved.path;

    const oldStr = args['old_str'];
    const newStr = args['new_str'];

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      return { success: false, output: `Cannot read file: ${String(err)}` };
    }

    // Normalize line endings for robust matching (CRLF → LF for comparison)
    const hasCRLF = content.includes('\r\n');
    const normContent = hasCRLF ? content.replace(/\r\n/g, '\n') : content;
    const normOld = oldStr.replace(/\r\n/g, '\n');
    const normNew = newStr.replace(/\r\n/g, '\n');

    const occurrences = normContent.split(normOld).length - 1;

    if (occurrences === 0) {
      const hint = findClosestContext(normContent, normOld);
      return {
        success: false,
        output:
          `edit_file FAILED: old_str not found in ${filePath}.\n` +
          `You must call read_file first to get the exact content, then retry with the precise text.\n` +
          (hint
            ? `Best match found around line ${hint.lineNo}:\n\`\`\`\n${hint.context}\n\`\`\`\n` +
              `Use the exact lines above (copy them verbatim) as old_str.`
            : ''),
      };
    }

    if (occurrences > 1) {
      return {
        success: false,
        output:
          `old_str appears ${occurrences} times in ${filePath}. ` +
          `Add more surrounding lines to make it unique.`,
      };
    }

    // Replace and restore original line endings if needed
    let updated = normContent.replace(normOld, normNew);
    if (hasCRLF) updated = updated.replace(/\n/g, '\r\n');
    await fs.writeFile(filePath, updated, 'utf8');

    const syntaxError = await checkSyntaxAfterWrite(filePath);
    if (syntaxError) {
      return syntaxErrorResult(filePath, syntaxError);
    }

    const linesBefore = (normContent.slice(0, normContent.indexOf(normOld)).match(/\n/g) ?? []).length + 1;
    return { success: true, output: `Edited ${filePath} at line ~${linesBefore}` };
  },
};

/** old_str の先頭に最も近い行とその周辺コンテキストを返す */
function findClosestContext(content: string, needle: string): { lineNo: number; context: string } | null {
  const head = needle.trimStart().slice(0, 60);
  if (!head) return null;

  const lines = content.split('\n');
  let bestIdx = -1;
  let bestScore = 4; // minimum threshold

  for (let i = 0; i < lines.length; i++) {
    const score = commonPrefixLength(lines[i].trim().toLowerCase(), head.trim().toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return null;

  // Show enough lines to cover the full needle (estimate by line count) + 2 buffer
  const needleLineCount = needle.split('\n').length;
  const contextLines = Math.max(needleLineCount + 2, 10);
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(lines.length - 1, bestIdx + contextLines);

  return {
    lineNo: bestIdx + 1,
    context: lines.slice(start, end + 1).join('\n'),
  };
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
