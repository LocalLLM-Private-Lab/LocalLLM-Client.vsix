import type { OllamaTool } from '../llm/OllamaClient';

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<ToolResult>;
}

/** All tools that modify files — single source of truth for permission logic */
export const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'replace_lines']);

/** Tools that require explicit user permission before execution */
const PERMISSION_REQUIRED = new Set([...FILE_EDIT_TOOLS, 'run_terminal']);

/** true = allowed, false = denied (generic), string = denied with specific reason */
type PermissionCallback = (toolName: string, args: Record<string, unknown>) => Promise<boolean | string>;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private permissionCallback?: PermissionCallback;

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  setPermissionCallback(cb: PermissionCallback): void {
    this.permissionCallback = cb;
  }

  requiresPermission(name: string): boolean {
    return PERMISSION_REQUIRED.has(name);
  }

  toOllamaTools(): OllamaTool[] {
    return Array.from(this.tools.values()).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: { ...t.parameters, additionalProperties: false },
      },
    }));
  }

  toReActDescription(): string {
    return Array.from(this.tools.values())
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    workspaceRoot: string,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      const available = Array.from(this.tools.keys()).join(', ');
      return { success: false, output: `Unknown tool: "${name}". Available tools: ${available}` };
    }

    // Strict schema validation — catch bad args before execution
    const params = tool.parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const allowedKeys = new Set(Object.keys(params.properties ?? {}));
    const required = params.required ?? [];
    const missing = required.filter((k) => !(k in args));
    if (missing.length > 0) {
      return {
        success: false,
        output:
          `Missing required argument(s) for "${name}": ${missing.join(', ')}. ` +
          `Required: ${required.join(', ')}. Received: ${Object.keys(args).join(', ') || '(none)'}`,
      };
    }
    const extra = Object.keys(args).filter((k) => allowedKeys.size > 0 && !allowedKeys.has(k));
    if (extra.length > 0) {
      return {
        success: false,
        output:
          `Unknown argument(s) for "${name}": ${extra.join(', ')}. ` +
          `Allowed: ${Array.from(allowedKeys).join(', ')}`,
      };
    }
    if (PERMISSION_REQUIRED.has(name) && this.permissionCallback) {
      const result = await this.permissionCallback(name, args);
      if (result !== true) {
        const reason = typeof result === 'string'
          ? result
          : 'Permission denied by user. Do not retry this operation.';
        return { success: false, output: reason };
      }
    }
    try {
      return await tool.execute(args, workspaceRoot, signal);
    } catch (err) {
      return { success: false, output: `Tool error: ${String(err)}` };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
