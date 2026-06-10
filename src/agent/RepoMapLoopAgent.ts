import type { OllamaClient } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import type { AgentEventHandler } from './AgentLoop';
import {
  buildRepoMap,
  createPlan,
  formatPlan,
  executeSteps,
  MAX_PLAN_RETRIES,
  type ApprovalFn,
} from './RepoMapAgent';
import { BehaviorVerifier } from './BehaviorVerifier';
import { LoopGuardState } from './agentUtils';

const MAX_CYCLES = 5;

/**
 * Repo Map + Plan Loop モード（PDCA サイクル）。
 *
 * 各サイクル:
 *   1. Plan: repo map + タスクから TODO リスト（説明のみ、tool args なし）を生成
 *   2. Approve: ユーザーが計画を承認
 *   3. Do: AgentLoop がファイルを実際に読み、ツールスキーマ通りに実行
 *   4. Check: tool_result のエラーを収集
 *   5. エラーなし → 完了 / エラーあり → 次サイクル（最大 MAX_CYCLES 回）
 */
export class RepoMapLoopAgent {
  constructor(
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private workspaceRoot: string,
    private approvalFn: ApprovalFn,
    private outputLanguage = 'English',
    private enableVerify = true
  ) {}

  async run(
    userMessage: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal,
    images?: string[]
  ): Promise<void> {
    onEvent({ type: 'thinking', content: 'Building repository map...' });
    const repoMap = await buildRepoMap(this.workspaceRoot);
    if (signal.aborted) { onEvent({ type: 'done' }); return; }

    let errorContext = '';
    // Accumulated across cycles: the final clean cycle often contains no
    // edits itself (verification/SKIP only), but the files edited in EARLIER
    // cycles still need behavior verification.
    const allEditedFiles = new Set<string>();
    // One loop guard for ALL cycles: a re-plan cycle must not be allowed to
    // silently re-apply an edit variant that already failed in a previous one.
    const loopGuard = new LoopGuardState();

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      if (signal.aborted) { onEvent({ type: 'done' }); return; }

      // ── Plan ──────────────────────────────────────────────────────────────
      const taskMessage = errorContext
        ? `Original task: ${userMessage}\n\nPrevious attempt failed with these errors:\n${errorContext}\n\nCreate a new plan to fix the errors.`
        : userMessage;

      onEvent({ type: 'thinking', content: `Creating plan (cycle ${cycle})...` });
      const plan = await createPlan(
        this.client, this.modelRouter, repoMap, taskMessage, signal,
        cycle === 1 ? images : undefined, onEvent, this.outputLanguage
      );
      if (signal.aborted) { onEvent({ type: 'done' }); return; }

      if (plan.steps.length === 0) {
        onEvent({ type: 'text', content: `⚠ Could not generate a valid plan after ${MAX_PLAN_RETRIES} attempts (cycle ${cycle}). Please try again.` });
        onEvent({ type: 'done' });
        return;
      }

      const planText = formatPlan(plan);

      // ── Approve ───────────────────────────────────────────────────────────
      // Think block already streamed above; now show approval (time-series order)
      onEvent({ type: 'needs_approval', content: planText, cycle });
      const approved = await this.approvalFn(planText, cycle);
      if (!approved) {
        onEvent({ type: 'text', content: 'Plan cancelled by user.' });
        onEvent({ type: 'done' });
        return;
      }

      // ── Do ────────────────────────────────────────────────────────────────
      onEvent({ type: 'thinking', content: `Executing plan (cycle ${cycle})...` });
      const initialContext = cycle === 1
        ? `Repository structure:\n${repoMap}\n\nTask: ${userMessage}\n\nFull execution plan:\n${planText}`
        : `The previous attempt failed with these errors:\n${errorContext}\n\nNew plan to resolve the errors:\n${planText}`;

      const result = await executeSteps(
        initialContext, plan.steps,
        this.client, this.contextManager, this.modelRouter,
        this.toolRegistry, this.workspaceRoot, onEvent, signal,
        cycle === 1 ? images : undefined, loopGuard
      );
      if (signal.aborted) { onEvent({ type: 'done' }); return; }
      result.editedFiles.forEach(f => allEditedFiles.add(f));

      // ── Check ─────────────────────────────────────────────────────────────
      if (result.errors.length === 0 && !result.planMismatch) {
        // Behavior verification: "no tool errors" still doesn't prove the bug
        // is fixed — run the LLM-generated smoke test. A failure (after the
        // verifier's own scoped repairs) feeds the next PDCA cycle.
        if (this.enableVerify) {
          const target = BehaviorVerifier.pickTarget(allEditedFiles);
          if (target) {
            const verifier = new BehaviorVerifier(this.client, this.modelRouter, this.toolRegistry, this.workspaceRoot);
            const verifyResult = await verifier.run(userMessage, target, onEvent, signal);
            if (signal.aborted) { onEvent({ type: 'done' }); return; }
            if (!verifyResult.passed) {
              errorContext = verifyResult.report;
              if (cycle < MAX_CYCLES) {
                onEvent({ type: 'text', content: '⚠ 振る舞い検証が失敗 — 失敗内容に基づいて再プランします…' });
              }
              continue;
            }
          }
        }
        onEvent({ type: 'done' });
        return;
      }

      // Plan-premise mismatch: the agent's finding is the most valuable
      // re-planning input — lead with it instead of raw tool errors.
      if (result.planMismatch) {
        errorContext =
          `[PLAN MISMATCH — the executing agent investigated and found the plan's premise was WRONG]\n` +
          `${result.planMismatch}` +
          (result.errors.length > 0 ? `\n\nOther errors:\n${result.errors.join('\n')}` : '');
        if (cycle < MAX_CYCLES) {
          onEvent({ type: 'text', content: '⚠ プランの前提齟齬を検知 — 発見に基づいて再プランします…' });
        }
      } else {
        errorContext = result.errors.join('\n');
        if (cycle < MAX_CYCLES) {
          onEvent({ type: 'text', content: `⚠ ${result.errors.length} error(s) detected. Re-planning...` });
        }
      }
    }

    onEvent({ type: 'error', content: `Max cycles (${MAX_CYCLES}) reached with unresolved errors.` });
  }
}
