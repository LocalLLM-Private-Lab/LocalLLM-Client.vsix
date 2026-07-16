import type { ConnectionManager } from './ConnectionManager';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_call_id?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaToolCall {
  id: string;
  type: 'function';
  // Ollama may return arguments as a JSON string OR as an already-parsed object
  function: { name: string; arguments: string | Record<string, unknown> };
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream?: boolean;
  /** Top-level thinking flag — required by Qwen3 (NOT inside options) */
  think?: boolean;
  options?: {
    num_predict?: number;
    num_ctx?: number;
    temperature?: number;
    repeat_penalty?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    [key: string]: unknown;
  };
}

export interface OllamaChatDelta {
  role?: string;
  content?: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaChatChunk {
  model: string;
  message: OllamaChatDelta;
  done: boolean;
}

export interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
}

export interface ListModelsResponse {
  models: Array<{ name: string; modified_at: string; size: number }>;
}

/** Combines the caller's AbortSignal with a hard timeout so requests never hang.
 *  Implemented manually: AbortSignal.any() requires Node 20.3+, but VSCode
 *  1.85–1.89 ships Node 18 — using it there throws a TypeError on every
 *  request (observed on another machine as silent empty responses). */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${ms}ms`, 'TimeoutError')),
    ms
  );
  (timer as { unref?: () => void }).unref?.();

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          controller.abort(signal.reason);
        },
        { once: true }
      );
    }
  }
  return controller.signal;
}

const STREAM_TIMEOUT_MS  = 10 * 60 * 1000; // 10 min — large models can be slow
const REQUEST_TIMEOUT_MS =  2 * 60 * 1000; // 2 min  — non-streaming (compaction etc.)

/** Appends an actionable hint for known server-error patterns. */
function apiErrorHint(status: number, errText: string): string {
  if (status === 500 && /memory|cuda|vram|unable to load|alloc/i.test(errText)) {
    return (
      '\nHINT: モデルのロードに必要なメモリが不足している可能性があります。' +
      '設定 localLlm.tokens.contextWindow を下げる（例: 8192）か、より小さいモデルを試してください。'
    );
  }
  if (status === 404) {
    return '\nHINT: モデルが見つかりません。このPCで `ollama pull <model>` を実行してください。';
  }
  return '';
}

export class OllamaClient {
  /** Models confirmed to not support think:true — avoids repeated 400 errors */
  private readonly noThinkModels = new Set<string>();

  /** Defaults merged into every request (num_ctx / num_predict from user config).
   *  Without an explicit num_ctx Ollama falls back to the model default (often
   *  2048–4096) and silently truncates the context. */
  private defaultOptions: { num_ctx?: number; num_predict?: number } = {};

  constructor(private readonly connectionManager: ConnectionManager) {}

  setDefaultOptions(options: { num_ctx?: number; num_predict?: number }): void {
    this.defaultOptions = { ...options };
  }

  /** Caller options win, except num_ctx which always follows user config. */
  private mergeOptions(options?: OllamaChatRequest['options']): OllamaChatRequest['options'] {
    return { ...this.defaultOptions, ...options, num_ctx: this.defaultOptions.num_ctx ?? options?.num_ctx };
  }

  /**
   * ストリーミングチャットリクエストを送信する。
   * delta コールバックで逐次テキストを受け取り、完了時に完全なレスポンスを返す。
   * signal で中断可能。
   * think:true を送って 400 "does not support thinking" が返った場合は
   * 自動でフラグを外してリトライし、以降そのモデルではフラグを送らない。
   */
  async chatStream(
    request: OllamaChatRequest,
    onDelta: (delta: OllamaChatDelta) => void,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    const baseUrl = await this.connectionManager.getBaseUrl();
    const url = `${baseUrl}/api/chat`;

    // Strip think flag for models already known not to support it
    const req: OllamaChatRequest = {
      ...request,
      ...(request.think !== undefined && this.noThinkModels.has(request.model) && { think: undefined }),
      options: this.mergeOptions(request.options),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, stream: true }),
      signal: withTimeout(signal, STREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Auto-retry without think when the model doesn't support it
      if (response.status === 400 && req.think !== undefined && /does not support thinking/i.test(errText)) {
        this.noThinkModels.add(request.model);
        return this.chatStream({ ...request, think: undefined }, onDelta, signal);
      }
      throw new Error(`Ollama API error: ${response.status} ${errText}${apiErrorHint(response.status, errText)}`);
    }

    if (!response.body) {
      throw new Error('No response body from Ollama');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let responseModel: string | undefined;
    // Ollama は生成完了時に done:true のチャンクを必ず最後に送る。これを受信しないまま
    // ボディが終わった場合は接続が途中で切れた(SSHトンネル断など) → 切り捨てを検知する。
    let sawDone = false;
    const allToolCalls: OllamaToolCall[] = [];
    // Track whether we are currently inside an Ollama thinking block so we can
    // emit proper <think>…</think> wrappers for the UI state machine.
    let inThinking = false;

    // NDJSON line buffer — a JSON object can be split across network chunks,
    // so we only parse complete lines and carry the remainder to the next read.
    let buffer = '';

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let chunk: OllamaChatChunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        return; // 壊れた行はスキップ（バッファリング済みなので通常発生しない）
      }
      responseModel = chunk.model;
      if (chunk.done) sawDone = true;

      // Ollama thinking field (separate from content for models like Gemma 4)
      if (chunk.message?.thinking) {
        const prefix = inThinking ? '' : '<think>';
        inThinking = true;
        onDelta({ content: prefix + chunk.message.thinking });
      }

      if (chunk.message?.content) {
        // Strip Gemma4-specific template artifacts that appear in the content
        // field: "thought" transition lines (also mid-stream) and "<channel|>" delimiters.
        const stripped = chunk.message.content
          .replace(/(^|\n)thought\n/g, '$1')
          .replace(/<channel\|>/g, '');
        let deltaText = stripped;
        if (inThinking) {
          deltaText = '</think>' + deltaText;
          inThinking = false;
        }
        if (deltaText) {
          fullContent += stripped;
          onDelta({ ...chunk.message, content: deltaText });
        }
      }

      if (chunk.message?.tool_calls) {
        if (inThinking) {
          onDelta({ content: '</think>' });
          inThinking = false;
        }
        allToolCalls.push(...chunk.message.tool_calls);
        onDelta(chunk.message);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
        }
      }
      processLine(buffer); // 末尾に改行なしで終わった最終行を処理
    } finally {
      // Close the thinking block even when the stream is ABORTED mid-thinking
      // (degeneration abort / user stop). Without this the UI tag state
      // machine stays stuck in think mode and the next generation's text is
      // rendered inside the previous thinking block (observed as a literal
      // "<think>" appearing in the chat).
      if (inThinking) {
        onDelta({ content: '</think>' });
      }
    }

    // done:true を受け取らずにボディが閉じた = 応答が途中で切断された。
    // ユーザー停止/タイムアウトは reader.read() が例外を投げるためここには来ない。
    // 無言で部分応答を「完全な回答」として返すと短い回答に見えるため、明示的に失敗させる。
    if (!sawDone && !signal?.aborted) {
      throw new Error(
        'Response stream ended before completion (connection interrupted — ' +
        'likely an SSH tunnel drop). The partial output above may be truncated.'
      );
    }

    return {
      model: responseModel ?? request.model,
      message: {
        role: 'assistant',
        content: fullContent,
        tool_calls: allToolCalls.length > 0 ? allToolCalls : undefined,
      },
      done: true,
    };
  }

  /** ストリームなし・単発リクエスト（主に内部用） */
  async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse> {
    const baseUrl = await this.connectionManager.getBaseUrl();
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, options: this.mergeOptions(request.options), stream: false }),
      signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${errText}${apiErrorHint(response.status, errText)}`);
    }

    return response.json() as Promise<OllamaChatResponse>;
  }

  async listModels(): Promise<ListModelsResponse> {
    const baseUrl = await this.connectionManager.getBaseUrl();
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    return response.json() as Promise<ListModelsResponse>;
  }

  async ping(): Promise<boolean> {
    try {
      const baseUrl = await this.connectionManager.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
