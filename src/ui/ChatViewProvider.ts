import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentEvent } from '../agent/AgentLoop';
import type { OllamaClient } from '../llm/OllamaClient';
import type { ContextManager } from '../llm/ContextManager';
import type { ModelRouter } from '../llm/ModelRouter';
import type { TranslationService } from '../llm/TranslationService';
import type { ToolRegistry } from '../agent/ToolRegistry';
import { FILE_EDIT_TOOLS } from '../agent/ToolRegistry';
import { stripThink } from '../agent/agentUtils';
import type { OllamaMessage } from '../llm/OllamaClient';
import type { GitManager } from '../git/GitManager';
import type { LocalRagEngine } from '../rag/LocalRagEngine';
import type { OllamaConfig } from '../config/schema';
import { AgentLoop } from '../agent/AgentLoop';
import { ReActAgent } from '../agent/ReActAgent';
import { RepoMapAgent } from '../agent/RepoMapAgent';
import { RepoMapLoopAgent } from '../agent/RepoMapLoopAgent';
import { DebugPhaseAgent } from '../agent/DebugPhaseAgent';
import { ChatOnlyAgent } from '../agent/ChatOnlyAgent';
import { AutoDispatchAgent } from '../agent/AutoDispatchAgent';

interface WebviewMessage {
  type: string;
  text?: string;
  model?: string;
  id?: string;
  allowed?: boolean;
  approved?: boolean;
  remember?: boolean;
  toolName?: string;
  attachments?: Array<{ name: string; content: string; type?: string }>;
  event?: AgentEvent;
  query?: string;
  mentions?: string[];
  uris?: string[];
}

interface StoredSession {
  id: string;
  timestamp: number;
  preview: string;
  /** Full message objects (minus images) so tool_calls/tool pairs survive a reload */
  messages: OllamaMessage[];
}

/** Filename for project-specific LLM instructions (equivalent to CLAUDE.md) */
const PROJECT_INSTRUCTIONS_FILE = 'LOCAL_LLM.md';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private abortController: AbortController | null = null;
  private sessionAllowFileEdits = false;
  private allowTerminal = false;
  private activeFilePath: string | null = null;
  private editMode: 'ask' | 'edit' | 'plan' | 'auto' = 'ask';
  private pendingPermission: ((allowed: boolean) => void) | null = null;
  private pendingApproval: ((approved: boolean) => void) | null = null;
  private sessionPreview = '';
  private sendActiveFile = true;
  private agentMode: 'standard' | 'repo-map-plan' | 'repo-map-loop' | 'react' | 'debug' | 'chat' | 'auto' = 'auto';
  /** Set when the current run has already taken its pre-change git snapshot */
  private snapshotTaken = false;
  /** Increments per agent run — lets a superseded run skip its cleanup */
  private currentRunId = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private config: OllamaConfig,
    private client: OllamaClient,
    private contextManager: ContextManager,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
    private gitManager: GitManager,
    private ragEngine: LocalRagEngine,
    private translation: TranslationService,
    private context: vscode.ExtensionContext
  ) {}

  /** 翻訳ラウンドトリップ（日本語入力↔英語処理）の有効/無効 */
  private translateMode = false;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    this.applySystemPrompt();

    // ── Permission callback ──────────────────────────────────────────────────
    this.toolRegistry.setPermissionCallback(async (toolName, args) => {
      // Plan mode: block all mutating tools with an explanation so the model plans instead
      if (this.editMode === 'plan' && FILE_EDIT_TOOLS.has(toolName)) {
        return 'Plan mode is active. Do NOT apply file changes. ' +
          'Instead, output a detailed numbered plan listing every specific change you would make, ' +
          'including file paths, line numbers, and exact before/after content.';
      }
      if (this.editMode === 'plan' && toolName === 'run_terminal') {
        return 'Plan mode is active. Do NOT run terminal commands. ' +
          'Analyze with read-only tools (read_file, glob_search, grep_search) and produce a plan instead.';
      }

      // Any mutating tool is about to run — take the git snapshot now (lazy:
      // pure chat / read-only turns never pollute history with WIP commits)
      await this.ensureSnapshot();

      // Auto mode: approve everything
      if (this.editMode === 'auto') return true;
      // Edit mode: approve file edits silently, still ask for terminal
      if (this.editMode === 'edit' && FILE_EDIT_TOOLS.has(toolName)) return true;
      if (toolName === 'run_terminal' && this.allowTerminal) return true;
      if (FILE_EDIT_TOOLS.has(toolName) && this.sessionAllowFileEdits) return true;

      return new Promise<boolean>((resolve) => {
        if (this.pendingPermission) {
          this.pendingPermission(false);
        }
        this.pendingPermission = resolve;

        let description: string;
        let diff: string | undefined;

        if (toolName === 'run_terminal') {
          const cmd = typeof args['command'] === 'string' ? args['command'] : '(unknown command)';
          description = `Run: ${cmd}`;
        } else {
          const filePath = typeof args['path'] === 'string' ? args['path'] : '(unknown path)';
          const verb = toolName === 'write_file' ? 'Create/write' : 'Edit';
          description = `${verb}: ${filePath}`;

          // Build unified-diff style block for file operations
          if (toolName === 'replace_lines') {
            const startLine = typeof args['start_line'] === 'number' ? args['start_line'] : '?';
            const endLine = typeof args['end_line'] === 'number' ? args['end_line'] : '?';
            description = `Edit: ${filePath} (lines ${startLine}–${endLine})`;
            const newContent = typeof args['new_content'] === 'string' ? args['new_content'] : '';
            if (newContent) {
              const MAX = 30;
              const lines = newContent.split('\n');
              diff = [
                ...lines.slice(0, MAX).map(l => `+${l}`),
                ...(lines.length > MAX ? ['+…'] : []),
              ].join('\n');
            }
          } else if (toolName === 'edit_file') {
            const oldStr = typeof args['old_str'] === 'string' ? args['old_str'] : '';
            const newStr = typeof args['new_str'] === 'string' ? args['new_str'] : '';
            if (oldStr || newStr) {
              const MAX = 30;
              const oldLines = oldStr.split('\n');
              const newLines = newStr.split('\n');
              const diffLines: string[] = [
                ...oldLines.slice(0, MAX).map(l => `-${l}`),
                ...(oldLines.length > MAX ? ['-…'] : []),
                ...newLines.slice(0, MAX).map(l => `+${l}`),
                ...(newLines.length > MAX ? ['+…'] : []),
              ];
              diff = diffLines.join('\n');
            }
          } else if (toolName === 'write_file') {
            const content = typeof args['content'] === 'string' ? args['content'] : '';
            if (content) {
              const MAX = 40;
              const lines = content.split('\n');
              diff = [
                ...lines.slice(0, MAX).map(l => `+${l}`),
                ...(lines.length > MAX ? ['+…'] : []),
              ].join('\n');
            }
          }
        }

        this.view?.webview.postMessage({
          type: 'agentEvent',
          event: { type: 'needs_permission', toolName, description, diff } as AgentEvent,
        });
      });
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // ── LOCAL_LLM.md watcher ─────────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folders[0], PROJECT_INSTRUCTIONS_FILE)
      );
      const onChanged = () => this.applySystemPrompt();
      watcher.onDidChange(onChanged);
      watcher.onDidCreate(onChanged);
      watcher.onDidDelete(onChanged);
      this.disposables.push(watcher);
    }

    // ── Editor selection context ─────────────────────────────────────────────
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (selectionTimer) clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
          selectionTimer = null;
          const editor = e.textEditor;
          if (editor.selection.isEmpty) {
            this.view?.webview.postMessage({ type: 'editorContext', context: null });
            return;
          }
          const selectedText = editor.document.getText(editor.selection);
          if (!selectedText.trim()) {
            this.view?.webview.postMessage({ type: 'editorContext', context: null });
            return;
          }
          const relPath = vscode.workspace.asRelativePath(editor.document.fileName);
          this.view?.webview.postMessage({
            type: 'editorContext',
            context: {
              text: selectedText,
              fileName: relPath,
              lineStart: editor.selection.start.line + 1,
              lineEnd: editor.selection.end.line + 1,
              language: editor.document.languageId,
            },
          });
        }, 300);
      })
    );

    // ── Active file context ──────────────────────────────────────────────────
    const activeEditor = vscode.window.activeTextEditor;
    this.activeFilePath = (!activeEditor?.document.isUntitled) ? (activeEditor?.document.uri.fsPath ?? null) : null;
    this.applySystemPrompt();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.isUntitled) return; // ignore untitled / diff virtual docs
        this.activeFilePath = editor?.document.uri.fsPath ?? null;
        this.applySystemPrompt();
        this.view?.webview.postMessage({ type: 'activeFile', path: this.activeFilePath });
      })
    );

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
        this.handleMessage(msg)
      )
    );
  }

  applyConfig(config: OllamaConfig): void {
    this.config = config;
    this.contextManager.applyConfig(config);
    this.modelRouter.applyConfig(config);
    this.applySystemPrompt();
    this.sendSkills();
  }

  /** Aborts the running agent (if any) and resolves all pending dialogs. */
  stopAgent(): void {
    this.abortController?.abort();
    this.pendingPermission?.(false);
    this.pendingPermission = null;
    this.pendingApproval?.(false);
    this.pendingApproval = null;
    void vscode.commands.executeCommand('setContext', 'localLlm.agentRunning', false);
    this.view?.webview.postMessage({ type: 'agentEvent', event: { type: 'done' } });
  }

  /** Lazily creates the pre-change git snapshot, once per agent run. */
  private async ensureSnapshot(): Promise<void> {
    if (this.snapshotTaken) return;
    this.snapshotTaken = true;
    if (!this.config.agent.enableGitIntegration || !this.config.agent.autoCommitBeforeChange) return;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;
    try {
      if (await this.gitManager.isRepo(workspaceRoot)) {
        await this.gitManager.createSnapshot(workspaceRoot);
      }
    } catch { /* snapshot failure must not block the tool */ }
  }

  handleNewSession(): void {
    this.saveSession();
    this.abortController?.abort();
    this.pendingPermission?.(false);
    this.pendingPermission = null;
    this.sessionPreview = '';
    this.contextManager.clear();
    this.sessionAllowFileEdits = false;
    this.allowTerminal = false;
    this.editMode = 'ask';
    this.applySystemPrompt();
    this.postTokenUpdate();
    this.view?.webview.postMessage({ type: 'clearMessages' });
  }

  private applySystemPrompt(): void {
    this.contextManager.setSystemPrompt(this.buildSystemPrompt());
  }

  private readProjectInstructions(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return '';
    const p = path.join(folders[0].uri.fsPath, PROJECT_INSTRUCTIONS_FILE);
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return '';
    }
  }

  private buildSystemPrompt(): string {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'PowerShell' : 'bash';
    const lines: string[] = [];

    // Prepend project-specific instructions if present
    const projectInstructions = this.readProjectInstructions();
    if (projectInstructions) {
      lines.push('# Project Instructions');
      lines.push(projectInstructions);
      lines.push('');
    }

    if (this.editMode === 'plan') {
      lines.push(
        '# MODE: Plan',
        'You are in Plan mode. Do NOT call write_file, edit_file, or run_terminal.',
        'Use read_file and glob_search to analyze the codebase, then output a structured numbered plan.',
        'Each plan item must include: file path, what to change, and the exact before/after content.',
        ''
      );
    }

    if (this.sendActiveFile && this.activeFilePath) {
      lines.push(`Active file in editor: ${this.activeFilePath}`, '');
    }

    const now = new Date();
    const dateStr = now.toLocaleString('ja-JP', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
      hour: '2-digit', minute: '2-digit',
    });

    lines.push(
      `Always respond in ${this.config.outputLanguage}. Internal reasoning (thinking) may be in any language.`,
      '',
      `Current date/time: ${dateStr}. ` +
        'Resolve relative dates (今日/明日/tomorrow/yesterday etc.) to ABSOLUTE dates using this before searching or answering.',
      '',
      `Platform: ${isWin ? 'Windows' : process.platform} | Terminal shell: ${shell}`,
      isWin
        ? 'IMPORTANT — You are on WINDOWS with PowerShell. ' +
          'NEVER use bash/unix commands (ls, find, grep, cat, touch, etc.). ' +
          'Use PowerShell equivalents: Get-ChildItem (ls), Get-ChildItem -Recurse (ls -R), ' +
          'Get-Content (cat), Get-Date, Select-String (grep), New-Item (touch). ' +
          'If a command fails with encoding issues, the error message tells you what went wrong — ' +
          'do NOT repeat the same failing command.'
        : '',
      '',
      'TOOL USAGE — FOLLOW THESE RULES:',
      '1. ALWAYS call read_file to read a file BEFORE editing or commenting on its content.',
      '2. Once you have read a file, do NOT request the same lines again — the content is already in context. ' +
        'EXCEPTION: if a read_file result contains an "[lines X–Y OMITTED…]" marker, you MAY re-read exactly that narrower range once to view it.',
      '3. When creating multiple files, FIRST list all files you will create, THEN create each one completely.',
      '4. Write complete file contents — never use placeholders or truncate code.',
      '5. Use glob_search to discover project structure before starting work.',
      '6. After writing or editing files, run a build/test command to verify correctness.',
      '7. If a terminal command fails, READ the error message carefully before retrying. Do NOT repeat the same failing command.',
      '8. edit_file and write_file REQUIRE the path parameter. Always provide the relative path (e.g. "src/main.py").',
      '8b. PREFERRED EDIT WORKFLOW: After read_file, use replace_lines(path, start_line, end_line, new_content). ' +
        'Replace the WHOLE enclosing function/method in ONE call — NEVER patch 1-3 line fragments inside an indented block (this corrupts indentation). ' +
        'Line numbers SHIFT after every edit: take them from the latest read_file or the "Resulting region" echo, never from an old read. ' +
        'If an edit causes a syntax error, re-read the whole function and rewrite it entirely in one replace_lines call. ' +
        'Use edit_file only for single-line changes where exact matching is trivial. ' +
        'If edit_file fails with "String not found", switch to replace_lines immediately.',
      '9. Before calling any tool, state in ONE sentence: what you are looking for and why this specific tool is needed. This reasoning must appear immediately before the tool call.',
      '10. SILENT BUGS (feature broken, no error output): Do NOT guess and modify logic. FIRST inject temporary print/console.log/logging statements at every relevant code path, run the program, then read the output to observe what actually executes. Remove the debug statements only after you have identified the root cause.',
      '11. When diagnosing a silent bug from observation results, investigate in this exact order: (1) framework/library lifecycle — is the component initialised and alive when the event fires? (2) event propagation — is a parent/sibling intercepting or consuming the event before it reaches the target? (3) variable/instance lifetime — has the object been garbage-collected or gone out of scope before the callback runs?',
      '12. NEVER modify production code to work around a broken TEST or mock (e.g. adding try/except so a fake event object works). If a test fails because the MOCK is wrong, fix the TEST file — production code must stay clean.',
      '13. NEVER leave meta-commentary in code comments (reasoning about test errors, "Wait, the error says...", debugging notes). Comments describe the code itself, nothing else.',
      '14. Do NOT change the application architecture while fixing a bug (e.g. rerouting image display from the zoomable view to a plain label). Fix the broken behavior within the existing structure unless the task explicitly asks for restructuring.',
    );

    return lines.filter(l => l !== undefined).join('\n');
  }

  dispose(): void {
    this.abortController?.abort();
    this.disposables.forEach((d) => d.dispose());
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Derive initial agentMode from config on first load
        if (this.config.agent.framework === 'react') {
          this.agentMode = 'react';
        } else if (this.config.agent.mode === 'repo-map-loop') {
          this.agentMode = 'repo-map-loop';
        } else if (this.config.agent.mode === 'repo-map-plan') {
          this.agentMode = 'repo-map-plan';
        } else if (this.config.agent.mode === 'agent-loop') {
          this.agentMode = 'standard';
        } else {
          this.agentMode = 'auto';
        }
        this.translateMode = this.context.globalState.get<boolean>('localLlm.translateMode', false);
        await this.refreshModels();
        this.sendSkills();
        this.postTokenUpdate();
        this.view?.webview.postMessage({ type: 'editMode', mode: this.editMode });
        this.view?.webview.postMessage({ type: 'activeFile', path: this.activeFilePath });
        this.view?.webview.postMessage({ type: 'agentMode', mode: this.agentMode });
        this.view?.webview.postMessage({ type: 'translateMode', enabled: this.translateMode });
        break;

      case 'sendMessage':
        await this.runAgent(msg.text ?? '', msg.attachments ?? [], msg.mentions);
        break;

      case 'attachPaths':
        this.attachFromPaths(msg.uris ?? []);
        break;

      case 'stopAgent':
        this.stopAgent();
        break;

      case 'newSession':
        this.handleNewSession();
        break;

      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'localLlm');
        break;

      case 'setModel': {
        const model = msg.model as string | undefined;
        if (model) {
          await this.context.workspaceState.update('localLlm.lastModel', model);
          this.modelRouter.setGeneralModel(model);
        }
        break;
      }

      case 'getHistory':
        this.handleGetHistory();
        break;

      case 'loadSession':
        this.handleLoadSession(msg.id ?? '');
        break;

      case 'deleteSession':
        this.handleDeleteSession(msg.id ?? '');
        break;

      case 'triggerCompaction':
        await this.handleCompaction();
        break;

      case 'approvalResponse': {
        const approved = msg.approved ?? false;
        this.pendingApproval?.(approved);
        this.pendingApproval = null;
        break;
      }

      case 'permissionResponse': {
        const allowed = msg.allowed ?? false;
        const remember = msg.remember ?? false;
        const toolName = msg.toolName ?? '';
        if (allowed && remember) {
          if (toolName === 'run_terminal') {
            this.allowTerminal = true;
          } else {
            this.sessionAllowFileEdits = true;
          }
        }
        this.pendingPermission?.(allowed);
        this.pendingPermission = null;
        break;
      }

      case 'setEditMode': {
        const newMode = (msg as unknown as Record<string, unknown>)['mode'];
        const validModes = ['ask', 'edit', 'plan', 'auto'] as const;
        this.editMode = validModes.includes(newMode as typeof validModes[number])
          ? (newMode as typeof validModes[number])
          : 'ask';
        this.view?.webview.postMessage({ type: 'editMode', mode: this.editMode });
        break;
      }

      case 'setAgentMode': {
        const newAMode = (msg as unknown as Record<string, unknown>)['mode'];
        const validAModes = ['standard', 'repo-map-plan', 'repo-map-loop', 'react', 'debug', 'chat', 'auto'] as const;
        this.agentMode = validAModes.includes(newAMode as typeof validAModes[number])
          ? (newAMode as typeof validAModes[number])
          : 'auto';
        this.view?.webview.postMessage({ type: 'agentMode', mode: this.agentMode });
        break;
      }

      case 'setTranslateMode': {
        const enabled = (msg as unknown as Record<string, unknown>)['enabled'];
        this.translateMode = enabled === true;
        void this.context.globalState.update('localLlm.translateMode', this.translateMode);
        break;
      }

      case 'toggleActiveFile': {
        const enabled = (msg as unknown as Record<string, unknown>)['enabled'];
        this.sendActiveFile = enabled !== false;
        this.applySystemPrompt();
        break;
      }

      case 'reindexRag':
        if (this.config.rag.indexPaths.length > 0) {
          this.ragEngine.index(this.config.rag.indexPaths).catch(() => {});
          this.view?.webview.postMessage({
            type: 'agentEvent',
            event: { type: 'text', content: '[RAG re-indexing started in background]' },
          });
        } else {
          this.view?.webview.postMessage({
            type: 'agentEvent',
            event: { type: 'text', content: '[No RAG paths configured. Add paths in settings.]' },
          });
        }
        break;

      case 'searchFiles': {
        const query = (msg.query ?? '').toLowerCase();
        try {
          const uris = await vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,dist,out,build,.vscode}/**',
            200
          );
          const results = uris
            .map(u => ({
              path: vscode.workspace.asRelativePath(u),
              name: path.basename(u.fsPath),
            }))
            .filter(f =>
              !query ||
              f.path.toLowerCase().includes(query) ||
              f.name.toLowerCase().includes(query)
            )
            .slice(0, 20);
          this.view?.webview.postMessage({ type: 'fileResults', results });
        } catch {
          this.view?.webview.postMessage({ type: 'fileResults', results: [] });
        }
        break;
      }
    }
  }

  private sendSkills(): void {
    const skills = vscode.workspace
      .getConfiguration('localLlm')
      .get<Array<{ command: string; description: string; prompt: string }>>('skills', []);
    this.view?.webview.postMessage({ type: 'setSkills', skills });
  }

  private saveSession(): void {
    const messages = this.contextManager.exportMessages();
    const hasContent = messages.some(m => m.role === 'user' || m.role === 'assistant');
    if (!hasContent && !this.sessionPreview) return;

    const preview = (this.sessionPreview ||
      messages.find(m => m.role === 'user')?.content ||
      '').slice(0, 80);
    if (!preview) return;
    const sessions: StoredSession[] = this.context.workspaceState.get('localLlm.sessions', []);

    const session: StoredSession = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      preview,
      // Keep tool_calls / tool_call_id so the restored context stays API-valid.
      // Images are dropped — base64 payloads would bloat workspaceState.
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
    };

    const updated = [session, ...sessions].slice(0, 20);
    void this.context.workspaceState.update('localLlm.sessions', updated);
  }

  private handleGetHistory(): void {
    const sessions: StoredSession[] = this.context.workspaceState.get('localLlm.sessions', []);
    this.view?.webview.postMessage({
      type: 'showHistory',
      sessions: sessions.map(s => ({
        id: s.id,
        timestamp: s.timestamp,
        preview: s.preview,
        messageCount: s.messages.length,
      })),
    });
  }

  private handleLoadSession(id: string): void {
    const sessions: StoredSession[] = this.context.workspaceState.get('localLlm.sessions', []);
    const session = sessions.find(s => s.id === id);
    if (!session) return;

    this.contextManager.importMessages(session.messages);

    this.postTokenUpdate();
    this.view?.webview.postMessage({
      type: 'sessionLoaded',
      messages: session.messages.filter(m => m.role === 'user' || m.role === 'assistant'),
    });
  }

  private async handleCompaction(): Promise<void> {
    try {
      // 手動圧縮もSSH経由だと数秒かかる。要約LLM呼び出し中は待機表示を出す
      // (次に送る text イベントが removeThinking で自動的に消す)。
      const compacted = await this.contextManager.compact(undefined, (m) =>
        this.view?.webview.postMessage({ type: 'agentEvent', event: { type: 'thinking', content: m } })
      );
      this.postTokenUpdate();
      const msg = compacted ? '[Context compacted by summarization]' : '[Nothing to compact yet]';
      this.view?.webview.postMessage({ type: 'agentEvent', event: { type: 'text', content: msg } });
    } catch { /* ignore */ }
  }

  private postTokenUpdate(): void {
    const { used, max } = this.contextManager.getTokenInfo();
    this.view?.webview.postMessage({ type: 'updateTokens', used, max });
  }

  private handleDeleteSession(id: string): void {
    const sessions: StoredSession[] = this.context.workspaceState.get('localLlm.sessions', []);
    const updated = sessions.filter(s => s.id !== id);
    void this.context.workspaceState.update('localLlm.sessions', updated);
  }

  private static readonly ATTACH_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
  private static readonly MAX_ATTACH_BYTES = 4 * 1024 * 1024;

  /** VSCodeエクスプローラ等からのドロップはwebviewにFileオブジェクトが渡らず
   *  file:// のURIリストだけが来る。ここで読み込んで添付チップとして返す。 */
  private attachFromPaths(uris: string[]): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const raw of uris.slice(0, 10)) {
      try {
        const uri = vscode.Uri.parse(raw, true);
        if (uri.scheme !== 'file') continue;
        const abs = uri.fsPath;
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        const name = workspaceRoot && abs.startsWith(workspaceRoot)
          ? path.relative(workspaceRoot, abs)
          : path.basename(abs);
        if (stat.size > ChatViewProvider.MAX_ATTACH_BYTES) {
          void vscode.window.showWarningMessage(`添付をスキップ: ${name} は4MBを超えています`);
          continue;
        }
        const isImage = ChatViewProvider.ATTACH_IMAGE_EXTS.has(path.extname(abs).toLowerCase());
        const content = isImage
          ? fs.readFileSync(abs).toString('base64')
          : fs.readFileSync(abs, 'utf8');
        this.view?.webview.postMessage({
          type: 'attachedFile',
          name,
          content,
          fileType: isImage ? 'image' : 'text',
        });
      } catch {
        // 読めないエントリ(ディレクトリ、権限なし、不正URI)は黙ってスキップ
      }
    }
  }

  private async runAgent(
    userMessage: string,
    attachments: Array<{ name: string; content: string; type?: string }>,
    mentions?: string[]
  ): Promise<void> {
    // Guard against concurrent runs: a second send while an agent is running
    // would otherwise orphan the old AbortController and interleave two agents
    // writing into the same ContextManager.
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
      this.pendingPermission?.(false);
      this.pendingPermission = null;
      this.pendingApproval?.(false);
      this.pendingApproval = null;
    }

    // 履歴プレビューとユーザー吹き出しは原文(日本語)のまま。翻訳ON時はLLMへ渡す
    // 文面だけ英語化する(メンション/添付/RAGは元から英語前提なので訳さない)。
    this.sessionPreview = userMessage;
    const promptMessage = this.translateMode
      ? await this.translation.toEnglish(userMessage)
      : userMessage;
    if (this.translateMode) {
      if (promptMessage.trim() && promptMessage !== userMessage) {
        // 実際にLLMへ送る英文を提示(入力が英訳されたことを可視化)
        this.view?.webview.postMessage({ type: 'translatedInput', text: promptMessage });
      } else if (/[　-ヿ㐀-鿿＀-￯]/.test(userMessage)) {
        // 日本語のままなのに変化なし = 英訳が失敗/無効。原文のまま送られる旨を警告。
        this.view?.webview.postMessage({
          type: 'translatedInput',
          text: '',
          warn: '英訳できませんでした（原文のまま送信します）',
        });
      }
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // Load @mentioned files and prepend their contents
    let mentionedContent = '';
    if (mentions?.length) {
      const parts = await Promise.all(
        mentions.map(async (relPath) => {
          try {
            const absPath = path.join(workspaceRoot, relPath);
            const content = fs.readFileSync(absPath, 'utf8');
            const ext = path.extname(relPath).slice(1) || 'txt';
            return `[File: ${relPath}]\n\`\`\`${ext}\n${content}\n\`\`\``;
          } catch {
            return `[File: ${relPath} — could not read]`;
          }
        })
      );
      mentionedContent = parts.join('\n\n');
    }

    const imageAttachments = attachments.filter(a => a.type === 'image');
    const textAttachments = attachments.filter(a => a.type !== 'image');
    const images = imageAttachments.length > 0 ? imageAttachments.map(a => a.content) : undefined;

    let fullMessage = promptMessage;
    if (textAttachments.length > 0) {
      fullMessage += textAttachments
        .map((a) => `\n\n--- ${a.name} ---\n${a.content}`)
        .join('');
    }
    if (mentionedContent) {
      fullMessage = mentionedContent + '\n\n' + fullMessage;
    }

    if (this.config.rag.enabled && this.ragEngine.isIndexed) {
      const ragContext = this.ragEngine.search(promptMessage, 5);
      if (ragContext) {
        fullMessage = `[Relevant context from codebase]\n${ragContext}\n\n[User query]\n${fullMessage}`;
      }
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const runId = ++this.currentRunId;

    // Snapshot is taken lazily (ensureSnapshot) when the first mutating tool runs
    this.snapshotTaken = false;
    void vscode.commands.executeCommand('setContext', 'localLlm.agentRunning', true);

    // Token estimation walks the whole history — throttle it during streaming
    // instead of recomputing on every text delta.
    let lastTokenPost = 0;
    // 翻訳ON時、最後の生成ターンの本文を保持して完了後に日本語へ訳す。
    // ('done' はターンごとに飛ぶため、ターン単位でバッファを確定していく)
    let turnBuffer = '';
    let lastTurnText = '';
    const onEvent = (event: AgentEvent) => {
      this.view?.webview.postMessage({ type: 'agentEvent', event });
      if (this.translateMode) {
        if (event.type === 'text') {
          turnBuffer += event.content ?? '';
        } else if (event.type === 'done') {
          if (turnBuffer.trim()) lastTurnText = turnBuffer;
          turnBuffer = '';
        }
      }
      const now = Date.now();
      if (event.type !== 'text' || now - lastTokenPost > 500) {
        lastTokenPost = now;
        this.postTokenUpdate();
      }
    };

    const approvalFn = (_planText: string, _cycle?: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        this.pendingApproval?.(false);
        this.pendingApproval = resolve;
        // VS Code native notification so the user is notified even if the panel is not focused
        vscode.window.showInformationMessage(
          'Execution Plan ready — review and approve in the chat panel.',
          'Approve', 'Cancel'
        ).then((choice) => {
          if (choice !== undefined && this.pendingApproval) {
            this.pendingApproval(choice === 'Approve');
            this.pendingApproval = null;
          }
        });
      });

    try {
      if (this.agentMode === 'repo-map-plan') {
        const agent = new RepoMapAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, workspaceRoot, approvalFn,
          this.config.outputLanguage, this.config.agent.enableBehaviorVerify
        );
        await agent.run(fullMessage, onEvent, signal, images);
      } else if (this.agentMode === 'repo-map-loop') {
        const agent = new RepoMapLoopAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, workspaceRoot, approvalFn,
          this.config.outputLanguage, this.config.agent.enableBehaviorVerify
        );
        await agent.run(fullMessage, onEvent, signal, images);
      } else if (this.agentMode === 'react') {
        const agent = new ReActAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, workspaceRoot,
          this.config.outputLanguage
        );
        await agent.run(fullMessage, onEvent, signal, images);
      } else if (this.agentMode === 'debug') {
        const agent = new DebugPhaseAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, workspaceRoot,
          this.config.outputLanguage, this.config.agent.enableBehaviorVerify
        );
        await agent.run(fullMessage, onEvent, signal, images);
      } else if (this.agentMode === 'chat') {
        const agent = new ChatOnlyAgent(
          this.client, this.contextManager, this.modelRouter, this.config.outputLanguage
        );
        await agent.run(fullMessage, onEvent, signal, images);
      } else if (this.agentMode === 'auto') {
        const agent = new AutoDispatchAgent(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, workspaceRoot,
          this.config.outputLanguage, approvalFn, this.config.agent.enableBehaviorVerify
        );
        await agent.run(fullMessage, onEvent, signal, images);
      } else {
        const agent = new AgentLoop(
          this.client, this.contextManager, this.modelRouter, this.toolRegistry, workspaceRoot
        );
        await agent.run(fullMessage, onEvent, signal, images);
      }

      // 翻訳ON: 最終ターンの英語本文(think除去後)を日本語へ訳し、
      // 既に描画済みの最後のアシスタント吹き出しを置換する。
      if (this.translateMode && !signal.aborted && runId === this.currentRunId) {
        if (turnBuffer.trim()) lastTurnText = turnBuffer;
        const clean = stripThink(lastTurnText).trim();
        if (clean) {
          // 出力翻訳はここでstreamが止まり数秒かかるため、その間の無表示を防ぐ。
          this.view?.webview.postMessage({ type: 'translating' });
          const ja = await this.translation.toJapanese(clean, signal);
          // 中断時は ja に英語原文が返る → 置換でインジケータ除去のみ行われる。
          // 後続runに置き換わった場合は送信側の removeTranslating で掃除される。
          if (runId === this.currentRunId) {
            this.view?.webview.postMessage({ type: 'translateReplace', text: ja });
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        onEvent({ type: 'error', content: String(err) });
      } else {
        onEvent({ type: 'done' });
      }
    } finally {
      // A superseded run must not clear the flag for the run that replaced it
      if (runId === this.currentRunId) {
        void vscode.commands.executeCommand('setContext', 'localLlm.agentRunning', false);
      }
    }
  }

  async refreshModels(): Promise<void> {
    try {
      const { models } = await this.client.listModels();
      const names = models.map((m) => m.name);
      this.view?.webview.postMessage({ type: 'updateModels', models: names });
      const lastModel = this.context.workspaceState.get<string>('localLlm.lastModel');
      const activeModel = lastModel && names.includes(lastModel) ? lastModel : this.modelRouter.getGeneralModel();
      if (lastModel && names.includes(lastModel)) {
        this.modelRouter.setGeneralModel(lastModel);
      }
      this.view?.webview.postMessage({ type: 'setDefaultModel', model: activeModel });
    } catch { /* Ollama not running */ }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const cspSource = webview.cspSource;

    const webviewJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );

    const htmlPath = path.join(this.extensionUri.fsPath, 'resources', 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    html = html
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{cspSource\}\}/g, cspSource)
      .replace(/\{\{webviewUri\}\}/g, webviewJsUri.toString());

    return html;
  }
}
