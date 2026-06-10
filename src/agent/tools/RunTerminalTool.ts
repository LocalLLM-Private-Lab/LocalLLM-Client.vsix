import { exec } from 'child_process';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';

const TIMEOUT_MS = 30_000;
const IS_WIN = process.platform === 'win32';

export const RunTerminalTool: ToolDefinition = {
  name: 'run_terminal',
  description: IS_WIN
    ? 'Run a PowerShell command in the workspace directory. ' +
      'IMPORTANT: Use PowerShell syntax — NOT cmd.exe or bash syntax. ' +
      'Examples: Get-ChildItem (not ls), Get-ChildItem -Recurse (not ls -R), Get-Date (not date). ' +
      'Chain commands with ";" — "&" and "&&" are cmd.exe/bash syntax and FAIL in PowerShell. ' +
      'Avoid interactive commands that wait for user input.'
    : 'Run a bash shell command in the workspace directory. ' +
      'Use for running tests, builds, git commands, file inspection, etc. ' +
      'Avoid interactive commands that wait for user input.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      description: { type: 'string', description: 'Short description of what this command does (for logging and context)' },
      timeout_seconds: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' },
    },
    required: ['command'],
  },
  async execute(
    args: Record<string, unknown>,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (typeof args['command'] !== 'string' || !args['command']) {
      return { success: false, output: 'Missing required argument: command (string)' };
    }
    const command = args['command'];
    const timeoutMs = typeof args['timeout_seconds'] === 'number'
      ? Math.min(args['timeout_seconds'], 120) * 1000
      : TIMEOUT_MS;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const opts = { cwd: workspaceRoot, timeout: timeoutMs, maxBuffer: 512 * 1024 };

      let cmdStr: string;
      if (IS_WIN) {
        // Force UTF-8 output so Japanese/CJK characters are not garbled.
        // -EncodedCommand avoids all quote-escaping issues (expects UTF-16LE base64).
        const wrapped =
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
          '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
          command;
        const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
        cmdStr = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
      } else {
        cmdStr = command;
      }

      const proc = exec(
        cmdStr,
        IS_WIN ? opts : { ...opts, shell: '/bin/bash' },
        (error, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (error?.killed) {
            settle({ success: false, output: `Timed out after ${timeoutMs / 1000}s` });
          } else if (error && !out) {
            settle({ success: false, output: `Error (exit ${error.code ?? '?'}): ${error.message}` });
          } else if (error) {
            // Non-zero exit — report failure but include the output so the
            // model sees the actual error message (success:true here would
            // mislead the agent into treating a failed command as passed).
            settle({ success: false, output: `(exit ${error.code ?? '?'})\n${out}` });
          } else {
            settle({ success: true, output: out || '(no output)' });
          }
        }
      );

      signal?.addEventListener('abort', () => {
        try { proc.kill(); } catch { /* already dead */ }
        settle({ success: false, output: 'Cancelled by user' });
      }, { once: true });
    });
  },
};
