import type { ToolDefinition, ToolResult } from '../ToolRegistry';

/**
 * Factory — inject the VS Code UI prompt so this tool can call showQuickPick / showInputBox
 * without importing 'vscode' in a sandboxed context.
 */
export function createAskUserTool(
  promptFn: (question: string, options?: string[]) => Promise<string | undefined>
): ToolDefinition {
  return {
    name: 'ask_user',
    description:
      'Ask the user a question directly and receive their answer as a string. ' +
      'Use this when you need a decision, preference, or clarification that cannot be determined from the code or project context. ' +
      'Optionally provide a list of options to show as a selection menu. ' +
      'Do NOT use this for things you can figure out yourself.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of choices to present as a quick-pick menu',
        },
      },
      required: ['question'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (typeof args['question'] !== 'string' || !args['question']) {
        return { success: false, output: 'Missing required argument: question (string)' };
      }
      const options = Array.isArray(args['options']) ? (args['options'] as string[]) : undefined;
      const answer = await promptFn(args['question'], options);
      if (answer === undefined) {
        return { success: false, output: 'User cancelled or did not respond.' };
      }
      return { success: true, output: answer };
    },
  };
}
