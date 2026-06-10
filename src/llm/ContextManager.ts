import type { OllamaClient } from './OllamaClient';
import type { OllamaMessage } from './OllamaClient';
import type { OllamaConfig } from '../config/schema';

const COMPACTION_THRESHOLD = 0.85; // コンテキスト使用率がこれを超えたら圧縮

/**
 * 会話履歴を管理し、コンテキストウィンドウが溢れそうになったら
 * compaction モデルで過去の会話を要約・圧縮する。
 */
export class ContextManager {
  private messages: OllamaMessage[] = [];
  private systemPrompt: string | null = null;

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
  async compactIfNeeded(signal?: AbortSignal): Promise<boolean> {
    const estimated = this.estimateTokens();
    const threshold = this.config.tokens.contextWindow * COMPACTION_THRESHOLD;
    if (estimated < threshold) return false;
    return this.compact(signal);
  }

  async compact(signal?: AbortSignal): Promise<boolean> {
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

    const summaryText = await this.summarize(toSummarize, signal);
    this.messages = [
      { role: 'system', content: `[Previous conversation summary]\n${summaryText}` },
      ...toKeep,
    ];
    return true;
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
