import { execFile } from 'child_process';
import * as util from 'util';
import type { ToolResult } from '../agent/ToolRegistry';

const execFileAsync = util.promisify(execFile);

/** Split a shell-ish argument string, honoring single/double quotes. */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/** Token-level check — regex over the raw string would false-positive on
 *  branch names like "my-fix" (matched by /push\s.*-f/). */
function isDangerousGitCommand(subcommand: string, argTokens: string[]): boolean {
  const all = [subcommand, ...argTokens];
  if (all.includes('--force') || all.includes('--force-with-lease') || all.includes('--hard')) {
    return true;
  }
  // Combined short flags too: -f, -fd, -df …
  const hasShortF = argTokens.some(t => /^-[a-z]*f[a-z]*$/i.test(t));
  if ((subcommand === 'push' || subcommand === 'clean') && hasShortF) return true;
  return false;
}

/**
 * Git 操作ユーティリティ。
 * - エージェントによる変更前の自動コミット（スナップショット）
 * - 安全コマンドのみを通すフィルタ
 * - スナップショットへのロールバック
 */
export class GitManager {
  private snapshotSha: string | null = null;

  async isRepo(workspaceRoot: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }

  /** エージェントが変更を加える前にスナップショットコミットを作成する */
  async createSnapshot(workspaceRoot: string): Promise<string | null> {
    try {
      const hasChanges = await this.hasUncommittedChanges(workspaceRoot);
      if (!hasChanges) {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: workspaceRoot,
        });
        this.snapshotSha = stdout.trim();
        return this.snapshotSha;
      }

      await execFileAsync('git', ['add', '-A'], { cwd: workspaceRoot });
      await execFileAsync(
        'git',
        ['commit', '-m', '[local-llm] pre-agent snapshot', '--no-verify'],
        { cwd: workspaceRoot }
      );

      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: workspaceRoot,
      });
      this.snapshotSha = stdout.trim();
      return this.snapshotSha;
    } catch {
      return null;
    }
  }

  /** スナップショットに戻す（git reset --hard <sha>） */
  async rollback(workspaceRoot: string): Promise<ToolResult> {
    if (!this.snapshotSha) {
      return { success: false, output: 'No snapshot available to roll back to.' };
    }
    try {
      await execFileAsync('git', ['reset', '--hard', this.snapshotSha], { cwd: workspaceRoot });
      return { success: true, output: `Rolled back to ${this.snapshotSha}` };
    } catch (err) {
      return { success: false, output: String(err) };
    }
  }

  /** エージェントから安全に呼び出せる Git コマンドを実行する */
  async runSafe(workspaceRoot: string, subcommand: string, extraArgs: string): Promise<ToolResult> {
    const argTokens = tokenizeArgs(extraArgs);

    if (isDangerousGitCommand(subcommand, argTokens)) {
      return {
        success: false,
        output: `Command blocked for safety: "${`git ${subcommand} ${extraArgs}`.trim()}"`,
      };
    }

    try {
      const args = [subcommand, ...argTokens];
      const { stdout, stderr } = await execFileAsync('git', args, { cwd: workspaceRoot });
      return { success: true, output: (stdout + stderr).trim() || '(no output)' };
    } catch (err) {
      return { success: false, output: String(err) };
    }
  }

  private async hasUncommittedChanges(workspaceRoot: string): Promise<boolean> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workspaceRoot,
    });
    return stdout.trim().length > 0;
  }
}
