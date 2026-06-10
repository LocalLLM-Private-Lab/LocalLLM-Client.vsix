import * as vscode from 'vscode';
import type { OllamaConfig } from '../config/schema';
import { SshTunnelManager } from './SshTunnelManager';

/**
 * Ollama への接続を管理する。
 * Local モードでは直接 HTTP URL を返し、
 * SSH モードでは SshTunnelManager でトンネルを確立してからローカル転送 URL を返す。
 */
export class ConnectionManager implements vscode.Disposable {
  private tunnel: SshTunnelManager | null = null;
  private statusBarItem: vscode.StatusBarItem;

  constructor(private config: OllamaConfig) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.tooltip = 'Local LLM connection status';
    this.statusBarItem.command = 'localLlm.openSettings';
    this.updateStatusBar('disconnected');
    this.statusBarItem.show();
  }

  /** 設定変更時に呼び出す。接続関連の設定が変わったときだけ再接続する
   *  （モデル変更等のたびにSSHトンネルを張り直さない） */
  async applyConfig(newConfig: OllamaConfig): Promise<void> {
    const connectionChanged =
      JSON.stringify(this.config.connection) !== JSON.stringify(newConfig.connection);
    this.config = newConfig;
    if (!connectionChanged) return;
    await this.disconnect();
    await this.connect();
  }

  async connect(): Promise<void> {
    if (this.config.connection.mode === 'ssh') {
      await this.startTunnel();
    } else {
      this.updateStatusBar('connected');
    }
  }

  async disconnect(): Promise<void> {
    if (this.tunnel) {
      this.tunnel.stop();
      this.tunnel.dispose();
      this.tunnel = null;
    }
    this.updateStatusBar('disconnected');
  }

  /**
   * Ollama API のベース URL を返す。
   * トンネルがまだ確立されていなければ確立を待つ。
   */
  async getBaseUrl(): Promise<string> {
    const { mode, local, ssh } = this.config.connection;

    if (mode === 'local') {
      return `http://${local.host}:${local.port}`;
    }

    // SSH モード: トンネルが connected になるまで待機
    if (!this.tunnel || this.tunnel.currentState !== 'connected') {
      await this.startTunnel();
      await this.waitUntilConnected(20_000);
    }

    return `http://localhost:${ssh.localForwardPort}`;
  }

  dispose(): void {
    this.disconnect();
    this.statusBarItem.dispose();
  }

  private async startTunnel(): Promise<void> {
    if (this.tunnel) {
      this.tunnel.dispose();
    }

    this.tunnel = new SshTunnelManager(this.config.connection.ssh);
    this.tunnel.onStatusChange((status) => {
      this.updateStatusBar(status.state === 'connected' ? 'connected' : 'disconnected');
      if (status.error) {
        vscode.window.showErrorMessage(`SSH Tunnel error: ${status.error}`);
      }
    });

    this.updateStatusBar('connecting');
    await this.tunnel.start();
  }

  private waitUntilConnected(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.tunnel) { reject(new Error('No tunnel')); return; }
      if (this.tunnel.currentState === 'connected') { resolve(); return; }

      const deadline = setTimeout(() => {
        disposable.dispose();
        reject(new Error('SSH tunnel connection timed out'));
      }, timeoutMs);

      const disposable = this.tunnel.onStatusChange((s) => {
        if (s.state === 'connected') {
          clearTimeout(deadline);
          disposable.dispose();
          resolve();
        } else if (s.state === 'error') {
          clearTimeout(deadline);
          disposable.dispose();
          reject(new Error(s.error ?? 'SSH tunnel error'));
        }
      });
    });
  }

  private updateStatusBar(state: 'connected' | 'connecting' | 'disconnected'): void {
    const icons: Record<typeof state, string> = {
      connected: '$(circle-filled)',
      connecting: '$(sync~spin)',
      disconnected: '$(circle-slash)',
    };
    const labels: Record<typeof state, string> = {
      connected: 'LLM: Connected',
      connecting: 'LLM: Connecting...',
      disconnected: 'LLM: Disconnected',
    };
    this.statusBarItem.text = `${icons[state]} ${labels[state]}`;
  }
}
