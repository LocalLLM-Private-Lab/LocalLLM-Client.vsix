import * as fs from 'fs/promises';
import * as path from 'path';
import type { OllamaClient, OllamaChatDelta } from '../llm/OllamaClient';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import type { AgentEventHandler } from './AgentLoop';
import { stripThink } from './agentUtils';

/**
 * LLM-driven behavior verification phase.
 *
 * "App launches successfully" cannot detect interaction bugs (observed
 * repeatedly: a drag&drop bug survived four agent sessions because every
 * Validate phase stopped at a successful launch). This phase has the LLM
 * itself write a smoke test that calls event handlers DIRECTLY with fake
 * event objects, runs it, and on failure performs scoped full-file repair.
 *
 * The whole procedure was validated experimentally (2026-06-10,
 * image_viewer attempt4): test generated in one shot with no hand-written
 * harness, two launch-invisible bugs both detected, both fixed via scoped
 * repair with zero regressions.
 */

const MAX_REPAIR_ITERATIONS = 2;
const MAX_SOURCE_CHARS = 12_000;

export interface VerifyResult {
  passed: boolean;
  /** Human/LLM-readable summary; on failure contains the last test output. */
  report: string;
}

function extractPythonCode(text: string): string | null {
  const m = text.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  if (m) return m[1];
  const trimmed = text.trim();
  if (/^(import|from|#|"""|def|class)\b/m.test(trimmed.slice(0, 200))) return trimmed;
  return null;
}

export class BehaviorVerifier {
  constructor(
    private client: OllamaClient,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private workspaceRoot: string
  ) {}

  /** Picks the first verifiable target among edited files (Python only for now). */
  static pickTarget(editedFiles: Iterable<string>): string | null {
    for (const f of editedFiles) {
      const base = path.basename(f);
      if (/\.py$/i.test(f) && !/^test_/i.test(base)) return f;
    }
    return null;
  }

  async run(
    taskDescription: string,
    targetRelPath: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal
  ): Promise<VerifyResult> {
    const absTarget = path.resolve(this.workspaceRoot, targetRelPath);
    let source: string;
    try {
      source = await fs.readFile(absTarget, 'utf8');
    } catch {
      return { passed: true, report: `Verify skipped: cannot read ${targetRelPath}` };
    }
    if (source.length > MAX_SOURCE_CHARS) {
      source = source.slice(0, MAX_SOURCE_CHARS) + '\n# …(truncated for verification)';
    }

    const moduleName = path.basename(targetRelPath, path.extname(targetRelPath));
    const dirRel = path.dirname(targetRelPath);
    const testRelPath = (dirRel === '.' ? '' : dirRel.replace(/\\/g, '/') + '/') + `test_llm_verify_${moduleName}.py`;

    onEvent({
      type: 'phase_banner',
      content: `**[Verify]** LLM生成スモークテストで振る舞いを検証 — ${targetRelPath}`,
    });

    // ── 1. Generate the smoke test ─────────────────────────────────────────
    onEvent({ type: 'text', content: '検証テストを生成しています…\n\n' });
    let testCode: string | null = null;
    for (let genAttempt = 1; genAttempt <= 2 && !signal.aborted; genAttempt++) {
      const genOut = await this.generate(
        this.buildTestGenSystemPrompt(),
        this.buildTestGenUserPrompt(taskDescription, targetRelPath, source, testRelPath),
        onEvent,
        signal
      );
      testCode = extractPythonCode(genOut);
      if (!testCode) continue;

      const writeRes = await this.toolRegistry.execute(
        'write_file',
        { path: testRelPath, content: testCode },
        this.workspaceRoot,
        signal
      );
      if (writeRes.success) break;
      // write_file runs py_compile — a syntactically broken test gets one regen
      onEvent({ type: 'text', content: `\n⚠ 生成テストに問題: ${writeRes.output.slice(0, 300)} — 再生成します\n` });
      testCode = null;
    }
    if (signal.aborted) return { passed: false, report: 'Verify aborted' };
    if (!testCode) {
      return { passed: true, report: 'Verify skipped: test generation failed twice (no valid Python code block)' };
    }

    // ── 2. Run → scoped repair loop ────────────────────────────────────────
    for (let iter = 0; iter <= MAX_REPAIR_ITERATIONS; iter++) {
      if (signal.aborted) return { passed: false, report: 'Verify aborted' };

      onEvent({ type: 'text', content: `\n▶ テスト実行: python ${testRelPath}\n` });
      const runRes = await this.toolRegistry.execute(
        'run_terminal',
        { command: `python "${testRelPath}"`, timeout_seconds: 120 },
        this.workspaceRoot,
        signal
      );
      if (signal.aborted) return { passed: false, report: 'Verify aborted' };

      if (runRes.success) {
        onEvent({
          type: 'text',
          content:
            `\n✅ Verify PASSED\n${runRes.output.slice(-300)}\n` +
            `（検証テスト ${testRelPath} は残してあります。不要なら削除してください）\n`,
        });
        return { passed: true, report: `Behavior verification passed (${testRelPath})` };
      }

      const failureOutput = runRes.output.slice(-1200);

      if (iter === MAX_REPAIR_ITERATIONS) {
        onEvent({
          type: 'text',
          content: `\n❌ Verify FAILED — scoped repair ${MAX_REPAIR_ITERATIONS}回試行後も失敗:\n${failureOutput.slice(-500)}\n`,
        });
        return {
          passed: false,
          report:
            `[VERIFY FAILED] The LLM-generated behavior test still fails after ${MAX_REPAIR_ITERATIONS} scoped repairs.\n` +
            `Test: ${testRelPath}\nLast failure output:\n${failureOutput}`,
        };
      }

      // Scoped repair: failure output + full current source, ONE function may change
      onEvent({
        type: 'text',
        content: `\n⚠ テスト失敗 — scoped repair (${iter + 1}/${MAX_REPAIR_ITERATIONS}) を実行します:\n${failureOutput.slice(-400)}\n\n`,
      });

      const currentSource = await fs.readFile(absTarget, 'utf8').catch(() => source);
      const repairOut = await this.generate(
        this.buildRepairSystemPrompt(),
        this.buildRepairUserPrompt(taskDescription, targetRelPath, failureOutput, currentSource),
        onEvent,
        signal
      );
      if (signal.aborted) return { passed: false, report: 'Verify aborted' };

      const fixedCode = extractPythonCode(repairOut);
      if (!fixedCode) {
        return { passed: false, report: '[VERIFY FAILED] scoped repair produced no code block' };
      }
      const writeRes = await this.toolRegistry.execute(
        'write_file',
        { path: targetRelPath, content: fixedCode },
        this.workspaceRoot,
        signal
      );
      if (!writeRes.success) {
        return { passed: false, report: `[VERIFY FAILED] scoped repair write failed: ${writeRes.output.slice(0, 400)}` };
      }
    }

    return { passed: false, report: '[VERIFY FAILED] unexpected exit' };
  }

  // ── LLM call helper ────────────────────────────────────────────────────────

  private async generate(
    system: string,
    user: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal
  ): Promise<string> {
    let full = '';
    const onDelta = (d: OllamaChatDelta) => {
      if (d.content) {
        full += d.content;
        onEvent({ type: 'text', content: d.content });
      }
    };
    try {
      await this.client.chatStream(
        {
          model: this.modelRouter.getChatModel(),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // Validated: code generation/repair must run with thinking disabled
          think: false,
          options: {
            temperature: 0.2,
            num_predict: Math.round(this.modelRouter.getMaxTokens() * 1.5),
          },
        },
        onDelta,
        signal
      );
    } catch {
      // aborted or network error — return what we have
    }
    return stripThink(full);
  }

  // ── Prompts (validated structure from the attempt4 experiment) ────────────

  private buildTestGenSystemPrompt(): string {
    return [
      'You are a Python test engineer. Write ONE self-contained smoke test file.',
      'Rules:',
      '- Add the target module directory to sys.path before importing it.',
      '- NEVER start a GUI event loop: do not call app.exec(), exec_(), or mainloop().',
      '  For PyQt/PySide create QApplication([]) once at the top; for tkinter use root.withdraw().',
      '- Simulate user interactions by CALLING EVENT HANDLERS DIRECTLY with fake event objects',
      '  (define small FakeEvent / fake mimeData classes as needed).',
      '- Assert observable state changes after each call.',
      '- The PRIMARY assertion must verify the END-USER-VISIBLE behavior from the bug report',
      '  END-TO-END (e.g. "after dropEvent, the image is displayed in the SAME widget the user',
      '  zooms/pans"). Passing isolated sub-checks while the integrated behavior is broken is a',
      '  test design failure.',
      '- On the first failure print "FAILED: <details>" and sys.exit(1).',
      '  If everything passes print "ALL TESTS PASSED" and sys.exit(0).',
      '- Do NOT modify, monkey-patch, or work around the target module\'s logic —',
      '  verify its behavior AS IS. If the module has a bug, the test MUST fail.',
      '- Output ONLY the complete test file in a single ```python code block. No explanations.',
    ].join('\n');
  }

  private buildTestGenUserPrompt(
    taskDescription: string,
    targetRelPath: string,
    source: string,
    testRelPath: string
  ): string {
    return (
      `# Reported bug / task\n${taskDescription}\n\n` +
      `# Target module: ${targetRelPath}\n\`\`\`python\n${source}\n\`\`\`\n\n` +
      `Write the test file "${testRelPath}". Focus on the behavior related to the reported bug ` +
      `(e.g. for a drag&drop bug: call dragEnterEvent/dropEvent directly with a fake event carrying a fake file URL ` +
      `and assert the image/state is actually loaded), plus 1-2 adjacent handler checks. ` +
      `The test is executed as: python ${testRelPath} (cwd = workspace root).`
    );
  }

  private buildRepairSystemPrompt(): string {
    return [
      'You are fixing a behavioral bug demonstrated by a failing smoke test.',
      'Rules:',
      '- From the failure output, decide which SINGLE function/method in the target module is responsible.',
      '- Output the COMPLETE corrected target module in one ```python code block.',
      '- Change ONLY that single function/method; keep every other line byte-identical.',
      '- Do NOT modify the test, and do NOT add workarounds that merely silence the test.',
      '- No explanations outside the code block.',
    ].join('\n');
  }

  private buildRepairUserPrompt(
    taskDescription: string,
    targetRelPath: string,
    failureOutput: string,
    currentSource: string
  ): string {
    return (
      `# Reported bug / task\n${taskDescription}\n\n` +
      `# Failing test output\n\`\`\`\n${failureOutput}\n\`\`\`\n\n` +
      `# Current source of ${targetRelPath}\n\`\`\`python\n${currentSource}\n\`\`\`\n\n` +
      `Output the full corrected ${targetRelPath}.`
    );
  }
}
