import type { OllamaClient, OllamaChatDelta } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { AgentEventHandler } from './AgentLoop';
import { stripThink } from './agentUtils';

/**
 * Pure-chat agent: single LLM call with no tools and a minimal system prompt.
 * Intended for Q&A, explanations, brainstorming — anything that does not need
 * file access or code execution.
 */
export class ChatOnlyAgent {
  constructor(
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private outputLanguage: string = 'Japanese'
  ) {}

  async run(
    userMessage: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal,
    images?: string[]
  ): Promise<void> {
    const dateStr = new Date().toLocaleString('ja-JP', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });
    this.contextManager.setSystemPrompt(
      `You are a helpful assistant. Always respond in ${this.outputLanguage}. ` +
      `Current date: ${dateStr}. You have no tools in this mode — if the question requires ` +
      `up-to-date information you cannot know, say so instead of guessing.`
    );
    this.contextManager.addMessage({ role: 'user', content: userMessage, images });

    const messages = this.contextManager.getMessages();
    const hasImages = messages.some(m => m.images && m.images.length > 0);

    let fullContent = '';
    const onDelta = (delta: OllamaChatDelta) => {
      if (delta.content) {
        fullContent += delta.content;
        onEvent({ type: 'text', content: delta.content });
      }
    };

    // auto モードでは直前の「[Auto → Chat]」テキストが送信スピナーを消すため、
    // 最初のトークンまでの待機を埋める。
    onEvent({ type: 'thinking', content: 'Waiting for LLM response…' });
    const model = this.modelRouter.getModelForImages(hasImages);
    onEvent({ type: 'model', content: model });

    await this.client.chatStream(
      {
        model,
        messages,
        ...(this.modelRouter.needsThinkParam(model) && { think: true }),
        // num_predict / num_ctx はユーザー設定から OllamaClient が注入する
      },
      onDelta,
      signal
    );

    const cleanContent = stripThink(fullContent).trim();
    this.contextManager.addMessage({ role: 'assistant', content: cleanContent });

    onEvent({ type: 'done' });
  }
}
