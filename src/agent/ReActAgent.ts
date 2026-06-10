import type { OllamaClient, OllamaChatDelta } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import type { AgentEventHandler } from './AgentLoop';
import { DegenerationDetector, SelfCorrectionDetector } from './degenerationDetector';

const MAX_ITERATIONS = 20;
const MAX_DEGEN_RETRIES = 2;

/**
 * ReAct (Reasoning + Acting) フレームワーク実装。
 * Tool Callingをサポートしないモデル向けに、
 * Thought / Action / Observation のテキストパターンで推論とツール実行を行う。
 *
 * 期待する出力フォーマット:
 *   Thought: <reasoning>
 *   Action: <tool_name>
 *   Action Input: <json args>
 *   Observation: <tool result>  ← エージェントが追記
 *   Final Answer: <answer>      ← ループ終了
 */
export class ReActAgent {
  private readonly systemPrompt: string;

  constructor(
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private workspaceRoot: string,
    private outputLanguage: string = 'English'
  ) {
    this.systemPrompt = this.buildSystemPrompt();
  }

  async run(
    userMessage: string,
    onEvent: AgentEventHandler,
    signal: AbortSignal,
    images?: string[]
  ): Promise<void> {
    this.contextManager.setSystemPrompt(this.systemPrompt);
    this.contextManager.addMessage({ role: 'user', content: userMessage, images });
    await this.contextManager.compactIfNeeded(signal);

    const degDetector = new DegenerationDetector();
    const selfCorrDetector = new SelfCorrectionDetector();
    let degenerationRetries = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal.aborted) {
        onEvent({ type: 'error', content: 'Cancelled by user' });
        return;
      }

      const callController = new AbortController();
      const propagateAbort = () => callController.abort();
      signal.addEventListener('abort', propagateAbort, { once: true });

      let fullResponse = '';
      let degenerated = false;
      degDetector.reset();
      selfCorrDetector.reset();

      const onDelta = (delta: OllamaChatDelta) => {
        if (delta.content) {
          fullResponse += delta.content;
          onEvent({ type: 'text', content: delta.content });
          if (!degenerated && (degDetector.feed(delta.content) || selfCorrDetector.feed(delta.content))) {
            degenerated = true;
            callController.abort();
          }
        }
      };

      const messages = this.contextManager.getMessages();
      const hasImages = messages.some(m => m.images && m.images.length > 0);
      try {
        await this.client.chatStream(
          {
            model: this.modelRouter.getModelForImages(hasImages),
            messages,
            options: { num_predict: 2048, temperature: 0.35, top_p: 0.9, mirostat: 2, mirostat_tau: 5.0 },
          },
          onDelta,
          callController.signal
        );
      } catch {
        // AbortError from degeneration or user stop
      } finally {
        signal.removeEventListener('abort', propagateAbort);
      }

      if (signal.aborted) {
        onEvent({ type: 'error', content: 'Cancelled by user' });
        return;
      }

      if (degenerated) {
        degenerationRetries++;
        if (degenerationRetries > MAX_DEGEN_RETRIES) {
          onEvent({ type: 'error', content: `出力の縮退リトライ上限(${MAX_DEGEN_RETRIES})に達しました。` });
          return;
        }
        this.contextManager.truncateLastToolMessage(400);
        this.contextManager.addMessage({
          role: 'user',
          content: `[RECOVERY ${degenerationRetries}/${MAX_DEGEN_RETRIES}] 直前の生成が縮退しました。次の1ステップだけを簡潔に実行してください。`,
        });
        onEvent({ type: 'text', content: `\n⚠ 縮退を検知しました（リトライ ${degenerationRetries}/${MAX_DEGEN_RETRIES}）\n\n` });
        continue;
      }

      degenerationRetries = 0;

      this.contextManager.addMessage({ role: 'assistant', content: fullResponse });

      // Final Answer が含まれていたら終了
      if (/Final Answer:/i.test(fullResponse)) {
        onEvent({ type: 'done' });
        return;
      }

      // Action と Action Input をパース
      const actionMatch = fullResponse.match(/Action:\s*(.+)/i);
      const actionInputMatch = fullResponse.match(/Action Input:\s*(\{[\s\S]*?\}|\S+)/i);

      if (!actionMatch) {
        onEvent({ type: 'done' });
        return;
      }

      const toolName = actionMatch[1].trim();
      let toolArgs: Record<string, unknown> = {};
      if (actionInputMatch) {
        try {
          toolArgs = JSON.parse(actionInputMatch[1]) as Record<string, unknown>;
        } catch {
          toolArgs = { input: actionInputMatch[1] };
        }
      }

      onEvent({ type: 'tool_call', toolName, toolArgs });

      const result = await this.toolRegistry.execute(toolName, toolArgs, this.workspaceRoot);

      onEvent({ type: 'tool_result', content: result.output, success: result.success });

      // Observation を会話履歴に追加してループ継続
      this.contextManager.addMessage({
        role: 'user',
        content: `Observation: ${result.output}`,
      });
    }

    onEvent({ type: 'error', content: `Max iterations (${MAX_ITERATIONS}) reached` });
  }

  private buildSystemPrompt(): string {
    const toolDesc = this.toolRegistry.toReActDescription();
    return `You are an AI assistant that can use tools to help with coding tasks.
Always respond in ${this.outputLanguage}. Internal reasoning (Thought steps) may be in any language.

Available tools:
${toolDesc}

Use the following format strictly:
Thought: <your reasoning about what to do next>
Action: <tool_name from the list above>
Action Input: <JSON object with tool arguments>

After receiving an Observation, continue with another Thought/Action or provide:
Final Answer: <your final response to the user>

Always reason step by step. Never skip the Thought step.`;
  }
}
