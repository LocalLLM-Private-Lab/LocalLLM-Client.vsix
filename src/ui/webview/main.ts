// Webview frontend — runs in a sandboxed browser context (no Node/VSCode APIs)

import { marked } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// Configure marked with syntax highlighting via highlight.js
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        const highlighted = hljs.highlight(text, { language }).value;
        return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
      } catch {
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre><code class="hljs">${escaped}</code></pre>`;
      }
    },
  },
});

/** Markdown → sanitized HTML. Model output and fetched web content both flow
 *  into the chat, so raw HTML from marked must never reach innerHTML directly. */
function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

// ── TeX math display (KaTeX) ──────────────────────────────────────────────────
// 方針: LLMとの往復は生のTeXのまま(プレーン強制はモデルの数式理解を損なう)。
// 描画だけをwebview側で切り替える。markedは \( \) のバックスラッシュや
// 数式中の _ をmarkdown記法として破壊するため、コード外の数式を先に
// プレースホルダへ退避 → markdown変換 → KaTeX出力で復元する。

/** 数式表示ON/OFF(セッションを跨いで保持) */
let texRender =
  ((vscode.getState() as Record<string, unknown> | undefined)?.['texRender'] ?? true) === true;

/** 確定済みmd-containerの元テキスト — トグル時にここから再レンダリングする */
const mdSources = new Map<HTMLElement, string>();

// markdownに干渉しない私用領域(PUA)文字をプレースホルダの印に使う
const MATH_PH = String.fromCharCode(0xe000);
// 単独$は通貨等の誤検知があるため「前後が空白でない+数式らしい中身」だけ拾う。
// 数式らしい中身 = 数式文字(\^_{}=)を含む、または $E$ $m$ $x1$ のような
// 短い変数参照(3文字以下の英数字。"$5 and $10"は中身の空白で弾かれる)
const MATHISH_RE = /[\\^_{}=]/;
const SHORT_VAR_RE = /^[\p{L}\p{N}]{1,3}$/u;

function maskMath(text: string, out: Array<{ src: string; display: boolean }>): string {
  const stash = (src: string, display: boolean): string => {
    out.push({ src, display });
    return `${MATH_PH}${out.length - 1}${MATH_PH}`;
  };
  // コードフェンス/インラインコードの中は触らない
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg;
      return seg
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, src: string) => stash(src, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, src: string) => stash(src, true))
        .replace(/\\\((.+?)\\\)/g, (_, src: string) => stash(src, false))
        .replace(/\$([^$\n]+?)\$/g, (m, src: string) =>
          !/^\s|\s$/.test(src) && (MATHISH_RE.test(src) || SHORT_VAR_RE.test(src))
            ? stash(src, false)
            : m
        );
    })
    .join('');
}

/** markdown + KaTeX。KaTeX出力はサニタイズ後に挿入するが、入力はテキスト由来で
 *  throwOnError:false かつ trust:false(\href等の危険コマンド無効)なので安全。 */
function renderMarkdownWithMath(text: string): string {
  const mathParts: Array<{ src: string; display: boolean }> = [];
  const masked = maskMath(text, mathParts);
  const html = DOMPurify.sanitize(marked.parse(masked) as string);
  return html.replace(new RegExp(`${MATH_PH}(\\d+)${MATH_PH}`, 'g'), (whole, i: string) => {
    const m = mathParts[Number(i)];
    if (!m) return whole;
    try {
      return katex.renderToString(m.src, { displayMode: m.display, throwOnError: false });
    } catch {
      return escapeHtml(m.src);
    }
  });
}

/** 確定したmd-containerを現在の表示モードで(再)レンダリングする */
function renderMdContainer(container: HTMLElement, text: string): void {
  container.innerHTML = texRender ? renderMarkdownWithMath(text) : renderMarkdown(text);
  addCopyButtons(container);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages')!;
const inputEl = document.getElementById('user-input') as HTMLTextAreaElement;
const actionBtn = document.getElementById('btn-action') as HTMLButtonElement;
const btnSlash = document.getElementById('btn-slash') as HTMLButtonElement;
const newBtn = document.getElementById('btn-new') as HTMLButtonElement;
const historyBtn = document.getElementById('btn-history') as HTMLButtonElement;
const settingsBtn = document.getElementById('btn-settings') as HTMLButtonElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const attachmentsEl = document.getElementById('attachments')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const attachBtn = document.getElementById('btn-attach') as HTMLButtonElement;
const inputArea = document.getElementById('input-area')!;
const ringArc = document.getElementById('ring-arc') as unknown as SVGCircleElement;
const tokenLabel = document.getElementById('token-label')!;
const tokenWidget = document.getElementById('token-widget')!;
const historyPanel = document.getElementById('history-panel')!;
const historyList = document.getElementById('history-list')!;
const historyEmpty = document.getElementById('history-empty')!;
const historyCloseBtn = document.getElementById('btn-history-close') as HTMLButtonElement;
const needsInputBanner = document.getElementById('needs-input-banner')!;
const slashMenu = document.getElementById('slash-menu')!;
const mentionMenu = document.getElementById('mention-menu')!;
const agentIndicator = document.getElementById('agent-indicator')!;
const btnMode = document.getElementById('btn-mode') as HTMLButtonElement;
const activeFileChip = document.getElementById('active-file-chip')!;
const activeFileNameEl = document.getElementById('active-file-name')!;
const btnAfcToggle = document.getElementById('btn-afc-toggle') as HTMLButtonElement;
const btnAgentMode = document.getElementById('btn-agent-mode') as HTMLButtonElement;
const agentModePanel = document.getElementById('agent-mode-panel')!;
const btnTex = document.getElementById('btn-tex') as HTMLButtonElement;
const btnTranslate = document.getElementById('btn-translate') as HTMLButtonElement;
let sendActiveFile = true;
// 翻訳ON時、完了後に日本語へ置換する対象として最後のアシスタント吹き出しを保持する
let lastAssistantBubble: HTMLElement | null = null;
// 各生成の直前に届くモデル名。次に作るアシスタント吹き出しへバッジとして付与する。
let pendingModelName: string | null = null;
let modelBadgePending = false;

/** どのモデルが回答しているかを示す小さなバッジを吹き出し先頭に付ける。 */
function addModelBadge(bubble: HTMLElement, name: string): void {
  if (bubble.querySelector('.model-badge')) return;
  const badge = document.createElement('div');
  badge.className = 'model-badge';
  badge.textContent = name;
  bubble.insertBefore(badge, bubble.firstChild);
}

// ── State ─────────────────────────────────────────────────────────────────────
let attachedFiles: Array<{ name: string; content: string; type?: string; previewUrl?: string }> = [];
let currentAssistantBubble: HTMLElement | null = null;
let isAgentRunning = false;
let autoScroll = true;

// State machine for streaming <think>…</think> tag detection
type ThinkState = 'normal' | 'in_think';
let thinkState: ThinkState = 'normal';
let thinkTagBuffer = '';
let currentThinkContent: HTMLElement | null = null;

// Markdown rendering state
let currentTextBuffer = '';
let currentMdContainer: HTMLElement | null = null;
let mdRenderTimer: ReturnType<typeof setTimeout> | null = null;

// @mention menu state
let mentionResults: Array<{ path: string; name: string }> = [];
let mentionSelectedIndex = 0;

// ── Token ring ────────────────────────────────────────────────────────────────
const RING_CIRC = 2 * Math.PI * 11;

function updateTokenRing(used: number, max: number) {
  const pct = max > 0 ? Math.min(used / max, 1) : 0;
  ringArc.style.strokeDashoffset = String(RING_CIRC * (1 - pct));
  ringArc.style.stroke = pct < 0.7 ? '#4caf50' : pct < 0.9 ? '#ff9800' : '#f44336';

  const fmt = (n: number) =>
    n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  tokenLabel.textContent = `${fmt(used)} / ${fmt(max)}`;
  tokenWidget.title = `Context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${Math.round(pct * 100)}%) · Click to compact`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrollToBottom() {
  if (autoScroll) requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

messagesEl.addEventListener('scroll', () => {
  const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  autoScroll = distFromBottom < 60;
});

function setAgentRunning(running: boolean) {
  isAgentRunning = running;
  if (running) {
    actionBtn.disabled = true;
    actionBtn.classList.remove('stop-mode');
    actionBtn.textContent = '↑';
    agentIndicator.classList.remove('hidden');
    setTimeout(() => {
      if (isAgentRunning) {
        actionBtn.classList.add('stop-mode');
        actionBtn.textContent = '⏹';
        actionBtn.disabled = false;
      }
    }, 500);
  } else {
    actionBtn.classList.remove('stop-mode');
    actionBtn.textContent = '↑';
    actionBtn.disabled = false;
    agentIndicator.classList.add('hidden');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function appendUserMessage(
  text: string,
  chips?: Array<{ name: string; content: string; type?: string; previewUrl?: string }>
) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';

  const visible = (chips ?? []).filter(f => f.name);
  if (visible.length) {
    const row = document.createElement('div');
    row.className = 'msg-chip-row';
    visible.forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'msg-chip';
      if (f.type === 'image' && f.previewUrl) {
        const img = document.createElement('img');
        img.src = f.previewUrl;
        img.className = 'msg-chip-thumb';
        chip.appendChild(img);
        chip.appendChild(document.createTextNode(f.name));
      } else if (f.type === 'mention') {
        chip.innerHTML = `<span class="chip-at">@</span>${escapeHtml(f.name)}`;
      } else if (f.type === 'editor-selection') {
        chip.innerHTML = `✂ ${escapeHtml(f.name)}`;
      } else {
        chip.innerHTML = `📄 ${escapeHtml(f.name)}`;
      }
      row.appendChild(chip);
    });
    div.appendChild(row);
  }

  const textEl = document.createElement('div');
  textEl.textContent = text;
  div.appendChild(textEl);

  messagesEl.appendChild(div);
  scrollToBottom();
}

// ── Markdown rendering ────────────────────────────────────────────────────────

function getOrCreateMdContainer(): HTMLElement {
  if (!currentMdContainer) {
    currentMdContainer = document.createElement('div');
    currentMdContainer.className = 'md-content';
    currentAssistantBubble!.appendChild(currentMdContainer);
  }
  return currentMdContainer;
}

function addCopyButtons(container: HTMLElement) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const text = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-99px;left:-99px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
    pre.appendChild(btn);
  });
}

function scheduleMarkdownRender() {
  if (mdRenderTimer) clearTimeout(mdRenderTimer);
  mdRenderTimer = setTimeout(() => {
    mdRenderTimer = null;
    if (currentTextBuffer && currentMdContainer) {
      currentMdContainer.innerHTML = renderMarkdown(currentTextBuffer);
      addCopyButtons(currentMdContainer);
    }
  }, 50);
}

function flushMarkdown() {
  if (mdRenderTimer) { clearTimeout(mdRenderTimer); mdRenderTimer = null; }
  if (currentTextBuffer) {
    const container = getOrCreateMdContainer();
    mdSources.set(container, currentTextBuffer);
    renderMdContainer(container, currentTextBuffer);
  }
}

function renderAssistantMarkdown(bubble: HTMLElement, text: string) {
  const container = document.createElement('div');
  container.className = 'md-content';
  mdSources.set(container, text);
  renderMdContainer(container, text);
  bubble.appendChild(container);
}

function resetMarkdownState() {
  currentTextBuffer = '';
  currentMdContainer = null;
  if (mdRenderTimer) { clearTimeout(mdRenderTimer); mdRenderTimer = null; }
}

// ── Assistant message lifecycle ───────────────────────────────────────────────

function startAssistantMessage(): HTMLElement {
  // Reset think + markdown state for each new turn
  thinkState = 'normal';
  thinkTagBuffer = '';

  currentThinkContent = null;
  resetMarkdownState();

  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg-assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const loader = document.createElement('div');
  loader.className = 'loading-dots';
  loader.id = 'loading-indicator';
  loader.innerHTML = '<span></span><span></span><span></span>';
  bubble.appendChild(loader);
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  currentAssistantBubble = bubble;
  lastAssistantBubble = bubble;
  scrollToBottom();
  return bubble;
}

function clearLoadingIndicator() {
  document.getElementById('loading-indicator')?.remove();
}

// ── <think> tag streaming state machine ───────────────────────────────────────

function createThinkBlock(): HTMLElement {
  const details = document.createElement('details');
  details.className = 'think-block';
  details.open = true; // open during streaming so scroll tracks content
  const summary = document.createElement('summary');
  summary.className = 'think-summary';
  summary.textContent = 'Thinking…';
  const content = document.createElement('div');
  content.className = 'think-content';
  details.appendChild(summary);
  details.appendChild(content);
  // Append in stream order. Inserting at the top (old behavior) reordered the
  // chat: a thinking segment generated AFTER some text was displayed ABOVE it.
  // Thinking now always arrives first anyway (OllamaClient wraps the thinking
  // field in <think> and emits it before content).
  const bubble = currentAssistantBubble!;
  // Close any markdown text segment so post-thinking text starts a new
  // container below this block (otherwise it would render above it).
  flushMarkdown();
  currentTextBuffer = '';
  currentMdContainer = null;
  bubble.appendChild(details);
  return content;
}

function findTag(
  text: string,
  tag: string
): { complete: number } | { partial: number } | { none: true } {
  const idx = text.indexOf(tag);
  if (idx !== -1) return { complete: idx };
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) {
      return { partial: text.length - len };
    }
  }
  return { none: true };
}

function outputNormal(text: string) {
  if (!text) return;
  currentTextBuffer += text;
  getOrCreateMdContainer();
  scheduleMarkdownRender();
}

function outputThink(text: string) {
  if (!text || !currentThinkContent) return;
  const last = currentThinkContent.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) {
    last.textContent = (last.textContent ?? '') + text;
  } else {
    currentThinkContent.appendChild(document.createTextNode(text));
  }
}

function processChunk(chunk: string) {
  let text = thinkTagBuffer + chunk;
  thinkTagBuffer = '';

  while (text.length > 0) {
    if (thinkState === 'normal') {
      const r = findTag(text, '<think>');
      if ('complete' in r) {
        outputNormal(text.slice(0, r.complete));
        thinkState = 'in_think';
        currentThinkContent = createThinkBlock();
        text = text.slice(r.complete + '<think>'.length);
      } else if ('partial' in r) {
        outputNormal(text.slice(0, r.partial));
        thinkTagBuffer = text.slice(r.partial);
        break;
      } else {
        outputNormal(text);
        break;
      }
    } else {
      const r = findTag(text, '</think>');
      if ('complete' in r) {
        outputThink(text.slice(0, r.complete));
        thinkState = 'normal';
        currentThinkContent = null;
        text = text.slice(r.complete + '</think>'.length);
      } else if ('partial' in r) {
        outputThink(text.slice(0, r.partial));
        thinkTagBuffer = text.slice(r.partial);
        break;
      } else {
        outputThink(text);
        break;
      }
    }
  }
}

function appendText(text: string) {
  if (!currentAssistantBubble) startAssistantMessage();
  clearLoadingIndicator();
  if (modelBadgePending && pendingModelName && currentAssistantBubble) {
    addModelBadge(currentAssistantBubble, pendingModelName);
    modelBadgePending = false;
  }
  processChunk(text);
  scrollToBottom();
}

function appendToolCall(toolName: string, toolArgs: Record<string, unknown>, toolCallId?: string) {
  clearLoadingIndicator();
  flushMarkdown();
  if (currentAssistantBubble?.childNodes.length === 0) {
    currentAssistantBubble.parentElement?.remove();
  }
  // Defensive: reset think state so the next model turn starts clean
  thinkState = 'normal';
  thinkTagBuffer = '';

  currentThinkContent = null;
  resetMarkdownState();
  currentAssistantBubble = null;
  const div = document.createElement('div');
  div.className = 'tool-call';
  if (toolCallId) div.dataset['tcId'] = toolCallId;
  const header = document.createElement('div');
  header.className = 'tool-call-header';
  header.innerHTML =
    `<span class="tc-spinner"></span>` +
    `<span class="tool-name">${escapeHtml(toolName)}</span> ` +
    `<span>${escapeHtml(JSON.stringify(toolArgs, null, 2))}</span>`;
  div.appendChild(header);
  messagesEl.appendChild(div);
  scrollToBottom();
}

function appendToolResult(output: string, success: boolean, toolCallId?: string) {
  // Find by ID when available (parallel calls); fall back to last-child for legacy
  const target = toolCallId
    ? (messagesEl.querySelector(`[data-tc-id="${CSS.escape(toolCallId)}"]`) as HTMLElement | null)
    : (messagesEl.querySelector('.tool-call:last-child') as HTMLElement | null);
  if (target) {
    target.querySelector('.tc-spinner')?.remove();
    const result = document.createElement('div');
    result.className = `tool-result${success ? '' : ' error'}`;
    result.textContent = output.length > 400 ? output.slice(0, 400) + '…' : output;
    target.appendChild(result);
    scrollToBottom();
  }
}

function appendThinking(content: string) {
  clearLoadingIndicator();
  if (currentAssistantBubble?.childNodes.length === 0) {
    currentAssistantBubble.parentElement?.remove();
  }
  currentAssistantBubble = null;
  const div = document.createElement('div');
  div.className = 'thinking';
  div.id = 'thinking-indicator';
  div.textContent = content;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function removeThinking() { document.getElementById('thinking-indicator')?.remove(); }

/** 出力翻訳(EN→JP)はagentループ外で走るため、その間の無表示を防ぐスピナー。
 *  translateReplace 受信時・新規送信時・done/error時に除去する。 */
function showTranslating() {
  removeTranslating();
  const div = document.createElement('div');
  div.className = 'thinking';
  div.id = 'translating-indicator';
  div.textContent = '日本語へ翻訳中…';
  messagesEl.appendChild(div);
  scrollToBottom();
}
function removeTranslating() { document.getElementById('translating-indicator')?.remove(); }

/** 翻訳ON時、実際にLLMへ送った英文(または英訳失敗の警告)を会話に小さく表示する。 */
function appendXlateNote(text: string, warn = false): void {
  const div = document.createElement('div');
  div.className = warn ? 'xlate-note xlate-note-warn' : 'xlate-note';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

/** Shows the spinner while waiting for the next LLM generation to start
 *  (after sending a message, a tool result, or an approval). Removed
 *  automatically when the first text/tool_call/done event arrives. */
function showWaiting(label = 'Waiting for LLM response…') {
  if (!isAgentRunning) return;
  removeThinking();
  appendThinking(label);
}

// ── Diff helpers (for permission dialog) ─────────────────────────────────────

function buildDiffHtml(diff: string): string {
  return diff.split('\n').map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('-')) return `<span class="diff-del">${escaped}</span>`;
    if (line.startsWith('+')) return `<span class="diff-add">${escaped}</span>`;
    return `<span class="diff-ctx">${escaped}</span>`;
  }).join('');
}

// ── Plan approval request ─────────────────────────────────────────────────────

function showApprovalRequest(planText: string, cycle?: number) {
  document.getElementById('active-approval-request')?.remove();

  const block = document.createElement('div');
  block.className = 'plan-approval';
  block.id = 'active-approval-request';

  const body = document.createElement('div');
  body.className = 'plan-approval-body';

  const cycleLabel = cycle && cycle > 1 ? ` (cycle ${cycle} — fixing errors)` : '';
  const title = document.createElement('div');
  title.className = 'plan-approval-title';
  title.textContent = `📋 Execution Plan${cycleLabel}`;
  body.appendChild(title);

  const steps = document.createElement('div');
  steps.className = 'plan-approval-steps md-content';
  if (planText.trim()) {
    steps.innerHTML = renderMarkdown(planText);
  } else {
    steps.textContent = '(no steps — plan generation failed)';
    steps.style.opacity = '0.5';
  }
  body.appendChild(steps);

  const btns = document.createElement('div');
  btns.className = 'plan-approval-buttons';

  const respond = (approved: boolean) => {
    btns.remove();
    const result = document.createElement('div');
    result.className = 'plan-approval-result';
    result.textContent = approved ? '✓ Approved — executing...' : '✕ Cancelled';
    body.appendChild(result);
    block.id = '';
    vscode.postMessage({ type: 'approvalResponse', approved });
    if (approved) showWaiting();
  };

  const mkBtn = (label: string, cls: string, approved: boolean) => {
    const b = document.createElement('button');
    b.className = `plan-approval-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => respond(approved));
    return b;
  };

  btns.appendChild(mkBtn('Approve', 'plan-approval-btn-ok', true));
  btns.appendChild(mkBtn('Cancel',  'plan-approval-btn-cancel', false));
  body.appendChild(btns);
  block.appendChild(body);
  messagesEl.appendChild(block);
  scrollToBottom();
}

// ── Permission request ────────────────────────────────────────────────────────

function showPermissionRequest(toolName: string, description: string, diff?: string) {
  document.getElementById('active-permission-request')?.remove();

  const block = document.createElement('div');
  block.className = 'permission-request';
  block.id = 'active-permission-request';

  const body = document.createElement('div');
  body.className = 'perm-req-body';
  body.innerHTML =
    `<div class="perm-req-title">🔑 Permission Request</div>` +
    `<div class="perm-req-desc">${escapeHtml(description)}</div>`;

  if (diff) {
    const PREVIEW_LINES = 8;
    const allLines = diff.split('\n');

    const diffWrap = document.createElement('div');
    diffWrap.className = 'perm-diff-wrap';

    const diffLabel = document.createElement('div');
    diffLabel.className = 'perm-diff-label';
    diffLabel.textContent = 'Changes';

    const diffPre = document.createElement('pre');
    diffPre.className = 'perm-diff-pre';
    diffPre.innerHTML = buildDiffHtml(
      allLines.length > PREVIEW_LINES
        ? allLines.slice(0, PREVIEW_LINES).join('\n')
        : diff
    );

    diffWrap.appendChild(diffLabel);
    diffWrap.appendChild(diffPre);

    if (allLines.length > PREVIEW_LINES) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'diff-expand-btn';
      expandBtn.textContent = `▼  ${allLines.length - PREVIEW_LINES} more lines`;
      expandBtn.addEventListener('click', () => {
        diffPre.innerHTML = buildDiffHtml(diff);
        expandBtn.remove();
      });
      diffWrap.appendChild(expandBtn);
    }

    body.appendChild(diffWrap);
  }

  const btns = document.createElement('div');
  btns.className = 'perm-req-buttons';

  const respond = (allowed: boolean, remember: boolean) => {
    btns.remove();
    const result = document.createElement('div');
    result.className = 'perm-req-result';
    result.textContent = allowed
      ? (remember ? '✓ Allowed (this session)' : '✓ Allowed once')
      : '✕ Denied';
    body.appendChild(result);
    block.id = '';
    vscode.postMessage({ type: 'permissionResponse', allowed, remember, toolName });
    if (allowed) showWaiting('Running tool…');
  };

  const mkBtn = (label: string, cls: string, allowed: boolean, remember: boolean) => {
    const b = document.createElement('button');
    b.className = `perm-req-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => respond(allowed, remember));
    return b;
  };

  btns.appendChild(mkBtn('Yes (once)',           'perm-req-btn-yes',    true,  false));
  btns.appendChild(mkBtn('Always Yes (session)', 'perm-req-btn-always', true,  true));
  btns.appendChild(mkBtn('No',                   'perm-req-btn-no',     false, false));

  body.appendChild(btns);
  block.appendChild(body);
  messagesEl.appendChild(block);
  currentAssistantBubble = null;
  scrollToBottom();
}

function autoResizeInput() {
  inputEl.style.height = '2px';
  const maxH = Math.min(Math.floor(window.innerHeight * 0.45), 250);
  inputEl.style.height = Math.min(inputEl.scrollHeight, maxH) + 'px';
}

function clearChatUI() {
  messagesEl.innerHTML = '';
  mdSources.clear();
  currentAssistantBubble = null;
  lastAssistantBubble = null;
  pendingModelName = null;
  modelBadgePending = false;
  thinkState = 'normal';
  thinkTagBuffer = '';

  currentThinkContent = null;
  resetMarkdownState();
  setAgentRunning(false);
  needsInputBanner.classList.add('hidden');
}

// ── File attachment ───────────────────────────────────────────────────────────
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

function addFile(file: File) {
  if (IMAGE_TYPES.has(file.type)) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] ?? '';
      attachedFiles.push({ name: file.name, content: base64, type: 'image', previewUrl: dataUrl });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      attachedFiles.push({ name: file.name, content: reader.result as string, type: 'text' });
      renderAttachments();
    };
    reader.readAsText(file);
  }
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  attachedFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    if (f.type === 'image') {
      const imgSrc = f.previewUrl ?? `data:image/png;base64,${f.content}`;
      chip.innerHTML = `<img src="${imgSrc}" alt="${escapeHtml(f.name)}" /> ${escapeHtml(f.name)} <button title="Remove">✕</button>`;
    } else if (f.type === 'mention') {
      chip.innerHTML = `<span class="chip-at">@</span>${escapeHtml(f.name)} <button title="Remove">✕</button>`;
    } else if (f.type === 'editor-selection') {
      chip.innerHTML = `<span class="chip-sel">✂</span>${escapeHtml(f.name)} <button title="Remove">✕</button>`;
    } else {
      chip.innerHTML = `📄 ${escapeHtml(f.name)} <button title="Remove">✕</button>`;
    }
    chip.querySelector('button')!.addEventListener('click', () => {
      attachedFiles.splice(i, 1);
      renderAttachments();
    });
    attachmentsEl.appendChild(chip);
  });
}

// ── @mention menu ─────────────────────────────────────────────────────────────

function getAtQuery(): string | null {
  const val = inputEl.value;
  const pos = inputEl.selectionStart ?? val.length;
  const before = val.slice(0, pos);
  const m = before.match(/@([^\s@]*)$/);
  return m ? m[1] : null;
}

function hideMentionMenu() {
  mentionMenu.classList.add('hidden');
  mentionResults = [];
}

function renderMentionMenu() {
  mentionMenu.innerHTML = '';
  if (mentionResults.length === 0) { mentionMenu.classList.add('hidden'); return; }
  mentionSelectedIndex = Math.min(mentionSelectedIndex, mentionResults.length - 1);
  mentionMenu.classList.remove('hidden');
  mentionResults.forEach((file, i) => {
    const el = document.createElement('div');
    el.className = 'mention-item' + (i === mentionSelectedIndex ? ' selected' : '');
    el.innerHTML =
      `<span class="mention-filename">${escapeHtml(file.name)}</span>` +
      `<span class="mention-path">${escapeHtml(file.path)}</span>`;
    el.addEventListener('mousedown', (e) => { e.preventDefault(); selectMention(file); });
    mentionMenu.appendChild(el);
  });
}

function selectMention(file: { path: string; name: string }) {
  const val = inputEl.value;
  const pos = inputEl.selectionStart ?? val.length;
  const before = val.slice(0, pos);
  const newBefore = before.replace(/@([^\s@]*)$/, '');
  inputEl.value = newBefore + val.slice(pos);
  inputEl.setSelectionRange(newBefore.length, newBefore.length);
  attachedFiles.push({ name: file.path, content: '', type: 'mention' });
  renderAttachments();
  hideMentionMenu();
  autoResizeInput();
  inputEl.focus();
}

function updateMentionMenu() {
  const query = getAtQuery();
  if (query === null) { hideMentionMenu(); return; }
  vscode.postMessage({ type: 'searchFiles', query });
}

window.addEventListener('resize', () => autoResizeInput());

// ── Slash command menu ────────────────────────────────────────────────────────
interface SlashItem {
  cmd: string;
  desc: string;
  badge?: string;
  action?: () => void;
  prompt?: string;
}

function sendSlashPrompt(text: string) {
  inputEl.value = text;
  sendMessage();
}

const BUILTIN_SKILLS: SlashItem[] = [
  { cmd: '/compact',     desc: 'Summarize and compress conversation history',    badge: 'built-in', action: () => { tokenLabel.textContent = '…'; vscode.postMessage({ type: 'triggerCompaction' }); } },
  { cmd: '/new',         desc: 'Start a new session (saves current to history)', badge: 'built-in', action: () => newBtn.click() },
  { cmd: '/history',     desc: 'Open session history panel',                     badge: 'built-in', action: () => openHistoryPanel() },
  { cmd: '/rag',         desc: 'Re-index RAG paths',                             badge: 'built-in', action: () => vscode.postMessage({ type: 'reindexRag' }) },
  { cmd: '/help',        desc: 'Show available commands',                        badge: 'built-in', action: () => showHelpMessage() },
  { cmd: '/init',        desc: 'Generate LOCAL_LLM.md project instructions file', badge: 'built-in', action: () => sendSlashPrompt(
    'Create a LOCAL_LLM.md file in the workspace root for this project. ' +
    'First use glob_search to explore the directory structure, then read key files like package.json, README.md, tsconfig.json, and any main entry points to understand the project. ' +
    'Write LOCAL_LLM.md with these sections: (1) Project overview and purpose, (2) Key directories and what they contain, (3) Build/run/test commands, (4) Tech stack and dependencies, (5) Coding conventions or patterns the AI should follow. ' +
    'Keep it concise and focus on what is actionable for an AI assistant working on this project.'
  ) },
  // Git commands — these execute immediately
  { cmd: '/git:status',  desc: 'Show git status and uncommitted changes',        badge: 'git',      action: () => sendSlashPrompt('Show the current git status including staged, unstaged, and untracked files. Use the run_terminal tool.') },
  { cmd: '/git:diff',    desc: 'Show staged and unstaged diff',                  badge: 'git',      action: () => sendSlashPrompt('Show the current git diff — both staged and unstaged changes. Use the run_terminal tool.') },
  { cmd: '/git:log',     desc: 'Show recent commit history',                     badge: 'git',      action: () => sendSlashPrompt('Show the last 10 git commits with author, date, and message. Use the run_terminal tool.') },
  { cmd: '/git:commit',  desc: 'Review changes and commit',                      badge: 'git',      action: () => sendSlashPrompt('Review the current staged changes and create an appropriate git commit with a descriptive message. Use the run_terminal tool.') },
  { cmd: '/git:branch',  desc: 'List all branches',                              badge: 'git',      action: () => sendSlashPrompt('List all git branches and show which one is currently checked out. Use the run_terminal tool.') },
  { cmd: '/git:stash',   desc: 'Stash or pop uncommitted changes',               badge: 'git',      action: () => sendSlashPrompt('Show current stash list and help me stash or pop changes as needed. Use the run_terminal tool.') },
];

let allSlashItems: SlashItem[] = [...BUILTIN_SKILLS];
let slashSelectedIndex = 0;
let currentSlashFiltered: SlashItem[] = [];

function updateSlashMenu() {
  const val = inputEl.value;
  if (!val.startsWith('/') || val.includes(' ')) {
    slashMenu.classList.add('hidden');
    return;
  }
  const query = val.toLowerCase();
  currentSlashFiltered = allSlashItems.filter(item => item.cmd.startsWith(query));
  renderSlashMenu();
}

function renderSlashMenu() {
  slashMenu.innerHTML = '';
  if (currentSlashFiltered.length === 0) {
    slashMenu.classList.add('hidden');
    return;
  }
  slashSelectedIndex = Math.min(slashSelectedIndex, currentSlashFiltered.length - 1);
  slashMenu.classList.remove('hidden');

  currentSlashFiltered.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'slash-item' + (i === slashSelectedIndex ? ' selected' : '');
    el.innerHTML =
      `<span class="slash-cmd">${escapeHtml(item.cmd)}</span>` +
      `<span class="slash-desc">${escapeHtml(item.desc)}</span>` +
      (item.badge ? `<span class="slash-badge">${escapeHtml(item.badge)}</span>` : '');
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      executeSlashItem(item);
    });
    slashMenu.appendChild(el);
  });
}

function executeSlashItem(item: SlashItem) {
  inputEl.value = '';
  autoResizeInput();
  slashMenu.classList.add('hidden');
  if (item.action) {
    item.action();
    return;
  }
  if (item.prompt !== undefined) {
    inputEl.value = item.prompt;
    autoResizeInput();
    inputEl.focus();
  }
}

function showHelpMessage() {
  const bubble = startAssistantMessage();
  const lines = allSlashItems
    .map(i => `\`${i.cmd}\` — ${i.desc}${i.badge ? ` _(${i.badge})_` : ''}`)
    .join('\n\n');
  renderAssistantMarkdown(bubble, `**Available commands:**\n\n${lines}`);
  currentAssistantBubble = null;
  scrollToBottom();
}

// ── Session history ───────────────────────────────────────────────────────────
interface SessionSummary {
  id: string;
  timestamp: number;
  preview: string;
  messageCount: number;
}

function openHistoryPanel() {
  historyPanel.classList.remove('hidden');
  historyBtn.classList.add('active');
  vscode.postMessage({ type: 'getHistory' });
}

function closeHistoryPanel() {
  historyPanel.classList.add('hidden');
  historyBtn.classList.remove('active');
}

function renderSessions(sessions: SessionSummary[]) {
  historyList.querySelectorAll('.session-card').forEach(c => c.remove());
  if (sessions.length === 0) {
    historyEmpty.classList.remove('hidden');
    return;
  }
  historyEmpty.classList.add('hidden');
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    const time = new Date(s.timestamp).toLocaleString();
    card.innerHTML = `
      <div class="session-time">${escapeHtml(time)}</div>
      <div class="session-preview">${escapeHtml(s.preview)}</div>
      <div class="session-count">${s.messageCount} messages</div>
      <div class="session-actions">
        <button class="btn-load">Load</button>
        <button class="btn-delete">Delete</button>
      </div>`;
    card.querySelector('.btn-load')!.addEventListener('click', () => {
      vscode.postMessage({ type: 'loadSession', id: s.id });
      closeHistoryPanel();
    });
    card.querySelector('.btn-delete')!.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteSession', id: s.id });
      card.remove();
      if (historyList.querySelectorAll('.session-card').length === 0) {
        historyEmpty.classList.remove('hidden');
      }
    });
    historyList.appendChild(card);
  }
}

// ── Send message ──────────────────────────────────────────────────────────────
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isAgentRunning) return;

  autoScroll = true;
  closeHistoryPanel();
  removeTranslating();

  const snapshotFiles = [...attachedFiles];
  appendUserMessage(text, snapshotFiles);

  inputEl.value = '';
  autoResizeInput();
  slashMenu.classList.add('hidden');
  hideMentionMenu();

  setAgentRunning(true);
  startAssistantMessage();

  const mentions = attachedFiles.filter(f => f.type === 'mention').map(f => f.name);
  const attachments = attachedFiles.filter(f => f.type !== 'mention');

  vscode.postMessage({ type: 'sendMessage', text, model: modelSelect.value, attachments, mentions });
  attachedFiles = [];
  renderAttachments();
  showWaiting();
}

// ── Event listeners ───────────────────────────────────────────────────────────
actionBtn.addEventListener('click', () => {
  if (actionBtn.classList.contains('stop-mode')) {
    vscode.postMessage({ type: 'stopAgent' });
  } else {
    sendMessage();
  }
});

btnSlash.addEventListener('click', () => {
  if (!inputEl.value) {
    inputEl.value = '/';
    autoResizeInput();
  }
  inputEl.focus();
  slashSelectedIndex = 0;
  updateSlashMenu();
});

inputEl.addEventListener('keydown', (e) => {
  const slashOpen = !slashMenu.classList.contains('hidden');
  const mentionOpen = !mentionMenu.classList.contains('hidden');

  // Mention menu navigation takes priority
  if (mentionOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionSelectedIndex = Math.min(mentionSelectedIndex + 1, mentionResults.length - 1);
      renderMentionMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionSelectedIndex = Math.max(mentionSelectedIndex - 1, 0);
      renderMentionMenu();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && mentionResults[mentionSelectedIndex]) {
      e.preventDefault();
      selectMention(mentionResults[mentionSelectedIndex]);
      return;
    }
    if (e.key === 'Escape') { hideMentionMenu(); return; }
  }

  if (e.key === 'ArrowDown' && slashOpen) {
    e.preventDefault();
    slashSelectedIndex = Math.min(slashSelectedIndex + 1, currentSlashFiltered.length - 1);
    renderSlashMenu();
    return;
  }
  if (e.key === 'ArrowUp' && slashOpen) {
    e.preventDefault();
    slashSelectedIndex = Math.max(slashSelectedIndex - 1, 0);
    renderSlashMenu();
    return;
  }
  if (e.key === 'Escape' && slashOpen) {
    slashMenu.classList.add('hidden');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (slashOpen && currentSlashFiltered[slashSelectedIndex]) {
      executeSlashItem(currentSlashFiltered[slashSelectedIndex]);
    } else {
      sendMessage();
    }
    return;
  }
  autoResizeInput();
});

inputEl.addEventListener('input', () => {
  autoResizeInput();
  slashSelectedIndex = 0;
  updateSlashMenu();
  updateMentionMenu();
});

inputEl.addEventListener('blur', () => {
  setTimeout(() => {
    // Only hide if the input hasn't regained focus (e.g. after clicking btnSlash)
    if (document.activeElement !== inputEl) {
      slashMenu.classList.add('hidden');
      hideMentionMenu();
    }
  }, 150);
});

newBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'newSession' });
  clearChatUI();
});

historyBtn.addEventListener('click', () => {
  historyPanel.classList.contains('hidden') ? openHistoryPanel() : closeHistoryPanel();
});

btnAfcToggle.addEventListener('click', () => {
  sendActiveFile = !sendActiveFile;
  btnAfcToggle.classList.toggle('inactive', !sendActiveFile);
  btnAfcToggle.title = sendActiveFile
    ? 'Active file: included in context (click to exclude)'
    : 'Active file: excluded from context (click to include)';
  vscode.postMessage({ type: 'toggleActiveFile', enabled: sendActiveFile });
});
historyCloseBtn.addEventListener('click', closeHistoryPanel);

tokenWidget.addEventListener('click', () => {
  if (isAgentRunning) return;
  tokenLabel.textContent = '…';
  vscode.postMessage({ type: 'triggerCompaction' });
});

settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

const modePanel = document.getElementById('mode-panel')!;

const MODE_META: Record<string, { label: string; title: string; cls?: string }> = {
  ask:  { label: '🔒 Ask',  title: 'Ask mode: approval required before each edit' },
  edit: { label: '✏ Edit', title: 'Edit mode: file edits applied automatically' },
  plan: { label: '≡ Plan',  title: 'Plan mode: outputs a plan instead of applying edits' },
  auto: { label: '⚡ Auto', title: 'Auto mode: all operations apply automatically', cls: 'mode-auto' },
};

function openModePanel() {
  agentModePanel.classList.add('hidden');
  modePanel.classList.remove('hidden');
  document.addEventListener('click', closeModePanel, { capture: true, once: true });
}

function closeModePanel() {
  modePanel.classList.add('hidden');
}

btnMode.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modePanel.classList.contains('hidden')) {
    openModePanel();
  } else {
    closeModePanel();
  }
});

modePanel.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.mode-option');
  if (!opt) return;
  const mode = opt.dataset['mode'];
  if (mode) {
    vscode.postMessage({ type: 'setEditMode', mode });
    closeModePanel();
  }
});

function applyEditMode(mode: string) {
  const meta = MODE_META[mode] ?? MODE_META['ask'];
  btnMode.dataset['mode'] = mode;
  btnMode.textContent = meta.label;
  btnMode.title = meta.title;
  Object.values(MODE_META).forEach(m => { if (m.cls) btnMode.classList.remove(m.cls); });
  if (meta.cls) btnMode.classList.add(meta.cls);
  modePanel.querySelectorAll<HTMLElement>('.mode-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset['mode'] === mode);
  });
}

// ── Agent mode panel ──────────────────────────────────────────────────────────
const AGENT_MODE_META: Record<string, { label: string; title: string }> = {
  standard:        { label: 'Agent: Loop',   title: 'Agent Loop: autonomous tool use, up to 20 turns' },
  'repo-map-plan': { label: 'Agent: Plan',   title: 'Plan mode: scan repo → create plan → execute once' },
  'repo-map-loop': { label: 'Agent: Loop+',  title: 'Plan Loop: plan + automatic PDCA retry (5 cycles)' },
  react:           { label: 'Agent: ReAct',  title: 'ReAct: Thought/Action/Observation text pattern' },
  debug:           { label: 'Agent: Debug',  title: 'Debug: 3-phase Localize → Repair → Validate' },
  chat:            { label: 'Chat',          title: 'Chat: 会話・質問専用。ツールなし、シンプルなQ&A' },
  auto:            { label: 'Auto',          title: 'Auto: メッセージ内容からモードを自動判定して実行' },
};

function openAgentModePanel() {
  modePanel.classList.add('hidden');
  agentModePanel.classList.remove('hidden');
  document.addEventListener('click', closeAgentModePanel, { capture: true, once: true });
}

function closeAgentModePanel() {
  agentModePanel.classList.add('hidden');
}

btnAgentMode.addEventListener('click', (e) => {
  e.stopPropagation();
  if (agentModePanel.classList.contains('hidden')) {
    openAgentModePanel();
  } else {
    closeAgentModePanel();
  }
});

agentModePanel.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.agent-mode-option');
  if (!opt) return;
  const amode = opt.dataset['amode'];
  if (amode) {
    vscode.postMessage({ type: 'setAgentMode', mode: amode });
    closeAgentModePanel();
  }
});

function applyAgentMode(mode: string) {
  const meta = AGENT_MODE_META[mode] ?? AGENT_MODE_META['standard'];
  btnAgentMode.textContent = meta.label;
  btnAgentMode.title = meta.title;
  agentModePanel.querySelectorAll<HTMLElement>('.agent-mode-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset['amode'] === mode);
  });
}

modelSelect.addEventListener('change', () =>
  vscode.postMessage({ type: 'setModel', model: modelSelect.value })
);

// ── TeX⇔プレーン表示トグル ────────────────────────────────────────────────
// 会話履歴(LLMに渡る内容)は変えず、確定済みメッセージを元テキストから
// 再レンダリングして見た目だけを切り替える。
function setTexRender(on: boolean): void {
  texRender = on;
  const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
  vscode.setState({ ...prev, texRender: on });
  btnTex.classList.toggle('tex-on', on);
  btnTex.classList.toggle('tex-off', !on);
  btnTex.title = on
    ? '数式表示: TeXレンダリング中 (クリックでプレーン表示)'
    : '数式表示: プレーン (クリックでTeXレンダリング)';
  for (const [el, src] of mdSources) {
    if (el.isConnected) renderMdContainer(el, src);
  }
}
btnTex.addEventListener('click', () => setTexRender(!texRender));
setTexRender(texRender);

// ── 翻訳トグル(日本語入力⇔英語処理) ───────────────────────────────────────────
// 状態の真実は拡張側(globalStateで永続化)。ここはUI反映と送信のみを担う。
let translateMode = false;
function applyTranslateUI(on: boolean): void {
  btnTranslate.classList.toggle('translate-on', on);
  btnTranslate.classList.toggle('translate-off', !on);
  btnTranslate.title = on
    ? '翻訳: ON — 日本語入力→英語でLLM処理→日本語表示 (クリックでOFF)'
    : '翻訳: OFF (クリックで 日本語入力⇔英語処理 を有効化)';
}
btnTranslate.addEventListener('click', () => {
  translateMode = !translateMode;
  applyTranslateUI(translateMode);
  vscode.postMessage({ type: 'setTranslateMode', enabled: translateMode });
});
applyTranslateUI(translateMode);

// 完了後に届く日本語訳で、最後のアシスタント吹き出しの本文を置換する。
function replaceLastAssistantWithTranslation(text: string): void {
  const bubble = lastAssistantBubble;
  if (!bubble || !bubble.isConnected) return;
  // モデルバッジは翻訳後も残す(どのモデルが回答したかは置換後も知りたい)。
  const modelName = bubble.querySelector('.model-badge')?.textContent ?? null;
  // 既存の本文・思考ブロックを除去し、日本語の本文だけを描画し直す。
  for (const child of Array.from(bubble.childNodes)) {
    if (child instanceof HTMLElement) mdSources.delete(child);
    bubble.removeChild(child);
  }
  if (modelName) addModelBadge(bubble, modelName);
  renderAssistantMarkdown(bubble, text);
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files ?? []).forEach(addFile);
  fileInput.value = '';
});

// ── ドラッグ&ドロップ / クリップボード貼り付けによる添付 ──────────────

function dtHasAttachables(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).some(
    (t) => t === 'Files' || t === 'text/uri-list' || t === 'application/vnd.code.uri-list'
  );
}

function handleDataTransfer(dt: DataTransfer | null): void {
  if (!dt) return;
  const files = Array.from(dt.files ?? []);
  if (files.length > 0) {
    files.forEach(addFile);
    return;
  }
  // VSCodeエクスプローラ等からのドラッグはFileオブジェクトを持たず
  // file:// のURIリストだけが来る。中身の読み込みは拡張側に依頼する。
  const uriList = dt.getData('text/uri-list') || dt.getData('application/vnd.code.uri-list');
  const uris = uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (uris.length > 0) vscode.postMessage({ type: 'attachPaths', uris });
}

// パネル全体をドロップターゲットにする(視覚ハイライトは入力欄に表示)。
// テキスト選択のドラッグ等、添付対象がないものはデフォルト動作に任せる。
document.addEventListener('dragover', (e) => {
  if (!dtHasAttachables(e.dataTransfer)) return;
  e.preventDefault();
  inputArea.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) inputArea.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  inputArea.classList.remove('dragover');
  if (!dtHasAttachables(e.dataTransfer)) return;
  e.preventDefault();
  handleDataTransfer(e.dataTransfer);
});

// クリップボードからの貼り付け(スクリーンショット画像・コピーしたファイル)。
// ファイルを含まない通常のテキスト貼り付けはそのまま既定動作に任せる。
inputEl.addEventListener('paste', (e: ClipboardEvent) => {
  const fileItems = Array.from(e.clipboardData?.items ?? []).filter((it) => it.kind === 'file');
  if (fileItems.length === 0) return;
  e.preventDefault();
  fileItems.forEach((it, i) => {
    const f = it.getAsFile();
    if (!f) return;
    // スクリーンショットは一律 "image.png" 名で来るため一意な名前を付ける
    const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
    const name = f.name && f.name !== 'image.png'
      ? f.name
      : `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}-${i}.${ext}`;
    addFile(new File([f], name, { type: f.type }));
  });
});


// ── Messages from extension ───────────────────────────────────────────────────
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as Record<string, unknown>;

  switch (msg['type']) {
    case 'agentEvent': {
      const ev = msg['event'] as Record<string, unknown>;
      switch (ev['type']) {
        case 'text':
          removeThinking();
          appendText(ev['content'] as string);
          break;
        case 'model':
          // 次の生成のモデル名。最初の text 吹き出しにバッジとして付ける。
          pendingModelName = ev['content'] as string;
          modelBadgePending = true;
          break;
        case 'thinking':
          removeThinking();
          if (ev['content']) appendThinking(ev['content'] as string);
          break;
        case 'tool_call':
          removeThinking();
          appendToolCall(
            ev['toolName'] as string,
            ev['toolArgs'] as Record<string, unknown>,
            ev['toolCallId'] as string | undefined
          );
          break;
        case 'tool_result':
          appendToolResult(
            ev['content'] as string,
            ev['success'] as boolean,
            ev['toolCallId'] as string | undefined
          );
          // The next LLM generation starts after tool results — show the
          // spinner during that wait
          showWaiting();
          break;
        case 'needs_approval': {
          const a = ev as { content: string; cycle?: number };
          removeThinking();
          flushMarkdown();
          clearLoadingIndicator();
          // Force new bubble after the approval block so execution thinking appears below
          thinkState = 'normal';
          thinkTagBuffer = '';
        
          currentThinkContent = null;
          resetMarkdownState();
          currentAssistantBubble = null;
          showApprovalRequest(a.content, a.cycle);
          break;
        }
        case 'needs_permission': {
          const p = ev as { toolName: string; description: string; diff?: string };
          removeThinking();
          flushMarkdown();
          clearLoadingIndicator();
          if (currentAssistantBubble?.childNodes.length === 0) {
            currentAssistantBubble.parentElement?.remove();
          }
          showPermissionRequest(p.toolName, p.description, p.diff);
          break;
        }
        case 'needs_input':
          removeThinking();
          needsInputBanner.classList.remove('hidden');
          break;
        case 'input_done':
          needsInputBanner.classList.add('hidden');
          break;
        case 'phase_banner': {
          // End the current bubble so LLM output starts fresh, then render a styled separator
          removeThinking();
          flushMarkdown();
          clearLoadingIndicator();
          if (currentAssistantBubble?.childNodes.length === 0) {
            currentAssistantBubble.parentElement?.remove();
          }
          thinkState = 'normal';
          thinkTagBuffer = '';
          currentThinkContent = null;
          resetMarkdownState();
          currentAssistantBubble = null;
          const bannerDiv = document.createElement('div');
          bannerDiv.className = 'phase-banner md-content';
          bannerDiv.innerHTML = renderMarkdown(ev['content'] as string);
          messagesEl.appendChild(bannerDiv);
          scrollToBottom();
          // A banner means a fresh LLM generation is about to start — keep the
          // spinner up until its first token arrives.
          showWaiting();
          break;
        }
        case 'done':
        case 'error':
          removeThinking();
          if (ev['type'] === 'error') removeTranslating();
          clearLoadingIndicator();
          flushMarkdown();
          needsInputBanner.classList.add('hidden');
          // Reset think state BEFORE appending error so it doesn't land in the think block
          thinkState = 'normal';
          thinkTagBuffer = '';
          currentThinkContent = null;
          resetMarkdownState();
          if (ev['type'] === 'error') {
            const errMsg = ev['content'] as string ?? '';
            // Suppress abort/terminate errors — they come from the Stop button
            if (!/abort|terminat/i.test(errMsg)) {
              appendText(`⚠ ${errMsg}`);
              flushMarkdown();
            }
          }
          if (currentAssistantBubble?.childNodes.length === 0) {
            currentAssistantBubble.parentElement?.remove();
          }
          setAgentRunning(false);
          currentAssistantBubble = null;
          break;
      }
      break;
    }

    case 'clearMessages':
      clearChatUI();
      break;

    case 'showHistory':
      renderSessions(msg['sessions'] as SessionSummary[]);
      break;

    case 'sessionLoaded': {
      const messages = msg['messages'] as Array<{ role: string; content: string }>;
      clearChatUI();
      for (const m of messages) {
        if (m.role === 'user') {
          appendUserMessage(m.content);
        } else if (m.role === 'assistant') {
          const bubble = startAssistantMessage();
          renderAssistantMarkdown(bubble, m.content);
          currentAssistantBubble = null;
          resetMarkdownState();
        }
      }
      break;
    }

    case 'setSkills': {
      const skills = msg['skills'] as Array<{ command: string; description: string; prompt: string }>;
      allSlashItems = [
        ...BUILTIN_SKILLS,
        ...skills.map(s => ({
          cmd: `/${s.command}`,
          desc: s.description,
          badge: 'skill',
          action: () => sendSlashPrompt(s.prompt),
        })),
      ];
      break;
    }

    case 'updateModels': {
      const models = msg['models'] as string[];
      const current = modelSelect.value;
      modelSelect.innerHTML = '';
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = opt.textContent = m;
        if (m === current) opt.selected = true;
        modelSelect.appendChild(opt);
      });
      break;
    }

    case 'editMode':
      applyEditMode(msg['mode'] as string);
      break;

    case 'agentMode':
      applyAgentMode(msg['mode'] as string);
      break;

    case 'translateMode':
      translateMode = msg['enabled'] === true;
      applyTranslateUI(translateMode);
      break;

    case 'translatedInput': {
      const w = msg['warn'] as string | undefined;
      if (w) appendXlateNote('⚠ ' + w, true);
      else appendXlateNote('🌐 → EN: ' + (msg['text'] as string));
      break;
    }

    case 'translating':
      showTranslating();
      break;

    case 'translateReplace':
      removeTranslating();
      replaceLastAssistantWithTranslation(msg['text'] as string);
      break;

    case 'activeFile': {
      const filePath = msg['path'] as string | null;
      if (filePath) {
        const name = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
        activeFileNameEl.textContent = name;
        activeFileChip.title = filePath;
        activeFileChip.classList.remove('hidden');
      } else {
        activeFileChip.classList.add('hidden');
      }
      break;
    }

    case 'setDefaultModel': {
      const model = msg['model'] as string;
      const opt = modelSelect.querySelector<HTMLOptionElement>(`option[value="${model}"]`);
      if (opt) opt.selected = true;
      break;
    }

    case 'updateTokens':
      updateTokenRing(msg['used'] as number, msg['max'] as number);
      break;

    case 'fileResults': {
      const results = msg['results'] as Array<{ path: string; name: string }>;
      if (getAtQuery() !== null) {
        mentionResults = results;
        renderMentionMenu();
      }
      break;
    }

    case 'attachedFile': {
      // 拡張側がfile:// URIドロップ(attachPaths)を読み込んで返した添付
      const f = msg as { name?: string; content?: string; fileType?: string };
      if (typeof f.name !== 'string' || typeof f.content !== 'string') break;
      if (f.fileType === 'image') {
        attachedFiles.push({
          name: f.name, content: f.content, type: 'image',
          previewUrl: `data:image/png;base64,${f.content}`,
        });
      } else {
        attachedFiles.push({ name: f.name, content: f.content, type: 'text' });
      }
      renderAttachments();
      break;
    }

    case 'editorContext': {
      const ctx = msg['context'] as {
        text: string; fileName: string;
        lineStart: number; lineEnd: number; language: string;
      } | null;
      const existingIdx = attachedFiles.findIndex(f => f.type === 'editor-selection');
      if (ctx && ctx.text.trim().length > 0) {
        const chipName = `${ctx.fileName}:${ctx.lineStart}-${ctx.lineEnd}`;
        const chipContent = `\`\`\`${ctx.language}\n${ctx.text}\n\`\`\``;
        if (existingIdx >= 0) {
          attachedFiles[existingIdx] = { name: chipName, content: chipContent, type: 'editor-selection' };
        } else {
          attachedFiles.push({ name: chipName, content: chipContent, type: 'editor-selection' });
        }
      } else {
        if (existingIdx >= 0) attachedFiles.splice(existingIdx, 1);
      }
      renderAttachments();
      break;
    }
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
vscode.postMessage({ type: 'ready' });
autoResizeInput();
