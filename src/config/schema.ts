export interface LocalConnectionConfig {
  host: string;
  port: number;
}

export interface SshConnectionConfig {
  host: string;
  sshPort: number;
  username: string;
  privateKeyPath: string;
  remoteOllamaPort: number;
  localForwardPort: number;
}

export interface ModelConfig {
  /** 基準モデル。各スロットが空のときのフォールバック先。ヘッダーのモデル選択はこれを切り替える。 */
  general: string;
  chat: string;
  coder: string;
  vision: string;
  translate: string;
  compaction: string;
}

export interface TokenConfig {
  maxTokens: number;
  contextWindow: number;
}

export type AgentMode = 'auto' | 'agent-loop' | 'repo-map-plan' | 'repo-map-loop';
export type AgentFramework = 'tool-calling' | 'react';

export interface AgentConfig {
  mode: AgentMode;
  framework: AgentFramework;
  enableGitIntegration: boolean;
  autoCommitBeforeChange: boolean;
  enableBehaviorVerify: boolean;
}

export interface RagConfig {
  enabled: boolean;
  indexPaths: string[];
}

export interface OllamaConfig {
  connection: {
    mode: 'local' | 'ssh';
    local: LocalConnectionConfig;
    ssh: SshConnectionConfig;
  };
  models: ModelConfig;
  tokens: TokenConfig;
  agent: AgentConfig;
  rag: RagConfig;
  outputLanguage: string;
}

export type TaskType = 'chat' | 'coder' | 'vision' | 'translate' | 'compaction';
