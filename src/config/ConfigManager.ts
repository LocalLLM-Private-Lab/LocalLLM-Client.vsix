import * as vscode from 'vscode';
import type { OllamaConfig } from './schema';

const SECTION = 'localLlm';

export class ConfigManager {
  static get(): OllamaConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
      connection: {
        mode: cfg.get<'local' | 'ssh'>('connection.mode', 'local'),
        local: {
          host: cfg.get<string>('connection.local.host', 'localhost'),
          port: cfg.get<number>('connection.local.port', 11434),
        },
        ssh: {
          host: cfg.get<string>('connection.ssh.host', ''),
          sshPort: cfg.get<number>('connection.ssh.sshPort', 22),
          username: cfg.get<string>('connection.ssh.username', ''),
          privateKeyPath: cfg.get<string>('connection.ssh.privateKeyPath', ''),
          remoteOllamaPort: cfg.get<number>('connection.ssh.remoteOllamaPort', 11434),
          localForwardPort: cfg.get<number>('connection.ssh.localForwardPort', 11435),
        },
      },
      models: {
        // general と chat は設定(settings.json)からは扱わない。
        // general はヘッダーで選択し globalState に永続化される値が真実で、
        // ChatViewProvider が applyConfig 後に再適用する。ここでは初期既定のみ。
        // chat は常に空 = general 追従。残りのスロットは空なら general に追従。
        general: 'gemma4:26b-a4b-it-q4_K_M',
        chat: '',
        coder: cfg.get<string>('models.coder', ''),
        vision: cfg.get<string>('models.vision', ''),
        translate: cfg.get<string>('models.translate', ''),
        compaction: cfg.get<string>('models.compaction', ''),
      },
      tokens: {
        maxTokens: cfg.get<number>('tokens.maxTokens', 4096),
        contextWindow: cfg.get<number>('tokens.contextWindow', 16384),
      },
      agent: {
        mode: cfg.get<'auto' | 'agent-loop' | 'repo-map-plan' | 'repo-map-loop'>('agent.mode', 'auto'),
        framework: cfg.get<'tool-calling' | 'react'>('agent.framework', 'tool-calling'),
        enableGitIntegration: cfg.get<boolean>('agent.enableGitIntegration', true),
        autoCommitBeforeChange: cfg.get<boolean>('agent.autoCommitBeforeChange', true),
        enableBehaviorVerify: cfg.get<boolean>('agent.enableBehaviorVerify', true),
      },
      rag: {
        enabled: cfg.get<boolean>('rag.enabled', false),
        indexPaths: cfg.get<string[]>('rag.indexPaths', []),
      },
      outputLanguage: cfg.get<string>('outputLanguage', 'Japanese'),
    };
  }

  static openSettings(): void {
    vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
  }

  static onChange(listener: (config: OllamaConfig) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        listener(ConfigManager.get());
      }
    });
  }
}
