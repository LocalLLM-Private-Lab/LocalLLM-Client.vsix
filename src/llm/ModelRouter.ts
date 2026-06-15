import type { OllamaConfig, TaskType } from '../config/schema';

/**
 * Models that require an explicit top-level `think: true` in the Ollama request
 * to activate chain-of-thought / reasoning tokens.
 *
 * Do NOT include models whose thinking is always-on or handled via the separate
 * `thinking` response field (e.g. Gemma4, DeepSeek-R1) — those work without the flag.
 */
const THINK_PARAM_PATTERNS = [
  /qwen3/i,   // Qwen3 family (qwen3:30b-a3b-instruct-*, etc.)
  /qwq/i,     // QwQ reasoning model
];

/** タスクの種類に応じて適切なモデル名を返す */
export class ModelRouter {
  constructor(private config: OllamaConfig) {}

  applyConfig(config: OllamaConfig): void {
    this.config = config;
  }

  getModel(task: TaskType): string {
    return this.config.models[task];
  }

  getChatModel(): string {
    return this.config.models.chat;
  }

  /** コード編集・エージェント実行用モデル。未設定なら chat にフォールバック。 */
  getCoderModel(): string {
    return this.config.models.coder || this.config.models.chat;
  }

  /** Configured per-generation token budget (tokens.maxTokens) */
  getMaxTokens(): number {
    return this.config.tokens.maxTokens;
  }

  setChatModel(model: string): void {
    this.config.models.chat = model;
  }

  /**
   * Returns the model for the given role, with vision taking priority when
   * images are present. role='coder' resolves to the coder model (falling back
   * to chat when unset); role='chat' (default) resolves to the chat model.
   */
  getModelForImages(hasImages: boolean, role: 'chat' | 'coder' = 'chat'): string {
    if (hasImages && this.config.models.vision) {
      return this.config.models.vision;
    }
    if (role === 'coder' && this.config.models.coder) {
      return this.config.models.coder;
    }
    return this.config.models.chat;
  }

  /**
   * Returns true when the given model (defaults to the chat model) needs
   * `think: true` sent as a top-level Ollama request parameter to enable
   * reasoning tokens. Pass the actually-resolved model so coder generations
   * are evaluated against the coder model rather than chat.
   */
  needsThinkParam(model?: string): boolean {
    const name = model ?? this.getChatModel();
    return THINK_PARAM_PATTERNS.some(re => re.test(name));
  }
}
