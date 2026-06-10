import type { OllamaClient, OllamaChatDelta, OllamaToolCall } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import { FILE_EDIT_TOOLS } from './ToolRegistry';
import { DegenerationDetector, SelfCorrectionDetector } from './degenerationDetector';
import { compressToolResult } from './toolResultUtils';
import { stripThink, parseToolCalls, invalidateReadCounts, buildRecoveryMessage } from './agentUtils';

export interface AgentEvent {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' |
        'needs_input' | 'input_done' | 'needs_permission' | 'needs_approval' |
        'phase_banner';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  success?: boolean;
  description?: string;
  diff?: string;
  cycle?: number;
}

export type AgentEventHandler = (event: AgentEvent) => void;

const MAX_ITERATIONS = 20;
const MAX_DEGEN_RETRIES = 2;
// Block after reading the same path more than this many times. 4 leaves room
// for the legitimate sequence: outline → full read → range read → narrower
// re-read of a truncation-omitted range.
const FILE_READ_THRESHOLD = 4;

/** Recommended sampling options for coding / tool-use tasks (all agents).
 *  Research: Qwen/DeepSeek best practice (temp 0.2~0.3 for tool calls),
 *  Mirostat 2 with eta 0.1 to keep perplexity constant, repeat_last_n 512.
 *  num_predict / num_ctx are injected from user config by OllamaClient. */
export const CODING_SAMPLE_OPTIONS = {
  temperature: 0.25,
  top_p: 0.9,
  mirostat: 2,
  mirostat_tau: 5.0,
  mirostat_eta: 0.1,
  repeat_penalty: 1.08,
  repeat_last_n: 512,
  frequency_penalty: 0.05,
  presence_penalty: 0.02,
} as const;

export class AgentLoop {
  constructor(
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private workspaceRoot: string,
    /** Explicit think override. Plan-step execution passes false: the work is
     *  repair-type (validated finding) and observed step-thinking was mostly
     *  meta-confusion that burned the whole token budget. */
    private thinkOverride?: boolean
  ) {}

  async run(
    userMessage: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal,
    images?: string[]
  ): Promise<void> {
    this.contextManager.addMessage({ role: 'user', content: userMessage, images });
    await this.runFromContext(onEvent, signal);
  }

  /** context に既にメッセージが積まれている状態からループを開始する（ユーザーメッセージを追加しない） */
  async runFromContext(onEvent: AgentEventHandler, signal: AbortSignal): Promise<void> {
    await this.contextManager.compactIfNeeded(signal);

    // Fingerprint-based loop detection: track (tool + args hash) of recent calls.
    const recentFingerprints: string[] = [];
    const MAX_FINGERPRINT_HISTORY = 10;
    const LOOP_THRESHOLD = 3;

    // File-path-level read loop detection (separate from fingerprint — catches same file with different ranges)
    const fileReadCounts = new Map<string, number>();

    const degDetector = new DegenerationDetector();
    const selfCorrDetector = new SelfCorrectionDetector();
    let degenerationRetries = 0;
    let emptyOutputNudged = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal.aborted) {
        onEvent({ type: 'done' });
        return;
      }

      // Per-call controller: degeneration only aborts THIS generation, not the whole agent
      const callController = new AbortController();
      const propagateAbort = () => callController.abort();
      signal.addEventListener('abort', propagateAbort, { once: true });

      const messages = this.contextManager.getMessages();
      let accumulatedContent = '';
      const accumulatedToolCalls: OllamaToolCall[] = [];
      let degenerated = false;
      degDetector.reset();
      selfCorrDetector.reset();

      const onDelta = (delta: OllamaChatDelta) => {
        if (delta.content) {
          accumulatedContent += delta.content;
          onEvent({ type: 'text', content: delta.content });
          if (!degenerated && (degDetector.feed(delta.content) || selfCorrDetector.feed(delta.content))) {
            degenerated = true;
            callController.abort();
          }
        }
        if (delta.tool_calls) {
          accumulatedToolCalls.push(...delta.tool_calls);
        }
      };

      const hasImages = messages.some(m => m.images && m.images.length > 0);
      const temperature = degenerationRetries > 0 ? 0.55 : CODING_SAMPLE_OPTIONS.temperature;

      try {
        await this.client.chatStream(
          {
            model: this.modelRouter.getModelForImages(hasImages),
            messages,
            tools: this.toolRegistry.toOllamaTools(),
            ...(this.thinkOverride !== undefined
              ? { think: this.thinkOverride }
              : (this.modelRouter.needsThinkParam() && { think: true })),
            options: { ...CODING_SAMPLE_OPTIONS, temperature },
          },
          onDelta,
          callController.signal
        );
      } catch {
        // AbortError from callController (degeneration) or from user stop — handled below
      } finally {
        signal.removeEventListener('abort', propagateAbort);
      }

      if (signal.aborted) {
        onEvent({ type: 'done' });
        return;
      }

      if (degenerated) {
        degenerationRetries++;
        if (degenerationRetries > MAX_DEGEN_RETRIES) {
          onEvent({ type: 'error', content: `出力の縮退リトライ上限(${MAX_DEGEN_RETRIES})に達しました。エージェントを停止します。` });
          return;
        }
        this.contextManager.truncateLastToolMessage(400);
        this.contextManager.addMessage({
          role: 'user',
          content: buildRecoveryMessage(accumulatedContent, degenerationRetries, MAX_DEGEN_RETRIES),
        });
        onEvent({ type: 'text', content: `\n⚠ 縮退を検知しました（リトライ ${degenerationRetries}/${MAX_DEGEN_RETRIES}）\n\n` });
        continue; // Retry this iteration
      }

      // Reset degeneration counter after a clean generation
      degenerationRetries = 0;

      const toolCalls = accumulatedToolCalls;

      const cleanContent = stripThink(accumulatedContent).trim();

      // Empty-output guard: the model spent the whole generation thinking and
      // produced neither text nor a tool call. Ending here would look like a
      // successful turn to the caller. Nudge once, then give up gracefully.
      if (toolCalls.length === 0 && cleanContent === '') {
        if (!emptyOutputNudged) {
          emptyOutputNudged = true;
          this.contextManager.addMessage({
            role: 'user',
            content:
              '[EMPTY OUTPUT] 直前の応答は空でした（思考のみで出力なし）。' +
              'ツールを呼び出すか、最終回答をテキストで出力してください。考察は1〜2文で十分です。',
          });
          onEvent({ type: 'text', content: '\n⚠ 空の応答を検知 — 再試行します。\n' });
          continue;
        }
        onEvent({ type: 'done' });
        return;
      }

      this.contextManager.addMessage({
        role: 'assistant',
        content: cleanContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (!toolCalls || toolCalls.length === 0) {
        onEvent({ type: 'done' });
        return;
      }

      // Parse args and assign stable IDs up front
      const callData = parseToolCalls(toolCalls);

      // Emit all tool_call events before execution
      for (const { call, parsedArgs, id } of callData) {
        onEvent({ type: 'tool_call', toolName: call.function.name, toolArgs: parsedArgs, toolCallId: id });
      }

      // Loop detection BEFORE execution — a blocked call must not run at all
      // (side-effecting tools like run_terminal would otherwise execute again).
      const blockedResults = new Map<number, { success: boolean; output: string }>();
      for (let j = 0; j < callData.length; j++) {
        const { call, parsedArgs } = callData[j];

        // Fingerprint-based loop detection (identical tool + args)
        const fingerprint = `${call.function.name}::${JSON.stringify(parsedArgs)}`;
        const repeatCount = recentFingerprints.filter(f => f === fingerprint).length;
        recentFingerprints.push(fingerprint);
        if (recentFingerprints.length > MAX_FINGERPRINT_HISTORY) recentFingerprints.shift();

        if (repeatCount >= LOOP_THRESHOLD - 1) {
          blockedResults.set(j, {
            success: false,
            output:
              `[LOOP DETECTED] You have called ${call.function.name} with identical arguments ${repeatCount + 1} times. ` +
              `This output is already in your context — calling again returns the same data. ` +
              `You MUST take a different action: call a different tool, edit a file, or provide your final answer.`,
          });
          continue;
        }

        // A repeated IDENTICAL edit is never useful and actively harmful:
        // re-applying the same replace_lines duplicates the inserted lines
        // (observed: __init__ ended up with the same 3 lines tripled).
        if (FILE_EDIT_TOOLS.has(call.function.name) && repeatCount >= 1) {
          blockedResults.set(j, {
            success: false,
            output:
              `[DUPLICATE EDIT BLOCKED] This exact ${call.function.name} call was already applied. ` +
              `Applying it again would duplicate the inserted lines. ` +
              `The file HAS changed — read the current region (re-reads after edits are allowed) and take a different action.`,
          });
          continue;
        }

        if (call.function.name === 'read_file') {
          // File-path-level loop detection (same file, any line range)
          const filePath = typeof parsedArgs['path'] === 'string' ? parsedArgs['path'] : JSON.stringify(parsedArgs);
          const count = (fileReadCounts.get(filePath) ?? 0) + 1;
          fileReadCounts.set(filePath, count);
          if (count > FILE_READ_THRESHOLD) {
            blockedResults.set(j, {
              success: false,
              output:
                `[READ LOOP] "${filePath}" を既に ${count - 1} 回読んでいます。` +
                `内容はすでにコンテキスト内にあります。同じファイルを再読しないでください。` +
                `edit_file または replace_lines で修正を適用するか、別のファイルを確認してください。`,
            });
          }
        }
      }

      const needsSerial = callData.some(({ call }) =>
        this.toolRegistry.requiresPermission(call.function.name)
      );

      const results: Array<{ success: boolean; output: string }> = new Array(callData.length);
      if (needsSerial || callData.length === 1) {
        for (let j = 0; j < callData.length; j++) {
          if (blockedResults.has(j)) continue;
          const { call, parsedArgs } = callData[j];
          if (signal.aborted) { results[j] = { success: false, output: 'Aborted' }; continue; }
          results[j] = await this.toolRegistry.execute(call.function.name, parsedArgs, this.workspaceRoot, signal);
        }
      } else {
        await Promise.all(
          callData.map(async ({ call, parsedArgs }, j) => {
            if (blockedResults.has(j)) return;
            results[j] = await this.toolRegistry.execute(call.function.name, parsedArgs, this.workspaceRoot, signal);
          })
        );
      }

      for (let j = 0; j < callData.length; j++) {
        const { id, call, parsedArgs } = callData[j];
        const result = blockedResults.get(j) ?? results[j] ?? { success: false, output: 'No result' };

        // A file edit invalidates its read history: re-reading CHANGED content
        // is legitimate and required (the syntax-error recovery flow says
        // "read the whole function first"). Blocking it forced blind patches.
        if (FILE_EDIT_TOOLS.has(call.function.name) && typeof parsedArgs['path'] === 'string') {
          invalidateReadCounts(fileReadCounts, parsedArgs['path']);
        }

        onEvent({ type: 'tool_result', content: result.output, success: result.success, toolCallId: id });
        this.contextManager.addMessage({
          role: 'tool',
          content: compressToolResult(result.output, call.function.name),
          tool_call_id: id,
        });
      }
    }

    onEvent({ type: 'error', content: `Max iterations (${MAX_ITERATIONS}) reached` });
  }
}
