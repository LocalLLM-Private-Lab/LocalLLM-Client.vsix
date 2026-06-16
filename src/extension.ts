import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ConnectionManager } from './llm/ConnectionManager';
import { OllamaClient } from './llm/OllamaClient';
import { ContextManager } from './llm/ContextManager';
import { ModelRouter } from './llm/ModelRouter';
import { TranslationService } from './llm/TranslationService';
import { ToolRegistry } from './agent/ToolRegistry';
import { ReadFileTool } from './agent/tools/ReadFileTool';
import { WriteFileTool } from './agent/tools/WriteFileTool';
import { GlobSearchTool } from './agent/tools/GlobSearchTool';
import { RunTerminalTool } from './agent/tools/RunTerminalTool';
import { GoogleSearchTool } from './agent/tools/GoogleSearchTool';
import { FetchUrlTool } from './agent/tools/FetchUrlTool';
import { createGitTool } from './agent/tools/GitTool';
import { GrepSearchTool } from './agent/tools/GrepSearchTool';
import { EditFileTool } from './agent/tools/EditFileTool';
import { ReplaceLinesTool } from './agent/tools/ReplaceLinesTool';
import { createRagSearchTool } from './agent/tools/RagSearchTool';
import { createAskUserTool } from './agent/tools/AskUserTool';
import { GetFileOutlineTool } from './agent/tools/GetFileOutlineTool';
import { GitManager } from './git/GitManager';
import { LocalRagEngine } from './rag/LocalRagEngine';
import { ChatViewProvider } from './ui/ChatViewProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = ConfigManager.get();

  // ── Core services ────────────────────────────────────────────────────────────
  const connectionManager = new ConnectionManager(config);
  const ollamaClient = new OllamaClient(connectionManager);
  // Without num_ctx Ollama silently truncates at the model's default context size
  ollamaClient.setDefaultOptions({
    num_ctx: config.tokens.contextWindow,
    num_predict: config.tokens.maxTokens,
  });
  const contextManager = new ContextManager(config, ollamaClient);
  const modelRouter = new ModelRouter(config);
  const translationService = new TranslationService(ollamaClient, modelRouter);
  const gitManager = new GitManager();
  const ragEngine = new LocalRagEngine();

  // ── Tool registry ────────────────────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(ReadFileTool);
  toolRegistry.register(GetFileOutlineTool);
  toolRegistry.register(WriteFileTool);
  toolRegistry.register(GlobSearchTool);
  toolRegistry.register(GrepSearchTool);
  toolRegistry.register(EditFileTool);
  toolRegistry.register(ReplaceLinesTool);
  toolRegistry.register(RunTerminalTool);
  toolRegistry.register(GoogleSearchTool);
  toolRegistry.register(FetchUrlTool);
  toolRegistry.register(createGitTool(gitManager));
  toolRegistry.register(createRagSearchTool(ragEngine));
  toolRegistry.register(createAskUserTool(async (question, options) => {
    if (options && options.length > 0) {
      return vscode.window.showQuickPick(options, { placeHolder: question, title: 'Agent is asking…' });
    }
    return vscode.window.showInputBox({ prompt: question, title: 'Agent is asking…', ignoreFocusOut: true });
  }));

  // ── RAG インデックス（設定で有効なら起動時に構築） ────────────────────────────
  if (config.rag.enabled && config.rag.indexPaths.length > 0) {
    ragEngine.index(config.rag.indexPaths).catch(() => {
      // バックグラウンドで実行、失敗は無視
    });
  }

  // ── Chat view ────────────────────────────────────────────────────────────────
  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    config,
    ollamaClient,
    contextManager,
    modelRouter,
    toolRegistry,
    gitManager,
    ragEngine,
    translationService,
    context
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('localLlm.chatView', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Commands ─────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('localLlm.openChat', () => {
      vscode.commands.executeCommand('localLlm.chatView.focus');
    }),

    vscode.commands.registerCommand('localLlm.stopAgent', () => {
      chatProvider.stopAgent();
    }),

    vscode.commands.registerCommand('localLlm.openSettings', () => {
      ConfigManager.openSettings();
    }),

    vscode.commands.registerCommand('localLlm.newSession', () => {
      chatProvider.handleNewSession();
    }),

    vscode.commands.registerCommand('localLlm.refreshModels', async () => {
      await chatProvider.refreshModels();
      vscode.window.showInformationMessage('Model list refreshed.');
    }),

    vscode.commands.registerCommand('localLlm.selectModel', async (modelType?: string) => {
      const slots = [
        { label: '$(star)  General',            description: 'Base model — every empty slot falls back to this', key: 'general' },
        { label: '$(comment-discussion)  Chat', description: 'Conversation / non-agent chat',  key: 'chat' },
        { label: '$(code)  Coder',              description: 'Code editing / agent execution', key: 'coder' },
        { label: '$(eye)  Vision',              description: 'Image input (llava etc.)',     key: 'vision' },
        { label: '$(globe)  Translate',         description: 'JA↔EN round-trip translation', key: 'translate' },
        { label: '$(archive)  Compaction',      description: 'History summarization',        key: 'compaction' },
      ];

      // コマンドリンクから key が渡された場合はスロット選択をスキップ
      let selectedSlot = slots.find(s => s.key === modelType);
      if (!selectedSlot) {
        const picked = await vscode.window.showQuickPick(slots, {
          placeHolder: 'Which model slot to configure?',
          matchOnDescription: true,
        });
        if (!picked) return;
        selectedSlot = picked;
      }

      // Ollama からモデル一覧を取得
      let modelNames: string[] = [];
      try {
        const { models } = await ollamaClient.listModels();
        modelNames = models.map(m => m.name);
      } catch {
        vscode.window.showErrorMessage('Cannot reach Ollama. Make sure it is running.');
        return;
      }

      if (modelNames.length === 0) {
        vscode.window.showWarningMessage('No models found. Run: ollama pull llama3');
        return;
      }

      const current = vscode.workspace
        .getConfiguration('localLlm')
        .get<string>(`models.${selectedSlot.key}`, '');

      const FOLLOW_GENERAL = '$(sync)  Follow General model';
      const modelItems: vscode.QuickPickItem[] = [];
      // general 以外のスロットは「general に追従(空にする)」を先頭に提示。
      if (selectedSlot.key !== 'general') {
        modelItems.push({
          label: FOLLOW_GENERAL,
          description: current === '' ? '✓ current' : undefined,
        });
      }
      modelItems.push(...modelNames.map(name => ({
        label: name,
        description: name === current ? '✓ current' : undefined,
      })));

      const chosenModel = await vscode.window.showQuickPick(modelItems, {
        placeHolder: `Select model for [${selectedSlot.key}]  (current: ${current || 'follow general'})`,
        matchOnDescription: false,
      });
      if (!chosenModel) return;

      const chosenValue = chosenModel.label === FOLLOW_GENERAL ? '' : chosenModel.label;
      await vscode.workspace
        .getConfiguration('localLlm')
        .update(`models.${selectedSlot.key}`, chosenValue, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        `[${selectedSlot.key}] model → ${chosenValue || 'follow general'}`
      );

      // チャットパネルのドロップダウンも更新
      await chatProvider.refreshModels();
    }),

    vscode.commands.registerCommand('localLlm.browseSshKey', async () => {
      const defaultUri = (() => {
        const current = vscode.workspace
          .getConfiguration('localLlm')
          .get<string>('connection.ssh.privateKeyPath', '');
        if (current) {
          return vscode.Uri.file(path.dirname(current));
        }
        // デフォルトは ~/.ssh
        return vscode.Uri.file(
          path.join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.ssh')
        );
      })();

      const files = await vscode.window.showOpenDialog({
        title: 'Select SSH Private Key',
        defaultUri,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'All files': ['*'] },
      });

      if (!files || files.length === 0) return;

      // Windows のバックスラッシュをスラッシュに統一
      const keyPath = files[0].fsPath.replace(/\\/g, '/');

      await vscode.workspace
        .getConfiguration('localLlm')
        .update('connection.ssh.privateKeyPath', keyPath, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(`SSH key set: ${keyPath}`);
    }),

    vscode.commands.registerCommand('localLlm.addRagPath', async () => {
      const folders = await vscode.window.showOpenDialog({
        title: 'Select folder to add to RAG index',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: true,
      });

      if (!folders || folders.length === 0) return;

      const cfg = vscode.workspace.getConfiguration('localLlm');
      const existing = cfg.get<string[]>('rag.indexPaths', []);
      const newPaths = folders.map(f => f.fsPath.replace(/\\/g, '/'));
      const merged = [...new Set([...existing, ...newPaths])];

      await cfg.update('rag.indexPaths', merged, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Added ${newPaths.length} path(s) to RAG index.`);
    })
  );

  // ── Config hot-reload ────────────────────────────────────────────────────────
  context.subscriptions.push(
    ConfigManager.onChange(async (newConfig) => {
      await connectionManager.applyConfig(newConfig);
      ollamaClient.setDefaultOptions({
        num_ctx: newConfig.tokens.contextWindow,
        num_predict: newConfig.tokens.maxTokens,
      });
      chatProvider.applyConfig(newConfig);
      modelRouter.applyConfig(newConfig);
      contextManager.applyConfig(newConfig);

      if (newConfig.rag.enabled && newConfig.rag.indexPaths.length > 0) {
        ragEngine.index(newConfig.rag.indexPaths).catch(() => {});
      }
    })
  );

  // ── Initial connection ───────────────────────────────────────────────────────
  await connectionManager.connect();

  // Disposables
  context.subscriptions.push(connectionManager, chatProvider);
}

export function deactivate(): void {
  // ConnectionManager.dispose() は subscriptions 経由で自動呼び出し
}
