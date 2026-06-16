import type { OllamaClient } from './OllamaClient';
import type { OllamaMessage } from './OllamaClient';
import type { OllamaConfig } from '../config/schema';
import { FILE_EDIT_TOOLS } from '../agent/ToolRegistry';

const COMPACTION_THRESHOLD = 0.85; // コンテキスト使用率がこれを超えたら圧縮

const ERRORISH_RE = /error|fail(?:ed|ure)?|exception|traceback|構文エラー|失敗/i;

/**
 * 会話履歴を管理し、コンテキストウィンドウが溢れそうになったら
 * compaction モデルで過去の会話を要約・圧縮する。
 */
export class ContextManager {
  private messages: OllamaMessage[] = [];
  private systemPrompt: string | null = null;

  // ── コンパクション耐性のセッション状態 ──────────────────────
  // LLM要約は「何を編集したか」「元のタスク」のような構造的事実を落とす
  // ことがある(要約モデル自身もローカルの小型モデルのため)。圧縮を跨いで
  // 保持すべき事実は機械的に抽出し、要約とは別に決定論的なブロックとして
  // 再注入する。
  private originalTask: string | null = null;
  private editedFiles = new Set<string>();

  constructor(
    private config: OllamaConfig,
    private client: OllamaClient
  ) {}

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  addMessage(message: OllamaMessage): void {
    this.messages.push(message);
  }

  /** エージェントに渡すメッセージ列を返す（system prompt + 会話履歴） */
  getMessages(): OllamaMessage[] {
    const result: OllamaMessage[] = [];
    if (this.systemPrompt) {
      result.push({ role: 'system', content: this.systemPrompt });
    }
    return result.concat(this.messages);
  }

  clear(): void {
    this.messages = [];
    this.originalTask = null;
    this.editedFiles.clear();
  }

  exportMessages(): OllamaMessage[] {
    return [...this.messages];
  }

  importMessages(messages: OllamaMessage[]): void {
    this.messages = [...messages];
  }

  applyConfig(config: OllamaConfig): void {
    this.config = config;
  }

  /**
   * 推定トークン数がコンテキストウィンドウの閾値を超えていたら
   * 古い会話を compaction モデルで要約して履歴を圧縮する。
   */
  async compactIfNeeded(signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<boolean> {
    const estimated = this.estimateTokens();
    const threshold = this.config.tokens.contextWindow * COMPACTION_THRESHOLD;
    if (estimated < threshold) return false;
    return this.compact(signal, onProgress);
  }

  async compact(signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<boolean> {
    const keepCount = 6;
    let splitIdx = Math.max(0, this.messages.length - keepCount);
    // Never let the kept slice start with a tool response — that would orphan it
    // from its assistant(tool_calls) message and produce an invalid sequence.
    while (splitIdx < this.messages.length && this.messages[splitIdx].role === 'tool') {
      splitIdx++;
    }
    const toSummarize = this.messages.slice(0, splitIdx);
    const toKeep = this.messages.slice(splitIdx);

    if (toSummarize.length === 0) return false;

    this.harvestSessionState(toSummarize);
    // 要約LLM呼び出しはSSH経由だと数秒〜数十秒かかり、その間UIが無反応に見える。
    // 呼び出し側(agent/手動)に進捗を通知してスピナーを出させる。
    onProgress?.('会話履歴を圧縮中…');
    const summaryText = await this.summarize(toSummarize, signal);
    this.messages = [
      {
        role: 'system',
        content: `[Previous conversation summary]\n${summaryText}${this.buildSessionStateBlock(toSummarize)}`,
      },
      ...toKeep,
    ];
    return true;
  }

  /** 圧縮で消える領域から、要約に任せられない構造的事実を機械抽出する。
   *  editedFiles はインスタンスに蓄積されるため2回目以降の圧縮でも失われない。 */
  private harvestSessionState(dropped: OllamaMessage[]): void {
    if (this.originalTask === null) {
      const firstUser = dropped.find(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim() !== ''
      );
      if (firstUser) this.originalTask = firstUser.content.slice(0, 400);
    }
    for (const m of dropped) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const tc of m.tool_calls) {
        if (!FILE_EDIT_TOOLS.has(tc.function?.name ?? '')) continue;
        let args: unknown = tc.function.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { continue; }
        }
        const p = (args as Record<string, unknown> | null)?.['path'];
        if (typeof p === 'string') this.editedFiles.add(p);
      }
    }
  }

  /** 要約の後ろに付ける決定論的なセッション状態ブロック。
   *  直近エラーだけは「今回消える領域」から取る(古いエラーは解決済みの可能性が高い)。 */
  private buildSessionStateBlock(dropped: OllamaMessage[]): string {
    const lines: string[] = [];
    if (this.originalTask) lines.push(`Original task (verbatim head): ${this.originalTask}`);
    if (this.editedFiles.size > 0) {
      lines.push(`Files edited so far: ${[...this.editedFiles].join(', ')}`);
    }
    const errors = dropped
      .filter((m) => m.role === 'tool' && typeof m.content === 'string' && ERRORISH_RE.test(m.content))
      .slice(-2)
      .map((m) => `- ${m.content.replace(/\s+/g, ' ').slice(0, 240)}`);
    if (errors.length > 0) {
      lines.push('Recent tool errors (may already be resolved — verify before acting):', ...errors);
    }
    if (lines.length === 0) return '';
    return (
      '\n\n[Session state — extracted mechanically from the compacted history; ' +
      'more reliable than the summary above]\n' + lines.join('\n')
    );
  }

  private async summarize(
    messages: OllamaMessage[],
    signal?: AbortSignal
  ): Promise<string> {
    const conversationText = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const response = await this.client.chat(
      {
        model: this.config.models.compaction,
        messages: [
          {
            role: 'system',
            content:
              'You are a summarizer. Summarize the following conversation concisely, ' +
              'preserving key decisions, code changes, and important context.',
          },
          { role: 'user', content: conversationText },
        ],
        options: { num_predict: 1024 },
      },
      signal
    );

    return response.message.content;
  }

  /**
   * Truncates the most recent tool message if it exceeds maxLen characters.
   * Called before degeneration retry to remove context pollution from long tool output.
   */
  truncateLastToolMessage(maxLen: number): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'tool') {
        const content = this.messages[i].content;
        if (typeof content === 'string' && content.length > maxLen) {
          this.messages[i] = {
            ...this.messages[i],
            content: content.slice(0, maxLen) + '\n…[truncated — output was too long and caused degeneration]',
          };
        }
        break;
      }
    }
  }

  getTokenInfo(): { used: number; max: number } {
    return {
      used: this.estimateTokens(),
      max: this.config.tokens.contextWindow,
    };
  }

  /** トークン数を1画像あたり一律で見積もる（llava 等の vision モデルの実測目安） */
  private static readonly TOKENS_PER_IMAGE = 800;

  /**
   * 簡易トークン推定（システムプロンプト・tool_calls・画像を含む）。
   * CJK は1文字≒1トークン、それ以外は4文字≒1トークンで近似する。
   * 英文向けの「文字数/4」だけだと日本語で3〜4倍の過小評価になる。
   */
  private estimateTokens(): number {
    let total = ContextManager.countTextTokens(this.systemPrompt ?? '');
    for (const m of this.messages) {
      if (typeof m.content === 'string') total += ContextManager.countTextTokens(m.content);
      if (m.tool_calls) total += ContextManager.countTextTokens(JSON.stringify(m.tool_calls));
      if (m.images) total += m.images.length * ContextManager.TOKENS_PER_IMAGE;
    }
    return total;
  }

  private static countTextTokens(text: string): number {
    const cjk = (text.match(/[\u3000-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/g) ?? []).length;
    return cjk + Math.ceil((text.length - cjk) / 4);
  }
}
