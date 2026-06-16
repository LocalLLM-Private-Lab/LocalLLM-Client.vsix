import type { ModelConfig, OllamaConfig, TaskType } from '../config/schema';

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

  /** スロットが空なら general（基準モデル）にフォールバックして解決する。 */
  private resolve(slot: keyof ModelConfig): string {
    return this.config.models[slot] || this.config.models.general;
  }

  /** 基準モデル。ヘッダーのモデル選択が切り替える対象。 */
  getGeneralModel(): string {
    return this.config.models.general;
  }

  getModel(task: TaskType): string {
    return this.resolve(task);
  }

  getChatModel(): string {
    return this.resolve('chat');
  }

  /** コード編集・エージェント実行用モデル。未設定なら general にフォールバック。 */
  getCoderModel(): string {
    return this.resolve('coder');
  }

  /** Configured per-generation token budget (tokens.maxTokens) */
  getMaxTokens(): number {
    return this.config.tokens.maxTokens;
  }

  /** ヘッダーのドロップダウン用。基準モデルをインメモリで切り替える。 */
  setGeneralModel(model: string): void {
    this.config.models.general = model;
  }

  /**
   * Returns the model for the given role, with vision taking priority when
   * images are present. Each slot falls back to the general model when unset.
   */
  getModelForImages(hasImages: boolean, role: 'chat' | 'coder' = 'chat'): string {
    if (hasImages) {
      return this.resolve('vision');
    }
    return this.resolve(role);
  }

  /**
   * Returns true when the given model (defaults to the general model) needs
   * `think: true` sent as a top-level Ollama request parameter to enable
   * reasoning tokens. Pass the actually-resolved model so each generation is
   * evaluated against the model it will actually use.
   */
  needsThinkParam(model?: string): boolean {
    const name = model ?? this.getGeneralModel();
    return THINK_PARAM_PATTERNS.some(re => re.test(name));
  }
}
