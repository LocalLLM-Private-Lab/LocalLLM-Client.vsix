import type { OllamaClient, OllamaChatDelta, OllamaToolCall } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import { FILE_EDIT_TOOLS } from './ToolRegistry';
import { DegenerationDetector, SelfCorrectionDetector } from './degenerationDetector';
import { compressToolResult } from './toolResultUtils';
import { stripThink, parseToolCalls, invalidateReadCounts, buildRecoveryMessage, stableStringify, LoopGuardState } from './agentUtils';

export interface AgentEvent {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' |
        'needs_input' | 'input_done' | 'needs_permission' | 'needs_approval' |
        'phase_banner' | 'model';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  success?: boolean;
  description?: string;
  /** 承認ダイアログ用の構造化diff(ui/diffUtils.DiffLineと同形。レイヤ分離のため構造的に定義) */
  diffLines?: Array<{ kind: 'add' | 'del' | 'ctx' | 'gap'; oldNo?: number; newNo?: number; text: string }>;
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

  /** context に既にメッセージが積まれている状態からループを開始する（ユーザーメッセージを追加しない）。
   *  loopGuard を渡すと指紋/編集履歴が呼び出しを跨いで共有される（プランの全ステップ・
   *  全再プランサイクルで1つを共有し、ステップ境界を跨ぐ編集の往復を検出する）。 */
  async runFromContext(onEvent: AgentEventHandler, signal: AbortSignal, loopGuard?: LoopGuardState): Promise<void> {
    await this.contextManager.compactIfNeeded(signal, (m) => onEvent({ type: 'thinking', content: m }));

    // Fingerprint-based loop detection: track (tool + args hash) of recent calls.
    const guard = loopGuard ?? new LoopGuardState();
    const recentFingerprints = guard.recentFingerprints;
    const MAX_FINGERPRINT_HISTORY = 10;
    const LOOP_THRESHOLD = 3;

    // File-path-level read loop detection (separate from fingerprint — catches same file with different ranges)
    const fileReadCounts = new Map<string, number>();

    const degDetector = new DegenerationDetector();
    const selfCorrDetector = new SelfCorrectionDetector();
    let degenerationRetries = 0;
    let emptyOutputNudged = false;

    // "Announce-then-stop" rescue: gemma4/qwen3 often end a turn with a
    // DECLARATION of the next action ("…を検索します。") instead of the tool
    // call itself. Without a guard that counts as a final answer and the
    // loop exits — observed run where the USER had to type "よろしく/頑張って"
    // after every single search to keep the agent going. Budget resets after
    // a real tool call so a long run can be rescued more than once;
    // MAX_ITERATIONS still caps the whole loop.
    const MAX_ACTION_NUDGES = 2;
    let actionNudges = 0;
    const toolNames = this.toolRegistry.toOllamaTools().map(t => t.function.name).join('|');
    // Pseudo tool call leaked into TEXT (e.g. `call:web_search{query:…}` or
    // chat-template fragments like <tool_call> / <|tool…) — it was never
    // parsed as a real call, so treating it as a final answer is wrong.
    const pseudoToolCallRe = new RegExp(
      `(?:call:\\s*(?:${toolNames})\\b|\\b(?:${toolNames})\\s*\\{|<tool_call|<\\|tool)`, 'i');
    // Future-intent tail: a specific action noun + します/を行います at the very
    // end of the reply. Kept narrow (検索します etc., not bare します) so real
    // final answers like "…をおすすめします。" don't false-positive.
    const intentTailRe =
      /(?:検索|調査|確認|実行|取得|分析|特定|送信|読み込み|呼び出し)(?:します|を行います|してみます|を実行します)[。．.\s]*$|(?:探します|調べます|試します|見てみます)[。．.\s]*$|\b(?:let me|i(?:'ll| will)|going to)\s+(?:search|look|check|run|investigate|fetch|read|try)\b[\s\S]{0,100}$/i;

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

      // Waiting indicator for EVERY generation start. The webview only
      // re-shows its spinner after tool results / approvals, so generations
      // triggered any other way (step banner, degeneration retry, empty-output
      // retry) ran with no feedback until the first token — on local models
      // prompt evaluation alone can take tens of seconds of "dead" UI.
      onEvent({ type: 'thinking', content: 'Waiting for LLM response…' });

      let streamError: unknown = null;
      try {
        const model = this.modelRouter.getModelForImages(hasImages, 'coder');
        onEvent({ type: 'model', content: model });
        await this.client.chatStream(
          {
            model,
            messages,
            tools: this.toolRegistry.toOllamaTools(),
            ...(this.thinkOverride !== undefined
              ? { think: this.thinkOverride }
              : (this.modelRouter.needsThinkParam(model) && { think: true })),
            options: { ...CODING_SAMPLE_OPTIONS, temperature },
          },
          onDelta,
          callController.signal
        );
      } catch (err) {
        // AbortError from degeneration/user stop is expected and handled below.
        // Everything else (connection refused, timeout, runtime TypeError…)
        // MUST surface — swallowing it shows the user a silent empty response.
        const name = (err as Error)?.name ?? '';
        if (name !== 'AbortError' && !signal.aborted && !degenerated) {
          streamError = err;
        }
      } finally {
        signal.removeEventListener('abort', propagateAbort);
      }

      if (signal.aborted) {
        onEvent({ type: 'done' });
        return;
      }

      if (streamError) {
        onEvent({ type: 'error', content: `LLM request failed: ${String(streamError)}` });
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
        if (actionNudges < MAX_ACTION_NUDGES) {
          let nudge: { message: string; banner: string } | null = null;
          if (pseudoToolCallRe.test(cleanContent)) {
            nudge = {
              message:
                '[MALFORMED TOOL CALL] 直前の応答にはツール呼び出しらしきテキストが含まれていますが、' +
                '本文として出力されたためツールは実行されていません。' +
                'ツールは本文に書かず、正規のtool call形式で呼び出してください。',
              banner: '\n⚠ ツールコールがテキストとして出力されました — 再試行します。\n',
            };
          } else if (intentTailRe.test(cleanContent)) {
            nudge = {
              message:
                '[NO ACTION] 直前の応答は「これから何をするか」の宣言で終わっていますが、' +
                'ツールは呼び出されていません。宣言は実行ではありません。' +
                '今すぐそのツールを呼び出してください。' +
                'すでに結論を出せる状態なら、宣言ではなく最終回答そのものを書いてください。',
              banner: '\n⚠ 宣言のみで終了 — ツール実行を促して再試行します。\n',
            };
          }
          if (nudge) {
            actionNudges++;
            this.contextManager.addMessage({ role: 'user', content: nudge.message });
            onEvent({ type: 'text', content: nudge.banner });
            continue;
          }
        }
        onEvent({ type: 'done' });
        return;
      }

      // Real tool activity: refill the rescue budget — a later
      // announce-then-stop in the same long run should be caught too.
      actionNudges = 0;

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

        // Edit oscillation: the candidate edit re-applies content that was
        // ALREADY applied to this region earlier (any step, any plan cycle)
        // and evidently did not solve the problem. Observed (qwen3 30b a3b):
        // setTransformationMode ↔ setTransformationAnchor alternated 7 times
        // across 2 plan cycles — each variant re-applied as soon as the
        // per-step fingerprint history reset.
        if (FILE_EDIT_TOOLS.has(call.function.name)) {
          const variants = guard.editOscillationCount(call.function.name, parsedArgs);
          if (variants > 0) {
            blockedResults.set(j, {
              success: false,
              output:
                `[EDIT OSCILLATION] This exact content was ALREADY applied to this region earlier ` +
                `and the problem persisted. You have cycled through ${variants} variant(s) of this edit — ` +
                `re-applying any of them CANNOT succeed; the assumption behind all of them is wrong. ` +
                `Do NOT edit this region again until you have: ` +
                `(1) re-read the LATEST error output and quoted the exact failing line; ` +
                `(2) if it is an AttributeError / "has no attribute" / NameError on a library API, ` +
                `verified the correct API name with google_search — your memory of this API is wrong.`,
            });
            continue;
          }
        }

        // Fingerprint-based loop detection (identical tool + args).
        // stableStringify: the model may emit the same args in a different key
        // order — that must still count as the same call.
        const fingerprint = `${call.function.name}::${stableStringify(parsedArgs)}`;
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

        // A syntax-error edit ("Edit was APPLIED … BUT") still changed the
        // file: record it (re-trying that exact content must oscillation-block)
        // and clear stale fingerprints (the world DID change).
        const editApplied =
          FILE_EDIT_TOOLS.has(call.function.name) &&
          (result.success || result.output.includes('Edit was APPLIED'));
        if (editApplied) {
          guard.recordEdit(call.function.name, parsedArgs);
          // A successful edit changes world state: re-running the same test
          // command (or re-reading the same range) afterwards is legitimate
          // verification, NOT a loop. Observed: the edit→test→edit→test cycle
          // tripped [LOOP DETECTED] on the 3rd identical pytest run even
          // though the file had changed in between, leaving the model unable
          // to verify. Keep only edit fingerprints (duplicate-edit guard).
          for (let k = recentFingerprints.length - 1; k >= 0; k--) {
            const toolName = recentFingerprints[k].slice(0, recentFingerprints[k].indexOf('::'));
            if (!FILE_EDIT_TOOLS.has(toolName)) recentFingerprints.splice(k, 1);
          }
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
