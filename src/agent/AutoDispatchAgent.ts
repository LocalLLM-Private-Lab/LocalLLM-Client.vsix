import type { OllamaClient } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import type { AgentEventHandler } from './AgentLoop';
import { AgentLoop } from './AgentLoop';
import { ChatOnlyAgent } from './ChatOnlyAgent';
import { DebugPhaseAgent } from './DebugPhaseAgent';
import { RepoMapAgent } from './RepoMapAgent';

export type DispatchedMode = 'chat' | 'standard' | 'debug' | 'plan';

/**
 * Classify the user's message with keyword heuristics and dispatch to the
 * most appropriate agent.
 *
 * Priority order (first match wins):
 *   debug    → evidence of broken/unexpected behavior
 *   plan     → clearly large-scope or multi-file work
 *   chat     → pure question/explanation with no code context
 *   standard → everything else (default — safest fallback)
 *
 * Design principle: prefer false negatives over false positives.
 * Routing to standard is always acceptable; routing to the wrong specialist
 * (3-phase debug or plan+approval) when not needed wastes time and confuses.
 *
 * Avoided pitfalls:
 *   "error handling"     → NOT debug  (エラー/error alone is too broad)
 *   "fix indentation"    → NOT debug  (fix/直して alone is too broad)
 *   "fail gracefully"    → NOT debug  (fail alone matches idioms)
 *   "implement this fix" → NOT plan   (implement alone is too broad)
 *   "実装して"           → NOT plan   (実装 alone means any code change)
 */
export function classifyMessage(message: string): DispatchedMode {
  const msg = message.toLowerCase();

  const hasFileExt = /\.(py|ts|tsx|js|jsx|go|rs|java|cs|cpp|c|rb|php|kt|swift|html|css|json|yaml|yml)\b/.test(message);
  const hasCodeBlock = /```/.test(message);
  const hasAtMention = /@\w/.test(message);

  // ── Debug ─────────────────────────────────────────────────────────────────
  // Tier 1: unambiguous standalone signals
  const debugStrong = /\b(bug|crash(?:es|ed|ing)?|exception|traceback|not\s+work(?:ing)?|doesn'?t\s+work|isn'?t\s+work(?:ing)?|stopped?\s+work(?:ing)?|broken|broke[n]?|regression|wrong\s+(?:output|result|behavior|value))\b/;
  // 「〜しても…ない」は失敗系動詞の語幹を必須にする（「変更しても問題ない」に誤マッチさせない）
  const debugStrongJa = /バグ|動かない|動きません|クラッシュ|落ちる|落ちた|おかしい(?:動作|挙動)?|正常に動かない|うまくいかない|壊れ(?:てる|た|ている)|読み込まれない|表示されない|反応しない|効かない|動作しない|(?:しても|やっても|押しても|クリックしても|ドロップしても)[^。\n]{0,30}(?:何も(?:起き|起こら|変わら)?|でき|起き|起こら|動か|反応し|表示され|読み込まれ|呼ばれ|変わら|効か|機能し)(?:ない|ません)/;

  // Tier 2: weaker signals — require contextual pairing to avoid "error handling", "fix formatting"
  // "error" only when it's an occurring/unexpected error (not "error handling", "error message format")
  const debugError = /\b(?:gets?|got|getting|throws?|threw|throwing|shows?|raised?|caused?|occurred?|appearing?|unexpected)\s+(?:an?\s+)?error\b|\berror\s+(?:occurred?|occurs|appears?|shows?|is\s+thrown|message\s+says)\b/i;
  const debugErrorJa = /エラー(?:が出|になる|が発生|が起きる|が起こる|が表示)/;

  // "fix/debug" only when explicitly paired with a defect noun
  const debugFix = /\b(?:fix|debug)(?:ing|ging)?\s+(?:this\s+)?(?:bug|error|issue|problem|crash|regression)\b|\b(?:bug|error|crash|problem)\b.{0,40}\bfix\b/i;
  const debugFixJa = /バグ.*(?:直す|修正)|直す.*バグ|デバッグ|不具合.*(?:直す|修正)/;

  // "fail" only when tests or build fail (not "fail gracefully", "fail fast", "fail-safe")
  const debugFail = /\b(?:test(?:s)?|build|compile|import|startup|connection)\s+(?:is\s+)?fail(?:s|ed|ing)?\b|\bfail(?:s|ed|ing)?\s+(?:with\s+(?:an?\s+)?error|to\s+(?:start|load|compile|run|build|connect))\b/i;
  const debugFailJa = /(?:テスト|ビルド|起動|コンパイル).*失敗|失敗.*(?:テスト|ビルド)/;

  if (
    debugStrong.test(msg) || debugStrongJa.test(msg) ||
    debugError.test(message) || debugErrorJa.test(msg) ||
    debugFix.test(message) || debugFixJa.test(msg) ||
    debugFail.test(message) || debugFailJa.test(msg)
  ) {
    return 'debug';
  }

  // ── Plan: large-scope / multi-file / new subsystem ────────────────────────
  // "implement/add/create" alone is too broad — require a scope qualifier.
  // "refactor/rewrite/redesign/migrate" are inherently scope-indicating.
  const planVerb = /\b(rewrite|redesign|migrate|scaffold|refactor(?:ing)?|build\s+(?:a\s+)?(?:new|full))\b/;
  const planNewSubsystem = /\b(?:add|create|build|implement)\s+(?:a\s+)?(?:new\s+)?(?:full|complete|entire)?\s*(?:feature|module|component|service|api|endpoint|system|pipeline|integration|plugin)\b/;
  const planMultiFile = /\b(?:multiple|several|all|many)\s+files?\b|\bacross\s+the\s+(?:codebase|project|repo(?:sitory)?|entire\s+app)\b|\bmulti.?file\b/i;
  const planVerbJa = /リファクタリング|書き直し|移行|スクラッチ(?:から|で)|全面的(?:に|な)/;
  const planNewSubsystemJa = /新(?:しい|規).*(?:機能|モジュール|コンポーネント|サービス|システム|API).*(?:追加|作成|実装)|(?:機能|サービス|システム)を(?:新たに|新規で)(?:追加|作成|実装)/;
  const planMultiFileJa = /複数.*ファイル|全.*ファイル|コードベース全体/;

  if (
    planVerb.test(msg) || planNewSubsystem.test(msg) || planMultiFile.test(msg) ||
    planVerbJa.test(msg) || planNewSubsystemJa.test(msg) || planMultiFileJa.test(msg)
  ) {
    return 'plan';
  }

  // ── Chat: pure question / explanation with no code context ────────────────
  // Freshness guard: questions needing CURRENT information must go to the
  // tool loop (web_search/fetch_url) — ChatOnlyAgent has NO tools, so routing
  // "明日の天気を教えて" to chat makes a correct answer impossible.
  const needsFreshInfo =
    /天気|気温|ニュース|最新|今日|明日|昨日|現在|今の|株価|為替|相場|リリース|バージョン|アップデート|値段|価格|営業時間|\b(?:weather|news|latest|today|tomorrow|current|price|release|version)\b/i;
  const chatEn = /\b(what\s+is|what'?s|explain|how\s+does|how\s+do\s+i|why\s+(?:does|is|do)|tell\s+me|what\s+(?:are|does)|difference\s+between|when\s+(?:should|do)|can\s+you\s+explain)\b/i;
  const chatJa = /とは|について教えて|の違い|どうやって|なぜ|どういう意味|説明して|教えてください|とはなんですか|とはどういう/;
  if (
    (chatEn.test(message) || chatJa.test(msg)) &&
    !hasFileExt && !hasCodeBlock && !hasAtMention &&
    !needsFreshInfo.test(message)
  ) {
    return 'chat';
  }

  return 'standard';
}

const MODE_LABELS: Record<DispatchedMode, string> = {
  chat:     'Chat',
  standard: 'Agent Loop',
  debug:    'Debug (3-phase)',
  plan:     'Plan',
};

export class AutoDispatchAgent {
  constructor(
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private workspaceRoot: string,
    private outputLanguage: string = 'Japanese',
    private approvalFn?: (planText: string, cycle?: number) => Promise<boolean>,
    private enableVerify = true
  ) {}

  async run(
    userMessage: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal,
    images?: string[]
  ): Promise<void> {
    const mode = classifyMessage(userMessage);
    onEvent({ type: 'text', content: `*[Auto → ${MODE_LABELS[mode]}]*\n\n` });

    switch (mode) {
      case 'chat': {
        const agent = new ChatOnlyAgent(
          this.client, this.contextManager, this.modelRouter, this.outputLanguage
        );
        await agent.run(userMessage, onEvent, signal, images);
        break;
      }

      case 'debug': {
        const agent = new DebugPhaseAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry,
          this.workspaceRoot, this.outputLanguage, this.enableVerify
        );
        await agent.run(userMessage, onEvent, signal, images);
        break;
      }

      case 'plan': {
        const approveFn = this.approvalFn ?? (async () => true);
        const agent = new RepoMapAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry,
          this.workspaceRoot, approveFn, this.outputLanguage, this.enableVerify
        );
        await agent.run(userMessage, onEvent, signal, images);
        break;
      }

      default: {
        const agent = new AgentLoop(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, this.workspaceRoot
        );
        await agent.run(userMessage, onEvent, signal, images);
        break;
      }
    }
  }
}
