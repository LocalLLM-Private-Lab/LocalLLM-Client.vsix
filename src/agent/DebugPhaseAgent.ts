import type { OllamaClient, OllamaChatDelta, OllamaToolCall } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import type { AgentEventHandler } from './AgentLoop';
import { DegenerationDetector, SelfCorrectionDetector } from './degenerationDetector';
import { CODING_SAMPLE_OPTIONS } from './AgentLoop';
import { compressToolResult } from './toolResultUtils';
import { BehaviorVerifier } from './BehaviorVerifier';
import { stripThink, parseToolCalls, invalidateReadCounts, buildRecoveryMessage } from './agentUtils';

/**
 * 3-phase debug agent: Localize → Repair → Validate
 *
 * Based on research (Agentless 2024, AutoCodeRover 2024):
 * separating localization from repair improves accuracy vs. a single
 * open-ended ReAct loop, and reduces wasted context from reading whole files.
 *
 * Phase 1 – Localize  : grep/outline only, hypothesis-first, outputs LOCALIZED marker
 * Phase 2 – Repair    : targeted read + edit, receives phase-1 context
 * Phase 3 – Validate  : run_terminal only, reports PASS/FAIL
 *
 * Stability features (from local LLM agent research):
 * - Per-call AbortController: degeneration only aborts the current generation
 * - Retry on degeneration up to MAX_DEGEN_RETRIES with recovery injection
 * - File-path-level read loop detection (catches same file with varying line ranges)
 * - REPAIR enforcement: forces edit_file/replace_lines if REPAIRED: appears without any write
 * - Mirostat 2 + low temperature sampling to reduce repetition collapse
 */

const MAX_DEGEN_RETRIES = 2;
const FILE_READ_THRESHOLD = 3;
const MAX_FORCED_EDIT = 1;

const WRITE_TOOLS = new Set(['edit_file', 'replace_lines', 'write_file']);

export class DebugPhaseAgent {
  constructor(
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private workspaceRoot: string,
    private outputLanguage: string = 'Japanese',
    private enableVerify = true
  ) {}

  /** Files modified by write tools during this run (for the Verify phase) */
  private editedFiles = new Set<string>();

  async run(
    userMessage: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal,
    images?: string[]
  ): Promise<void> {
    this.contextManager.addMessage({ role: 'user', content: userMessage, images });
    await this.contextManager.compactIfNeeded(signal, (m) => onEvent({ type: 'thinking', content: m }));
    this.editedFiles.clear();

    // ── Phase 1: Localize ──────────────────────────────────────────────────
    onEvent({ type: 'phase_banner', content: '**[Phase 1/3: Localize]** 仮説生成 → 構造確認 → 箇所特定' });

    const localizeResult = await this.runPhase({
      phaseName: 'LOCALIZE',
      systemPrompt: this.buildLocalizePrompt(),
      allowedTools: new Set(['glob_search', 'grep_search', 'get_file_outline']),
      maxIterations: 10,
      terminationPattern: /LOCALIZED:/i,
      signal,
      onEvent,
    });

    if (signal.aborted) { onEvent({ type: 'done' }); return; }

    this.contextManager.addMessage({
      role: 'user',
      content: `[Phase 1 complete]\nLocalization result:\n${localizeResult}`,
    });

    // ── Phase 2+3: Repair → Validate, with ONE back-edge on FAIL ──────────
    // A linear pipeline has no recovery path when Validate reports FAIL.
    // One retry round sends the FAIL reason back into Repair.
    const MAX_REPAIR_ROUNDS = 2;
    for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
      const retryTag = round > 1 ? ` — retry ${round - 1}` : '';
      onEvent({ type: 'phase_banner', content: `**[Phase 2/3: Repair${retryTag}]** 対象箇所を読んで修正を適用` });

      await this.runPhase({
        phaseName: 'REPAIR',
        systemPrompt: this.buildRepairPrompt(localizeResult),
        allowedTools: new Set(['read_file', 'get_file_outline', 'grep_search', 'edit_file', 'replace_lines', 'write_file']),
        maxIterations: 10,
        terminationPattern: /REPAIRED:|FIX APPLIED:|FIXED:/i,
        signal,
        onEvent,
        // Validated: thinking during repair burns the token budget in
        // self-correction loops (637s zero-content failure vs 168s success).
        think: false,
        // Full-method rewrites need headroom beyond the default budget
        extraOptions: { num_predict: Math.round(this.modelRouter.getMaxTokens() * 1.5) },
      });

      if (signal.aborted) { onEvent({ type: 'done' }); return; }

      onEvent({ type: 'phase_banner', content: `**[Phase 3/3: Validate${retryTag}]** テスト・ビルドで修正を確認` });

      const validateResult = await this.runPhase({
        phaseName: 'VALIDATE',
        systemPrompt: this.buildValidatePrompt(),
        allowedTools: new Set(['run_terminal']),
        maxIterations: 4,
        terminationPattern: /PASS|FAIL/i,
        signal,
        onEvent,
      });

      if (signal.aborted) { onEvent({ type: 'done' }); return; }

      const failed = /\bFAIL\b/i.test(validateResult) && !/\bPASS\b/i.test(validateResult);
      if (!failed || round === MAX_REPAIR_ROUNDS) break;

      this.contextManager.addMessage({
        role: 'user',
        content:
          `[VALIDATE FAILED] 検証結果:\n${validateResult.slice(0, 600)}\n\n` +
          `修正が不十分でした。上記のFAIL理由を踏まえて、Repairをやり直してください。` +
          `前回と同じ編集を繰り返さないこと。`,
      });
      onEvent({ type: 'text', content: '\n⚠ Validate FAIL — Repairフェーズに戻ります。\n' });
    }

    // ── Phase 4: Behavior Verify (LLM-generated smoke test) ────────────────
    // Validate only proves the program launches/compiles — interaction bugs
    // need handlers exercised directly.
    if (this.enableVerify && !signal.aborted) {
      const target = BehaviorVerifier.pickTarget(this.editedFiles);
      if (target) {
        const verifier = new BehaviorVerifier(this.client, this.modelRouter, this.toolRegistry, this.workspaceRoot);
        await verifier.run(userMessage, target, onEvent, signal);
      }
    }

    onEvent({ type: 'done' });
  }

  // ── Phase runner ──────────────────────────────────────────────────────────

  private async runPhase(opts: {
    phaseName: string;
    systemPrompt: string;
    allowedTools: ReadonlySet<string>;
    maxIterations: number;
    terminationPattern?: RegExp;
    signal: AbortSignal;
    onEvent: AgentEventHandler;
    /** Explicit think override for this phase. When set, it wins over the
     *  model-based default (needsThinkParam). Validated 2026-06: repair-style
     *  full-file regeneration with thinking enabled can burn the entire
     *  num_predict budget in a self-correction loop and emit zero content. */
    think?: boolean;
    /** Extra Ollama options merged over CODING_SAMPLE_OPTIONS for this phase */
    extraOptions?: Record<string, unknown>;
  }): Promise<string> {
    const { phaseName, systemPrompt, allowedTools, maxIterations, terminationPattern, signal, onEvent } = opts;
    this.contextManager.setSystemPrompt(systemPrompt);

    const phaseTools = this.toolRegistry.toOllamaTools()
      .filter(t => allowedTools.has(t.function.name));

    let lastAssistantContent = '';
    const degDetector = new DegenerationDetector();
    const selfCorrDetector = new SelfCorrectionDetector();
    const fileReadCounts = new Map<string, number>();
    let fileModified = false;
    let forcedEditCount = 0;
    let degenerationRetries = 0;

    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) break;

      // Per-call controller: degeneration only aborts THIS generation, not the whole agent
      const callController = new AbortController();
      const propagateAbort = () => callController.abort();
      signal.addEventListener('abort', propagateAbort, { once: true });

      const messages = this.contextManager.getMessages();
      let accContent = '';
      const accToolCalls: OllamaToolCall[] = [];
      let degenerated = false;
      degDetector.reset();
      selfCorrDetector.reset();

      const onDelta = (delta: OllamaChatDelta) => {
        if (delta.content) {
          accContent += delta.content;
          onEvent({ type: 'text', content: delta.content });
          if (!degenerated && (degDetector.feed(delta.content) || selfCorrDetector.feed(delta.content))) {
            degenerated = true;
            callController.abort();
          }
        }
        if (delta.tool_calls) {
          accToolCalls.push(...delta.tool_calls);
        }
      };

      const hasImages = messages.some(m => m.images?.length);
      const temperature = degenerationRetries > 0 ? 0.55 : CODING_SAMPLE_OPTIONS.temperature;

      // フェーズ内2回目以降の生成(ツール無し継続・縮退/空出力リトライ)は
      // phase_banner でカバーされないため、生成ごとに待機表示を出す(AgentLoop と同様)。
      onEvent({ type: 'thinking', content: 'Waiting for LLM response…' });

      let streamError: unknown = null;
      try {
        const model = this.modelRouter.getModelForImages(hasImages, 'coder');
        await this.client.chatStream(
          {
            model,
            messages,
            tools: phaseTools.length > 0 ? phaseTools : undefined,
            ...(opts.think !== undefined
              ? { think: opts.think }
              : (this.modelRouter.needsThinkParam(model) && { think: true })),
            options: { ...CODING_SAMPLE_OPTIONS, temperature, ...opts.extraOptions },
          },
          onDelta,
          callController.signal
        );
      } catch (err) {
        // Surface real failures — only degeneration/user aborts are expected here
        const name = (err as Error)?.name ?? '';
        if (name !== 'AbortError' && !signal.aborted && !degenerated) {
          streamError = err;
        }
      } finally {
        signal.removeEventListener('abort', propagateAbort);
      }

      if (signal.aborted) break;

      if (streamError) {
        onEvent({ type: 'error', content: `[${phaseName}] LLM request failed: ${String(streamError)}` });
        return lastAssistantContent;
      }

      if (degenerated) {
        degenerationRetries++;
        if (degenerationRetries > MAX_DEGEN_RETRIES) {
          onEvent({ type: 'error', content: `[${phaseName}] 縮退リトライ上限(${MAX_DEGEN_RETRIES})に達しました。エージェントを停止します。` });
          return lastAssistantContent;
        }
        this.contextManager.truncateLastToolMessage(400);
        this.contextManager.addMessage({
          role: 'user',
          content: buildRecoveryMessage(accContent, degenerationRetries, MAX_DEGEN_RETRIES),
        });
        onEvent({ type: 'text', content: `\n⚠ 縮退を検知しました（リトライ ${degenerationRetries}/${MAX_DEGEN_RETRIES}）\n\n` });
        continue;
      }

      degenerationRetries = 0;

      const cleanContent = stripThink(accContent).trim();
      lastAssistantContent = cleanContent;

      this.contextManager.addMessage({
        role: 'assistant',
        content: cleanContent,
        tool_calls: accToolCalls.length > 0 ? accToolCalls : undefined,
      });

      // Termination check — with REPAIR enforcement
      let shouldTerminate = terminationPattern?.test(cleanContent) ?? false;

      if (shouldTerminate && phaseName === 'REPAIR' && !fileModified && forcedEditCount < MAX_FORCED_EDIT) {
        forcedEditCount++;
        this.contextManager.addMessage({
          role: 'user',
          content:
            `[REQUIRED] ファイルが1つも修正されていません。edit_file または replace_lines で実際にコードを変更してください。\n\n` +
            `特定した箇所に明らかな問題がない場合は、以下を確認してください：\n` +
            `- 親ウィジェット・子ウィジェットがイベントをインターセプトしていないか\n` +
            `- setAcceptDrops(True) が正しいウィジェットに設定されているか\n` +
            `- イベントハンドラが正しいクラスに実装されているか\n\n` +
            `get_file_outline や grep_search でクラス構造全体を確認してください。`,
        });
        onEvent({ type: 'text', content: '\n⚠ ファイルが未修正です。修正を適用してください。\n\n' });
        shouldTerminate = false;
      }

      if (shouldTerminate) break;
      if (accToolCalls.length === 0) break;

      // Execute tools (enforce whitelist + loop detection)
      const callData = parseToolCalls(accToolCalls);

      for (const { call, parsedArgs, id } of callData) {
        if (signal.aborted) break;

        onEvent({ type: 'tool_call', toolName: call.function.name, toolArgs: parsedArgs, toolCallId: id });

        let result: { success: boolean; output: string };

        if (!allowedTools.has(call.function.name)) {
          result = {
            success: false,
            output:
              `Tool "${call.function.name}" is not available in ${phaseName} phase. ` +
              `Allowed tools: ${[...allowedTools].join(', ')}. ` +
              `Stay focused on the ${phaseName} phase goal.`,
          };
        } else if (call.function.name === 'read_file') {
          // File-path-level loop detection (same file, regardless of line range)
          const filePath = typeof parsedArgs['path'] === 'string' ? parsedArgs['path'] : '';
          const count = (fileReadCounts.get(filePath) ?? 0) + 1;
          fileReadCounts.set(filePath, count);

          if (count > FILE_READ_THRESHOLD) {
            result = {
              success: false,
              output:
                `[READ LOOP] "${filePath}" を既に ${count - 1} 回読んでいます。` +
                `内容はコンテキスト内に存在します。同じファイルを再読しないでください。\n` +
                `edit_file または replace_lines で修正を適用してください。` +
                `修正箇所が不明な場合は get_file_outline でクラス構造全体を確認してください。`,
            };
          } else {
            result = await this.toolRegistry.execute(call.function.name, parsedArgs, this.workspaceRoot, signal);
          }
        } else {
          if (WRITE_TOOLS.has(call.function.name)) {
            fileModified = true;
            const p = parsedArgs['path'];
            if (typeof p === 'string') {
              this.editedFiles.add(p);
              // Edited content invalidates read history — allow re-reads
              invalidateReadCounts(fileReadCounts, p);
            }
          }
          result = await this.toolRegistry.execute(call.function.name, parsedArgs, this.workspaceRoot, signal);
        }

        onEvent({ type: 'tool_result', content: result.output, success: result.success, toolCallId: id });
        this.contextManager.addMessage({
          role: 'tool',
          content: compressToolResult(result.output, call.function.name),
          tool_call_id: id,
        });
      }
    }

    return lastAssistantContent;
  }

  // ── System prompts ────────────────────────────────────────────────────────

  private buildLocalizePrompt(): string {
    return `Always respond in ${this.outputLanguage}.
Reason briefly (1-2 sentences maximum) before each action. Do not write long explanations.

# PHASE: LOCALIZE

Your ONLY goal is to find WHERE the bug is. Do NOT fix anything yet.

## Strict workflow

**Step 1 — Hypotheses** (do this FIRST, before any tool call):
List 2-3 hypotheses about what could cause the reported bug.
For each hypothesis, name the framework subsystem to check.
IMPORTANT: Do not assume the bug is in the most obvious handler.
Also consider:
- A PARENT widget intercepting/consuming the event before it reaches the target widget
- A SIBLING widget with setAcceptDrops(True) stealing drag events
- An event handler registered on the wrong class

**Step 2 — Structural search** (grep_search + get_file_outline ONLY):
- Use get_file_outline to see class/method names and line numbers without reading full files.
- Use grep_search to find relevant patterns across files (e.g. "setAcceptDrops", "dragEnterEvent").
- Do NOT call read_file. You do not need full file contents to locate a bug.

**Step 3 — Output** when you have enough evidence:
\`\`\`
LOCALIZED:
- file: <relative path>
- class: <class name>
- method: <method name(s)>  ← REQUIRED: this is the primary target for Repair
- hypothesis: <one-line explanation of the bug mechanism>
- lines: <optional — omit if uncertain; wrong line numbers hurt more than they help>
- also_check: <any parent/sibling class whose event handling may interfere>
\`\`\`

Prioritize naming the **function** correctly over guessing line numbers.
Function-level targeting (method name) gives Repair phase everything it needs to do a targeted read.

## Rules
- Maximum 10 tool calls. Be decisive.
- If after 4 tool calls you have a strong hypothesis, output LOCALIZED: immediately.
- Do NOT read full files. Do NOT attempt fixes.`;
  }

  private buildRepairPrompt(localizeResult: string): string {
    return `Always respond in ${this.outputLanguage}.
Reason briefly (1-2 sentences maximum) before each action. Do not write long explanations.

# PHASE: REPAIR

Localization result from Phase 1:
${localizeResult}

## Strict workflow

**Step 1 — Read the identified location** (max 2 targeted reads):
Use read_file with start_line and end_line to read ONLY the suspicious method(s).
If the "also_check" field names another class, read that too.
Do NOT read the entire file.

**Step 2 — Generate and apply fix**:
Apply the minimal fix using edit_file or replace_lines.
You MUST call edit_file or replace_lines — simply reading the file is not enough.

If the identified method looks correct:
- Check the "also_check" class using get_file_outline or grep_search
- Look for setAcceptDrops, eventFilter, or installEventFilter patterns
- Apply the fix to the actual root cause (may be a different class than originally identified)

**Step 3 — Confirm**:
After applying the fix, output:
\`\`\`
REPAIRED:
- file: <path>
- change: <one-line description of what was changed and why>
\`\`\`

## Rules
- Read at most 2 targeted sections before applying the fix.
- You MUST apply an edit before outputting REPAIRED:
- Minimal changes only — do not refactor unrelated code.
- Do NOT run tests (that is Phase 3).`;
  }

  private buildValidatePrompt(): string {
    return `Always respond in ${this.outputLanguage}.
Act immediately — one run_terminal call, then report PASS or FAIL. No explanation needed.

# PHASE: VALIDATE

A fix has been applied. Your ONLY goal is to verify it works.
You have access ONLY to run_terminal. Do NOT call read_file or any other tool.

## Strict workflow

**Step 1 — Run tests or build**:
Execute the relevant test or build command for this project using run_terminal.
Use simple commands — avoid commands that produce XML/CLIXML output (e.g. no PowerShell Get-* cmdlets).

Examples:
- Python: python -c "import module_name"  or  python -m pytest tests/ -x -q
- Node.js: node -e "require('./path')"  or  npm test
- Go: go build ./...  or  go test ./...

**Step 2 — Report result**:
Output one of:
- \`PASS: <reason>\`
- \`FAIL: <reason>\` (include the relevant error line)

## Rules
- Do NOT modify any files.
- Do NOT call read_file — only run_terminal is available in this phase.
- One terminal command is enough — do not retry with variations.
- If no test exists, report: PASS (no tests available — manual verification required).`;
  }
}
