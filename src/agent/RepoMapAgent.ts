import * as fs from 'fs/promises';
import * as path from 'path';
import type { OllamaClient, OllamaChatDelta } from '../llm/OllamaClient';
import type { ModelRouter } from '../llm/ModelRouter';
import type { ToolRegistry } from './ToolRegistry';
import { FILE_EDIT_TOOLS } from './ToolRegistry';
import { BehaviorVerifier } from './BehaviorVerifier';
import { checkSyntaxAfterWrite } from './tools/syntaxCheck';
import { stripThink, LoopGuardState } from './agentUtils';
import type { AgentEvent, AgentEventHandler } from './AgentLoop';
import { AgentLoop } from './AgentLoop';
import { DegenerationDetector, SelfCorrectionDetector } from './degenerationDetector';
import type { ContextManager } from '../llm/ContextManager';

export interface PlanStep {
  id: number;
  description: string;
}

export interface Plan {
  steps: PlanStep[];
}

// ── Shared repo-map builder ───────────────────────────────────────────────────
// Aider-style repo map: file tree + extracted code symbols per file.
// Reference: https://aider.chat/docs/repomap.html

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', '.vscode', '__pycache__',
  '.mypy_cache', 'target', 'build', 'coverage', '.turbo', '.next',
]);
const SYMBOL_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.py',
  '.go',
  '.rs',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hxx',
  '.java',
  '.cs',
  '.rb',
  '.php',
  '.kt', '.kts',
  '.swift',
]);
const MAX_FILE_SIZE = 150_000;

export async function buildRepoMap(workspaceRoot: string): Promise<string> {
  const lines: string[] = [];
  await walkDir(workspaceRoot, '', lines, 0, 3);
  return lines.join('\n');
}

const MENTIONED_FILE_RE = /[\w./\\-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|cs|cpp|cc|c|h|hpp|rb|php|kt|kts|swift)\b/g;
const MAX_OUTLINE_CHARS = 2500;

/**
 * Extracts file names mentioned in the task message and returns their
 * structural outlines (classes/methods + line numbers).
 *
 * Why: plans are otherwise generated from the file TREE alone, before any
 * code has been read — observed result was a plan that ordered "fix
 * dropEvent" when dropEvent was already correct and the real bug was in a
 * sibling class. With the outline in the plan prompt, the planner can target
 * real methods instead of guessed ones.
 */
export async function buildMentionedFileOutlines(
  taskMessage: string,
  workspaceRoot: string,
  toolRegistry: ToolRegistry
): Promise<string> {
  if (!toolRegistry.has('get_file_outline')) return '';

  const candidates = [...new Set(taskMessage.match(MENTIONED_FILE_RE) ?? [])].slice(0, 5);
  const sections: string[] = [];
  let total = 0;

  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(workspaceRoot, candidate);
    const exists = await fs.stat(abs).then(s => s.isFile()).catch(() => false);
    if (!exists) continue;

    const result = await toolRegistry.execute('get_file_outline', { path: candidate }, workspaceRoot);
    if (!result.success) continue;

    const section = result.output.trim();
    if (total + section.length > MAX_OUTLINE_CHARS) break;
    total += section.length;
    sections.push(section);
  }

  return sections.join('\n\n');
}

async function walkDir(
  dir: string,
  prefix: string,
  lines: string[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const filtered = entries.filter((e) => !IGNORED_DIRS.has(e.name));
  for (const entry of filtered) {
    if (entry.isDirectory()) {
      lines.push(`${prefix}📁 ${entry.name}/`);
      await walkDir(path.join(dir, entry.name), prefix + '  ', lines, depth + 1, maxDepth);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (SYMBOL_EXTS.has(ext)) {
        const symbols = await extractSymbols(path.join(dir, entry.name), ext);
        if (symbols.length > 0) {
          lines.push(`${prefix}📄 ${entry.name} — ${symbols.join(', ')}`);
        } else {
          lines.push(`${prefix}📄 ${entry.name}`);
        }
      } else {
        lines.push(`${prefix}📄 ${entry.name}`);
      }
    }
  }
}

async function extractSymbols(filePath: string, ext: string): Promise<string[]> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size > MAX_FILE_SIZE) return [];
  const src = await fs.readFile(filePath, 'utf-8').catch(() => '');
  if (!src) return [];
  const lines = src.split('\n');
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
    return extractTsSymbols(lines);
  } else if (ext === '.py') {
    return extractPySymbols(lines);
  } else if (ext === '.go') {
    return extractGoSymbols(lines);
  } else if (ext === '.rs') {
    return extractRsSymbols(lines);
  } else if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.c' ||
             ext === '.h' || ext === '.hpp' || ext === '.hxx') {
    return extractCppSymbols(lines);
  } else if (ext === '.java') {
    return extractJavaSymbols(lines);
  } else if (ext === '.cs') {
    return extractCsSymbols(lines);
  } else if (ext === '.rb') {
    return extractRbSymbols(lines);
  } else if (ext === '.php') {
    return extractPhpSymbols(lines);
  } else if (ext === '.kt' || ext === '.kts') {
    return extractKtSymbols(lines);
  } else if (ext === '.swift') {
    return extractSwiftSymbols(lines);
  }
  return [];
}

function extractTsSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    // export (async) function name
    m = t.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
    // export class / abstract class
    m = t.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    // export interface
    m = t.match(/^export\s+interface\s+(\w+)/);
    if (m) { syms.push(`interface ${m[1]}`); continue; }
    // export type Name =
    m = t.match(/^export\s+type\s+(\w+)\s*[=<]/);
    if (m) { syms.push(`type ${m[1]}`); continue; }
    // export const name = (...) =>
    m = t.match(/^export\s+const\s+(\w+)\s*(?::[^=]+)?\s*=\s*(?:async\s+)?\(/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
    // top-level (async) function
    m = t.match(/^(?:async\s+)?function\s+(\w+)/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
    // top-level class
    m = t.match(/^(?:abstract\s+)?class\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractPySymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (m) { syms.push(`def ${m[1]}`); continue; }
    m = t.match(/^class\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractGoSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*[(<[]/);
    if (m) { syms.push(`func ${m[1]}`); continue; }
    m = t.match(/^type\s+(\w+)\s+(?:struct|interface)\s*\{/);
    if (m) { syms.push(`type ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractRsSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:pub(?:\([^)]*\))?\s+)?fn\s+(\w+)\s*[(<[]/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
    m = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/);
    if (m) { syms.push(`type ${m[1]}`); continue; }
    m = t.match(/^impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/);
    if (m) { syms.push(`impl ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractCppSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    // class/struct declaration
    m = t.match(/^(?:class|struct)\s+(\w+)/);
    if (m && !t.includes(';')) { syms.push(`class ${m[1]}`); continue; }
    // namespace
    m = t.match(/^namespace\s+(\w+)/);
    if (m) { syms.push(`namespace ${m[1]}`); continue; }
    // function definition (return type + name + params)
    m = t.match(/^(?:[\w:*&<>]+\s+)+(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?[{;]/);
    if (m && !['if', 'for', 'while', 'switch'].includes(m[1])) {
      syms.push(`fn ${m[1]}`); continue;
    }
  }
  return syms.slice(0, 25);
}

function extractJavaSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:public\s+|private\s+|protected\s+)*(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    m = t.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>[\]]+\s+)+(\w+)\s*\(/);
    if (m && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
      syms.push(`fn ${m[1]}`); continue;
    }
  }
  return syms.slice(0, 25);
}

function extractCsSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:public\s+|private\s+|protected\s+|internal\s+)*(?:abstract\s+|sealed\s+|static\s+)?(?:class|interface|enum|struct|record)\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    m = t.match(/^(?:(?:public|private|protected|internal|static|virtual|override|async|abstract)\s+)+[\w<>[\]]+\s+(\w+)\s*\(/);
    if (m && !['if', 'for', 'foreach', 'while', 'switch', 'catch'].includes(m[1])) {
      syms.push(`fn ${m[1]}`); continue;
    }
  }
  return syms.slice(0, 25);
}

function extractRbSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:module|class)\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    m = t.match(/^def\s+(\w+[?!]?)/);
    if (m) { syms.push(`def ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractPhpSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:abstract\s+)?(?:class|interface|trait|enum)\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    m = t.match(/^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractKtSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:(?:abstract|sealed|open|data|inner|enum)\s+)?(?:class|interface|object)\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    m = t.match(/^(?:(?:public|private|protected|internal|override|suspend|inline)\s+)*fun\s+(\w+)\s*[(<]/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

function extractSwiftSymbols(lines: string[]): string[] {
  const syms: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:final\s+)?(?:class|struct|enum|protocol|actor)\s+(\w+)/);
    if (m) { syms.push(`class ${m[1]}`); continue; }
    m = t.match(/^(?:(?:public|private|internal|open|fileprivate|override|static|class|mutating|async)\s+)*func\s+(\w+)\s*[(<]/);
    if (m) { syms.push(`fn ${m[1]}`); continue; }
  }
  return syms.slice(0, 25);
}

// ── Plan creation ─────────────────────────────────────────────────────────────

export const MAX_PLAN_RETRIES = 3;

function buildPlanSystemPrompt(outputLanguage: string): string {
  return (
    `You are a planning assistant. Create a task list for a coding task.\n` +
    `Write all step descriptions in ${outputLanguage}.\n\n` +
    `RULES:\n` +
    `1. Use as many steps as needed (1 to 10). Do NOT hardcode exactly 3 steps.\n` +
    `   - Tiny task (1 file, 1 clear change): 1-2 steps\n` +
    `   - Medium task (multiple files, new feature): 3-5 steps\n` +
    `   - Large task (refactor, many files): 5-10 steps\n` +
    `2. Each step must map to ONE concrete operation (one file edit, one file creation, one test run):\n` +
    `   - BAD: "Implement the feature" (too vague)\n` +
    `   - BAD: "Read and fix src/widget.py" (read + edit = two steps)\n` +
    `   - GOOD: "Edit src/widget.py to add dropEvent() handler in ImageSlot class"\n` +
    `   - GOOD: "Create src/models/user.py with UserProfile dataclass"\n` +
    `   - GOOD: "Run python -m pytest tests/test_widget.py -x to verify the fix"\n` +
    `3. For multi-file tasks: one step per file edit or per test run.\n` +
    `4. Include a verify step (run tests/build) only if there is something testable or runnable.\n` +
    `5. Write step DESCRIPTIONS only. Do NOT include code, file contents, or tool arguments.\n` +
    `6. Respond ONLY with a valid JSON object, no markdown fences:\n` +
    `{"steps":[{"id":1,"description":"..."},{"id":2,"description":"..."}]}`
  );
}

async function attemptPlan(
  client: OllamaClient,
  modelRouter: ModelRouter,
  repoMap: string,
  taskMessage: string,
  signal: AbortSignal,
  images: string[] | undefined,
  onEvent: AgentEventHandler | undefined,
  attempt: number,
  outputLanguage: string
): Promise<Plan> {
  let fullResponse = '';
  type ThinkState = 'waiting' | 'in_think' | 'done';
  let thinkState: ThinkState = 'waiting';

  const userContent = attempt > 1
    ? `Repository structure:\n${repoMap}\n\nTask: ${taskMessage}\n\n` +
      `IMPORTANT: Your previous response was not valid JSON. Respond ONLY with the JSON object — no markdown, no explanation.`
    : `Repository structure:\n${repoMap}\n\nTask: ${taskMessage}`;

  // Per-call controller: a self-correction/degeneration loop only aborts THIS
  // generation. The brace-counting extractor below can still pick up the last
  // complete JSON candidate drafted before the loop started.
  const callController = new AbortController();
  const propagateAbort = () => callController.abort();
  signal.addEventListener('abort', propagateAbort, { once: true });

  const degDetector = new DegenerationDetector();
  const selfCorrDetector = new SelfCorrectionDetector();

  try {
    await client.chatStream(
      {
        model: modelRouter.getChatModel(),
        messages: [
          { role: 'system', content: buildPlanSystemPrompt(outputLanguage) },
          { role: 'user', content: userContent, images },
        ],
        // Plan generation: force think:false. Models with always-on chain-of-thought
        // (Gemma4, DeepSeek-R1) can spend the entire token budget redrafting the plan
        // inside the thinking block and never emit the JSON in `content`.
        think: false,
        options: { num_predict: 2048 },
      },
      (delta: OllamaChatDelta) => {
        if (!delta.content) return;
        fullResponse += delta.content;
        if (degDetector.feed(delta.content) || selfCorrDetector.feed(delta.content)) {
          callController.abort();
          return;
        }
        if (!onEvent) return;
        const c = delta.content;
        if (thinkState === 'waiting') {
          if (c.includes('<think>')) {
            thinkState = 'in_think';
            onEvent({ type: 'text', content: c });
            if (c.includes('</think>')) thinkState = 'done';
          }
        } else if (thinkState === 'in_think') {
          const closeIdx = c.indexOf('</think>');
          if (closeIdx !== -1) {
            onEvent({ type: 'text', content: c.slice(0, closeIdx + '</think>'.length) });
            thinkState = 'done';
          } else {
            onEvent({ type: 'text', content: c });
          }
        }
      },
      callController.signal
    );
  } catch {
    // AbortError from the self-correction/degeneration cutoff or user cancel —
    // fall through to extraction below, which handles a partial fullResponse.
  } finally {
    signal.removeEventListener('abort', propagateAbort);
  }

  // Strip <think>…</think> blocks so Qwen3/Gemma4 thinking tokens don't corrupt extraction.
  const cleaned = stripThink(fullResponse).trim();

  // Models often produce multiple draft JSON objects (plan → self-correction → final polish).
  // Use brace counting to extract all {"steps":...} candidates, then pick the last valid one
  // so we prefer the final revised version over the first draft.
  const candidates: string[] = [];
  let searchFrom = 0;
  while (true) {
    const keyIdx = cleaned.indexOf('"steps"', searchFrom);
    if (keyIdx === -1) break;
    // Walk back to find the opening {
    let braceIdx = keyIdx - 1;
    while (braceIdx >= 0 && cleaned[braceIdx] === ' ') braceIdx--;
    if (braceIdx < 0 || cleaned[braceIdx] !== '{') { searchFrom = keyIdx + 1; continue; }
    // Walk forward counting braces to find the matching }
    let depth = 0;
    let endIdx = -1;
    for (let j = braceIdx; j < cleaned.length; j++) {
      if (cleaned[j] === '{') depth++;
      else if (cleaned[j] === '}') { depth--; if (depth === 0) { endIdx = j; break; } }
    }
    if (endIdx !== -1) candidates.push(cleaned.slice(braceIdx, endIdx + 1));
    searchFrom = keyIdx + 1;
  }

  // Try from last candidate (final version) back to first (fallback)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const plan = JSON.parse(candidates[i]) as Plan;
      if (Array.isArray(plan.steps) && plan.steps.length > 0) return plan;
    } catch { /* try next */ }
  }
  return { steps: [] };
}

/**
 * Creates a high-level TODO list plan. Retries up to MAX_PLAN_RETRIES times if
 * the model fails to output valid JSON. Streams <think> content live to the UI.
 */
export async function createPlan(
  client: OllamaClient,
  modelRouter: ModelRouter,
  repoMap: string,
  taskMessage: string,
  signal: AbortSignal,
  images?: string[],
  onEvent?: AgentEventHandler,
  outputLanguage = 'English'
): Promise<Plan> {
  for (let attempt = 1; attempt <= MAX_PLAN_RETRIES; attempt++) {
    if (signal.aborted) return { steps: [] };

    if (attempt > 1 && onEvent) {
      onEvent({ type: 'thinking', content: `Retrying plan generation (attempt ${attempt}/${MAX_PLAN_RETRIES})...` });
    }

    const plan = await attemptPlan(client, modelRouter, repoMap, taskMessage, signal, images, onEvent, attempt, outputLanguage);
    if (plan.steps.length > 0) return plan;
    if (signal.aborted) return plan;
  }
  return { steps: [] };
}

export function formatPlan(plan: Plan): string {
  return plan.steps.map((s) => `${s.id}. ${s.description}`).join('\n');
}

export type ApprovalFn = (planText: string, cycle?: number) => Promise<boolean>;

// ── Shared execution via AgentLoop ────────────────────────────────────────────

/**
 * Injects the plan into contextManager and runs AgentLoop.
 * Tool results are seen by the model in real-time (no blind pre-decided args).
 * Returns a list of tool error strings for PDCA loop use.
 */
export async function executeWithLoop(
  contextMessage: string,
  client: OllamaClient,
  contextManager: ContextManager,
  modelRouter: ModelRouter,
  toolRegistry: ToolRegistry,
  workspaceRoot: string,
  onEvent: AgentEventHandler,
  signal: AbortSignal,
  images?: string[]
): Promise<string[]> {
  contextManager.addMessage({ role: 'user', content: contextMessage, images });

  const errors: string[] = [];

  const innerOnEvent = (event: AgentEvent) => {
    if (event.type === 'done') return;
    if (event.type === 'tool_result' && event.success === false) {
      errors.push(event.content ?? 'Unknown tool error');
    }
    onEvent(event);
  };

  const loop = new AgentLoop(client, contextManager, modelRouter, toolRegistry, workspaceRoot);
  await loop.runFromContext(innerOnEvent, signal);

  return errors;
}

/**
 * Extracts "<MARKER>: <content>" from model output, accepting it only when
 * real content follows ON THE SAME LINE. The model sometimes ECHOES the
 * escape-hatch instructions verbatim (observed: an echoed bare "STEP
 * MISMATCH:" line triggered a false re-plan with instruction fragments as
 * the "finding"), so empty content and "<placeholder>" lines are rejected.
 */
export function extractEscapeMarker(text: string, marker: 'STEP MISMATCH' | 'STEP SKIP'): string | null {
  const re = new RegExp(`${marker.replace(' ', '\\s+')}:([^\\n]*)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const sameLine = (m[1] ?? '').trim();
    if (sameLine.length < 8 || sameLine.startsWith('<')) continue;
    return text.slice(m.index, m.index + 600).trim();
  }
  return null;
}

export interface StepExecutionResult {
  errors: string[];
  /** Set when the model declared (with evidence) that the plan's premise is
   *  wrong mid-execution. Remaining steps are skipped — the caller should
   *  re-plan using this finding. */
  planMismatch?: string;
  /** Workspace-relative paths passed to file-edit tools during execution */
  editedFiles: string[];
}

/**
 * Executes each plan step as a separate AgentLoop call for granular progress tracking.
 * Adds the initial context (repo map + task + full plan) once, then drives one loop per step.
 * Context accumulates naturally — step N+1 sees what step N did.
 */
export async function executeSteps(
  initialContextMessage: string,
  steps: PlanStep[],
  client: OllamaClient,
  contextManager: ContextManager,
  modelRouter: ModelRouter,
  toolRegistry: ToolRegistry,
  workspaceRoot: string,
  onEvent: AgentEventHandler,
  signal: AbortSignal,
  images?: string[],
  /** Pass ONE instance across all executeSteps calls of a user request so the
   *  edit-oscillation guard sees attempts from earlier plan cycles too. */
  loopGuard?: LoopGuardState
): Promise<StepExecutionResult> {
  contextManager.addMessage({ role: 'user', content: initialContextMessage, images });
  const guard = loopGuard ?? new LoopGuardState();

  const allErrors: string[] = [];
  let planMismatch: string | undefined;
  const editedFiles = new Set<string>();

  // Truncate a single error string so errorContext doesn't blow up the plan prompt.
  const truncateError = (s: string) =>
    s.length > 600 ? s.slice(0, 400) + `\n…[${s.length - 400} chars omitted]` : s;

  // Steps whose description implies a code change must call a write tool
  // before they count as done — observed runs advanced through "modify X"
  // steps on reads alone, then spiralled on the resulting inconsistency.
  const IMPLIES_EDIT_RE = /修正|変更|追加|実装|削除|置き換え|書き換え|作成|fix|modif|add|implement|creat|updat|refactor|rewrit|writ/i;

  let editsApplied = 0; // plan-wide count, reported to the model each step

  for (const step of steps) {
    if (signal.aborted) break;

    onEvent({ type: 'phase_banner', content: `**[Step ${step.id}/${steps.length}]** ${step.description}` });

    // Observed failure: the model reads "Execute step N" as a HUMAN skipping
    // steps and burns its whole thinking budget on meta-confusion ("but step 1
    // isn't done yet!?"). Make the automation explicit and forbid the debate.
    contextManager.addMessage({
      role: 'user',
      content:
        `[AUTOMATED PLAN RUNNER — Step ${step.id}/${steps.length}]\n${step.description}\n\n` +
        `Note: this message comes from the automated plan runner, not from a human. ` +
        `Steps advance automatically. File edits applied so far in this plan: ${editsApplied}. ` +
        `Do NOT discuss whether earlier steps were completed or skipped — ` +
        `if something this step depends on is missing, simply do it now. ` +
        `Act immediately with tool calls.\n` +
        `ESCAPE HATCHES (use after investigating with tools, never before):\n` +
        `- If this step's PREMISE is wrong (the real problem is elsewhere), output:\n` +
        `  STEP MISMATCH: <what you actually found and where the real problem is>\n` +
        `- If this step's work is ALREADY COMPLETE in the current code (e.g. done by an earlier step), output:\n` +
        `  STEP SKIP: <evidence that it is already complete>\n` +
        `Do NOT quote or repeat these instructions in your output.`,
    });

    const stepErrors: string[] = [];
    let toolCallsInStep = 0;
    let editCallsInStep = 0;
    let stepText = '';
    // toolCallId → path of an in-flight edit call. Edits are counted on the
    // RESULT, not the call: blocked edits (duplicate / oscillation guard) and
    // failed ones (old_str not found) previously inflated editsApplied and
    // satisfied the step's edit gate without changing any file.
    const pendingEditCalls = new Map<string, string>();
    const innerOnEvent = (event: AgentEvent) => {
      if (event.type === 'done') return;
      if (event.type === 'text') stepText += event.content ?? '';
      if (event.type === 'tool_call') {
        toolCallsInStep++;
        if (event.toolName && FILE_EDIT_TOOLS.has(event.toolName) && event.toolCallId) {
          const p = event.toolArgs?.['path'];
          pendingEditCalls.set(event.toolCallId, typeof p === 'string' ? p : '');
        }
      }
      if (event.type === 'tool_result' && event.toolCallId && pendingEditCalls.has(event.toolCallId)) {
        const p = pendingEditCalls.get(event.toolCallId)!;
        pendingEditCalls.delete(event.toolCallId);
        if (event.success === true) {
          editCallsInStep++;
          editsApplied++;
          if (p) editedFiles.add(p);
        }
      }
      // Capture tool failures — but NOT guardrail notices (read-loop blocks,
      // duplicate-call blocks, unknown-tool hints). Those are steering
      // messages, not task failures; counting them inflated the cycle error
      // count and triggered pointless re-plans.
      if (event.type === 'tool_result' && event.success === false) {
        const content = (event.content ?? '').trim();
        const isGuardrailNotice =
          /^\[(?:READ LOOP|LOOP DETECTED|DUPLICATE EDIT BLOCKED|EDIT OSCILLATION)\]|^Unknown tool:/.test(content);
        if (!isGuardrailNotice) {
          stepErrors.push(`[Tool error] ${truncateError(content || 'Unknown tool error')}`);
        }
      }
      // Capture agent-level failures (max iterations reached, degeneration limit, etc.)
      if (event.type === 'error') {
        stepErrors.push(`[Agent error] ${truncateError(event.content ?? 'Unknown agent error')}`);
      }
      onEvent(event);
    };

    // Plan-step execution is repair-type work: run with think disabled
    // (validated: thinking-enabled regeneration can burn the whole budget).
    const loop = new AgentLoop(client, contextManager, modelRouter, toolRegistry, workspaceRoot, false);
    const stepImpliesEdit = IMPLIES_EDIT_RE.test(step.description);

    // Completion gate: up to 2 attempts per step. Retry when the step did
    // nothing at all, or when it implies an edit but only ran read tools.
    for (let attempt = 1; ; attempt++) {
      // Markers are only valid in the CURRENT attempt's output — a rejected
      // declaration from attempt 1 must not be re-matched after the retry
      // (observed: a stale STEP SKIP fired right as the model was about to edit).
      const attemptTextStart = stepText.length;
      await loop.runFromContext(innerOnEvent, signal, guard);
      if (signal.aborted) break;
      const attemptText = stepText.slice(attemptTextStart);

      // Escape hatch: the model declared this step's premise wrong. Accepted
      // only when it actually investigated (≥1 tool call) — otherwise
      // declaring mismatch would be an easy way to dodge work.
      const mismatch = extractEscapeMarker(attemptText, 'STEP MISMATCH');
      if (mismatch && toolCallsInStep > 0) {
        planMismatch = mismatch;
        break;
      }

      // Already-done hatch: skips the edit gate without recording an error.
      // Observed false positive: a step whose edit landed in an earlier step
      // was flagged "required edit but none applied" and triggered a
      // pointless re-plan cycle.
      const skip = extractEscapeMarker(attemptText, 'STEP SKIP');
      if (skip && toolCallsInStep > 0) {
        onEvent({ type: 'text', content: `\nStep ${step.id}: 既に完了済みと判断 — 次のステップへ進みます。\n` });
        break;
      }

      const noAction = toolCallsInStep === 0;
      const missingEdit = stepImpliesEdit && editCallsInStep === 0;
      if (attempt >= 2 || (!noAction && !missingEdit)) {
        if (missingEdit) {
          stepErrors.push(`[Step ${step.id}] required a file edit but none was applied`);
        }
        break;
      }

      contextManager.addMessage({
        role: 'user',
        content: noAction
          ? `[Step ${step.id} was NOT executed] 直前の応答はツールを1つも呼び出していません。` +
            `「確認します」と宣言するだけでは何も起こりません。` +
            `read_file / edit_file / replace_lines / run_terminal 等のツールを実際に呼び出してステップを完了してください。`
          : `[Step ${step.id} is NOT complete] このステップはファイルの変更を要求していますが、` +
            `edit_file / replace_lines / write_file が一度も呼ばれていません。` +
            `調査はもう十分です。今すぐ修正を適用してください。`,
      });
      onEvent({
        type: 'text',
        content: noAction
          ? `\n⚠ Step ${step.id}: ツール呼び出しなしで終了 — 再試行します。\n`
          : `\n⚠ Step ${step.id}: 編集が未適用 — 再試行します。\n`,
      });
    }

    if (stepErrors.length > 0) {
      onEvent({ type: 'text', content: `\n⚠ Step ${step.id} completed with ${stepErrors.length} error(s).\n` });
    }

    allErrors.push(...stepErrors);

    if (planMismatch) {
      onEvent({
        type: 'text',
        content: `\n⚠ Step ${step.id}: プランの前提齟齬が報告されました — 残りのステップを中断し、再プランに移ります。\n`,
      });
      break;
    }

    if (signal.aborted) break;
  }

  // Reconcile transient syntax errors: an edit that broke the file and was
  // FIXED later in the same run must not count against the cycle. Only files
  // whose FINAL state still fails to compile keep their syntax-error entries.
  for (const f of editedFiles) {
    if (!/\.py$/i.test(f)) continue;
    const abs = path.resolve(workspaceRoot, f);
    const finalError = await checkSyntaxAfterWrite(abs);
    if (finalError === null) {
      const base = path.basename(f);
      for (let i = allErrors.length - 1; i >= 0; i--) {
        if (allErrors[i].includes('SYNTAX ERROR') && allErrors[i].includes(base)) {
          allErrors.splice(i, 1);
        }
      }
    } else {
      allErrors.push(`[Final state] ${f} still has a syntax error: ${finalError.slice(0, 200)}`);
    }
  }

  return { errors: allErrors, planMismatch, editedFiles: [...editedFiles] };
}

// ── Repo Map & Plan モード ────────────────────────────────────────────────────

export class RepoMapAgent {
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
    let repoMap = await buildRepoMap(this.workspaceRoot);

    // Give the planner real structure (classes/methods + line numbers) for the
    // files the task names, so plans target actual code instead of guesses.
    const outlines = await buildMentionedFileOutlines(userMessage, this.workspaceRoot, this.toolRegistry);
    if (outlines) {
      repoMap += `\n\n# Outline of files mentioned in the task\n${outlines}`;
    }

    onEvent({ type: 'thinking', content: 'Creating execution plan...' });
    // Pass onEvent so <think> tokens stream live alongside the spinner
    const plan = await createPlan(
      this.client, this.modelRouter, repoMap, userMessage, signal, images, onEvent, this.outputLanguage
    );

    if (plan.steps.length === 0) {
      onEvent({ type: 'text', content: `⚠ Could not generate a valid plan after ${MAX_PLAN_RETRIES} attempts. Please try again.` });
      onEvent({ type: 'done' });
      return;
    }

    const planText = formatPlan(plan);
    // Think block already streamed above; now show approval block (time-series order)
    onEvent({ type: 'needs_approval', content: planText });
    const approved = await this.approvalFn(planText);
    if (!approved) {
      onEvent({ type: 'text', content: 'Plan cancelled by user.' });
      onEvent({ type: 'done' });
      return;
    }

    const initialContext =
      `Repository structure:\n${repoMap}\n\n` +
      `Task: ${userMessage}\n\n` +
      `Full execution plan:\n${planText}`;

    onEvent({ type: 'thinking', content: 'Executing plan...' });
    // One guard for BOTH cycles: cycle 2 must not be allowed to silently
    // re-apply edits that already failed in cycle 1.
    const loopGuard = new LoopGuardState();
    const result = await executeSteps(
      initialContext, plan.steps,
      this.client, this.contextManager, this.modelRouter,
      this.toolRegistry, this.workspaceRoot, onEvent, signal, images, loopGuard
    );

    // The executing agent found the plan's premise was wrong — re-plan ONCE
    // from the finding (a far better input than the original guess).
    if (result.planMismatch && !signal.aborted) {
      onEvent({ type: 'text', content: '\n📋 発見された実際の問題に基づいて再プランします…\n' });
      const replanTask =
        `Original task: ${userMessage}\n\n` +
        `During execution, the agent investigated and found the original plan's premise was WRONG:\n` +
        `${result.planMismatch}\n\n` +
        `Create a corrected plan based on this finding.`;
      const plan2 = await createPlan(
        this.client, this.modelRouter, repoMap, replanTask, signal, undefined, onEvent, this.outputLanguage
      );

      if (plan2.steps.length > 0 && !signal.aborted) {
        const planText2 = formatPlan(plan2);
        onEvent({ type: 'needs_approval', content: planText2, cycle: 2 });
        const approved2 = await this.approvalFn(planText2, 2);
        if (approved2) {
          const result2 = await executeSteps(
            `Corrected plan (the original plan's premise was wrong):\n${planText2}\n\n` +
              `Finding that invalidated the original plan:\n${result.planMismatch}`,
            plan2.steps,
            this.client, this.contextManager, this.modelRouter,
            this.toolRegistry, this.workspaceRoot, onEvent, signal, undefined, loopGuard
          );
          result2.editedFiles.forEach(f => result.editedFiles.push(f));
        } else {
          onEvent({ type: 'text', content: 'Corrected plan cancelled by user.' });
        }
      }
    }

    // ── Behavior verification (LLM-generated smoke test) ────────────────────
    if (this.enableVerify && !signal.aborted) {
      const target = BehaviorVerifier.pickTarget(result.editedFiles);
      if (target) {
        const verifier = new BehaviorVerifier(this.client, this.modelRouter, this.toolRegistry, this.workspaceRoot);
        await verifier.run(userMessage, target, onEvent, signal);
      }
    }

    onEvent({ type: 'done' });
  }
}
