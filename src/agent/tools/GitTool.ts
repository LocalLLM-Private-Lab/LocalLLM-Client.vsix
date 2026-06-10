import type { ToolDefinition, ToolResult } from '../ToolRegistry';
import type { GitManager } from '../../git/GitManager';

export function createGitTool(gitManager: GitManager): ToolDefinition {
  return {
    name: 'git',
    description:
      'Run safe Git operations: status, diff, log, checkout, branch. ' +
      'Force-push and reset --hard are blocked.',
    parameters: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          enum: ['status', 'diff', 'log', 'branch', 'checkout', 'show'],
          description: 'Git subcommand to run',
        },
        args: {
          type: 'string',
          description: 'Additional arguments (e.g. "--oneline -10" for log)',
        },
      },
      required: ['subcommand'],
    },
    async execute(args: Record<string, unknown>, workspaceRoot: string): Promise<ToolResult> {
      if (typeof args['subcommand'] !== 'string' || !args['subcommand']) {
        return { success: false, output: 'Missing required argument: subcommand (string)' };
      }
      const subcommand = args['subcommand'];
      const extraArgs = typeof args['args'] === 'string' ? args['args'] : '';
      return gitManager.runSafe(workspaceRoot, subcommand, extraArgs);
    },
  };
}
