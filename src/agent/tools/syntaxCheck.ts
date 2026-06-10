import { execFile } from 'child_process';

/**
 * Cheap post-write syntax validation. An edit that introduces a syntax error
 * is otherwise reported as success and only discovered much later when the
 * program is run (observed: a duplicate-else from a misaligned replace_lines
 * survived two more steps before `python image_viewer.py` exposed it).
 *
 * Returns null when the file is fine, the language has no checker, or the
 * interpreter is not installed; returns the error text otherwise.
 */
export async function checkSyntaxAfterWrite(filePath: string): Promise<string | null> {
  if (!/\.py$/i.test(filePath)) return null;

  return new Promise((resolve) => {
    execFile(
      'python',
      ['-m', 'py_compile', filePath],
      { timeout: 10_000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve(null);
          return;
        }
        // python not installed / not on PATH — skip silently
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve(null);
          return;
        }
        resolve((stderr || err.message || 'syntax check failed').trim().slice(0, 500));
      }
    );
  });
}

/** Shared tool-result suffix for a failed post-write syntax check. */
export function syntaxErrorResult(filePath: string, syntaxError: string): { success: false; output: string } {
  return {
    success: false,
    output:
      `Edit was APPLIED to ${filePath}, BUT it introduced a SYNTAX ERROR — the file is currently broken:\n` +
      `${syntaxError}\n` +
      `RECOVERY (do exactly this): 1) read_file the WHOLE enclosing function with current line numbers, ` +
      `2) rewrite the ENTIRE function in ONE replace_lines call. ` +
      `Do NOT patch small fragments — fragment patches with stale line numbers are what cause these errors.`,
  };
}
