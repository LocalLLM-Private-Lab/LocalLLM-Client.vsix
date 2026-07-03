import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import type { SshConnectionConfig } from '../config/schema';

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  localPort: number;
  error?: string;
}

/**
 * Windows OpenSSH を使って Linux 上の Ollama へのSSHポートフォワードトンネルを管理する。
 *
 * 方式: ssh -N -L {localPort}:localhost:{remotePort} {user}@{host} -p {sshPort} -i {keyPath}
 *
 * - Windows 10/11 標準搭載の OpenSSH クライアントを利用
 * - プロセス監視による自動再接続
 * - AbortController による安全な終了
 */
export class SshTunnelManager implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private state: TunnelState = 'disconnected';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private abortController = new AbortController();

  // 別ウィンドウが張ったトンネルに相乗りしている場合 true（自分は ssh を spawn していない）。
  private adopted = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFailures = 0;

  private readonly _onStatusChange = new vscode.EventEmitter<TunnelStatus>();
  readonly onStatusChange = this._onStatusChange.event;

  constructor(private readonly config: SshConnectionConfig) {}

  get currentState(): TunnelState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }
    this.abortController = new AbortController();
    await this.connect();
  }

  stop(): void {
    this.abortController.abort();
    this.clearReconnectTimer();
    this.clearHealthTimer();
    // 相乗り中（adopted）は process が null のため killProcess は何もせず、
    // 共有トンネル（他ウィンドウ所有の ssh）は殺さない。
    this.killProcess();
    this.adopted = false;
    this.setState('disconnected');
  }

  dispose(): void {
    this.stop();
    this._onStatusChange.dispose();
  }

  private async connect(): Promise<void> {
    this.setState('connecting');
    this.clearHealthTimer();
    this.adopted = false;

    const localPort = this.config.localForwardPort;

    // 既に同じローカルポートで Ollama が応答しているなら、別ウィンドウが張った
    // トンネルに相乗りする（自分では ssh を spawn しない）。これにより複数ウィンドウ間で
    // トンネルを奪い合わず共有できる。
    if (await this.probeOllama(localPort)) {
      this.adopted = true;
      this.setState('connected');
      this.startHealthMonitor(localPort);
      return;
    }

    // ポートが Ollama として応答しない場合に限り、残留 ssh プロセスを掃除する。
    await this.freeStalePort(localPort);

    const args = this.buildSshArgs();
    const sshPath = this.resolveSshPath();

    this.process = spawn(sshPath, args, {
      windowsHide: true,
      signal: this.abortController.signal,
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      const lower = msg.toLowerCase();
      // 複数ウィンドウ同時起動時のポート競合は相乗りで自己修復するため通知しない。
      if (lower.includes('address already in use') || lower.includes('forwarding')) {
        return;
      }
      // OpenSSHは接続確立後にstderrへメッセージを出力する場合がある
      if (lower.includes('warning') || lower.includes('error')) {
        vscode.window.showWarningMessage(`SSH Tunnel: ${msg.trim()}`);
      }
    });

    this.process.on('error', (err) => {
      if (this.abortController.signal.aborted) return;
      this.setState('error', err.message);
      this.scheduleReconnect();
    });

    this.process.on('exit', (code) => {
      if (this.abortController.signal.aborted) return;
      if (code !== 0) {
        this.setState('error', `SSH process exited with code ${code}`);
        this.scheduleReconnect();
      }
    });

    // ポートが Listen 状態になるまで待機してから connected 扱いにする
    const ready = await this.waitForPort(localPort, 15_000);
    if (!ready) {
      this.killProcess();
      this.setState('error', `Tunnel port ${localPort} did not open within 15s`);
      this.scheduleReconnect();
      return;
    }

    this.setState('connected');
  }

  private buildSshArgs(): string[] {
    const { host, sshPort, username, privateKeyPath, remoteOllamaPort, localForwardPort } =
      this.config;

    const args = [
      '-N',                                                  // リモートでコマンドを実行しない
      '-o', 'StrictHostKeyChecking=accept-new',             // 初回接続時のホスト鍵を自動受理
      '-o', 'ExitOnForwardFailure=yes',                     // フォワード失敗時に即終了
      '-o', 'ServerAliveInterval=30',                       // 30秒ごとに keepalive
      '-o', 'ServerAliveCountMax=3',                        // 3回失敗でタイムアウト
      '-L', `${localForwardPort}:localhost:${remoteOllamaPort}`,
      '-p', String(sshPort),
      `${username}@${host}`,
    ];

    if (privateKeyPath) {
      args.unshift('-i', privateKeyPath);
    }

    return args;
  }

  private resolveSshPath(): string {
    // Windows: System32\OpenSSH\ssh.exe が標準パス。
    // 存在しない環境（カスタムインストール等）では PATH の ssh にフォールバック。
    if (process.platform === 'win32') {
      const standard = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
      try {
        if (fs.existsSync(standard)) return standard;
      } catch { /* fall through */ }
      return 'ssh';
    }
    return 'ssh';
  }

  private killProcess(): void {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
    this.process = null;
  }

  private scheduleReconnect(): void {
    if (this.abortController.signal.aborted) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.abortController.signal.aborted) {
        this.connect();
      }
    }, 5_000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 相乗り（adopted）中のトンネルの死活を定期監視する。
   * 所有者ウィンドウが閉じる等で共有トンネルが消えたら、自分が張り直して
   * 新しい所有者になる（connect 経由で ssh を spawn）。
   */
  private startHealthMonitor(port: number): void {
    this.clearHealthTimer();
    this.healthFailures = 0;
    this.healthTimer = setInterval(async () => {
      if (this.abortController.signal.aborted) return;
      const alive = await this.probeOllama(port);
      if (alive) {
        this.healthFailures = 0;
        return;
      }
      // 一過性の失敗（瞬断・タイムアウト）で張り直さないよう連続失敗で判定する。
      if (++this.healthFailures < 2) return;
      this.clearHealthTimer();
      // 自分が所有者として再確立する。
      this.connect();
    }, 10_000);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * 指定ローカルポートに対し HTTP GET / を投げ、Ollama（=生きたトンネル）が
   * 応答するか判定する。残留 ssh はローカル TCP は受けるがリモートへの
   * チャネル確立に失敗するため、HTTP レベルでは error/timeout となり false を返す。
   */
  private probeOllama(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2_000 }, (res) => {
        res.resume(); // レスポンスボディを破棄してソケットを解放
        resolve((res.statusCode ?? 0) > 0);
      });
      req.once('timeout', () => { req.destroy(); resolve(false); });
      req.once('error', () => resolve(false));
    });
  }

  private setState(state: TunnelState, error?: string): void {
    this.state = state;
    this._onStatusChange.fire({ state, localPort: this.config.localForwardPort, error });
  }

  /**
   * 指定ポートが Listen 状態になるまでポーリング待機する。
   * タイムアウト超過で false を返す。
   */
  private waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (this.abortController.signal.aborted) {
          resolve(false);
          return;
        }
        const sock = net.createConnection({ port, host: '127.0.0.1' });
        sock.once('connect', () => {
          sock.destroy();
          resolve(true);
        });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() < deadline) {
            setTimeout(poll, 500);
          } else {
            resolve(false);
          }
        });
      };
      poll();
    });
  }

  /**
   * Ollama として応答しないのにポートを占有している残留 ssh プロセス（前セッションの
   * 死んだトンネル等）を探して強制終了する（Windows: netstat + taskkill）。
   * 呼び出し前に probeOllama が false であること（=生きた共有トンネルではないこと）が前提。
   */
  private async freeStalePort(port: number): Promise<void> {
    const inUse = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    });

    if (!inUse) return;

    // Windows: 残留した ssh.exe（前セッションのトンネル）だけを kill する。
    // ポートを LISTEN しているプロセスに限定し、さらにイメージ名が ssh.exe で
    // あることを確認してから終了する — 無関係なアプリを殺さないため。
    if (process.platform === 'win32') {
      const { execSync } = await import('child_process');
      try {
        const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
        const pids = new Set<string>();
        for (const line of out.split(/\r?\n/)) {
          // 形式: Proto LocalAddress ForeignAddress State PID
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) {
            pids.add(cols[4]);
          }
        }
        for (const pid of pids) {
          if (!/^\d+$/.test(pid) || pid === '0') continue;
          const task = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
            encoding: 'utf8',
            windowsHide: true,
          });
          if (/^"ssh\.exe"/i.test(task.trim())) {
            execSync(`taskkill /PID ${pid} /F`, { windowsHide: true });
          }
        }
      } catch {
        // 失敗してもトンネル張り直しを試みる
      }
    }
  }
}
