import type { OllamaToolCall } from '../llm/OllamaClient';

/**
 * Shared helpers for the agent implementations. These were duplicated across
 * AgentLoop / DebugPhaseAgent / ChatOnlyAgent / RepoMapAgent and drifted
 * apart more than once — keep the single source of truth here.
 */

/** Removes <think> blocks, including an UNCLOSED trailing block left when a
 *  stream was aborted mid-thinking. */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '');
}

export interface ParsedToolCall {
  call: OllamaToolCall;
  parsedArgs: Record<string, unknown>;
  id: string;
}

/** Normalizes accumulated tool calls: Ollama may deliver arguments as a JSON
 *  string OR an already-parsed object; IDs may be missing. */
export function parseToolCalls(calls: OllamaToolCall[]): ParsedToolCall[] {
  return calls.map((call, idx) => {
    let parsedArgs: Record<string, unknown> = {};
    const rawArgs = call.function.arguments;
    if (typeof rawArgs === 'string') {
      try { parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>; } catch { /* keep {} */ }
    } else if (rawArgs !== null && typeof rawArgs === 'object') {
      parsedArgs = rawArgs as Record<string, unknown>;
    }
    return { call, parsedArgs, id: call.id ?? `call_${idx}_${Date.now()}` };
  });
}

/** Invalidates read-loop counters for an edited file (matched by basename so
 *  relative/absolute spellings both clear). Re-reading CHANGED content is
 *  legitimate — the syntax-error recovery flow depends on it. */
export function invalidateReadCounts(fileReadCounts: Map<string, number>, editedPath: string): void {
  const editedBase = editedPath.replace(/\\/g, '/').split('/').pop();
  for (const key of [...fileReadCounts.keys()]) {
    if (key.replace(/\\/g, '/').split('/').pop() === editedBase) {
      fileReadCounts.delete(key);
    }
  }
}

/** Builds the degeneration-recovery user message. The tail of the aborted
 *  generation is salvaged so a diagnosis reached inside thinking survives the
 *  retry (observed: the correct root cause was found right before an abort). */
export function buildRecoveryMessage(accumulated: string, retries: number, maxRetries: number): string {
  const salvage = accumulated.replace(/<\/?think>/g, '').trim().slice(-800);
  return (
    `[RECOVERY ${retries}/${maxRetries}] 直前の生成が繰り返しループを起こし中断されました。` +
    (salvage ? `\n中断前の部分的な分析（有用なら引き継ぐこと）:\n"""\n${salvage}\n"""\n` : '') +
    `次の1つのアクションだけを簡潔に実行してください。長い出力は避けてください。`
  );
}
