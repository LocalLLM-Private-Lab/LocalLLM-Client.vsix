# Local LLM Client

VSCode上で動作するAIエージェント拡張機能。[Ollama](https://ollama.ai/) を使ってローカルまたはリモートLinux上のLLMに接続し、Claude Codeに近い操作感でコード生成・修正・実行を行えます。

---

## クイックスタート

### 1. Ollama を起動する

```bash
# デフォルトモデルを取得（1つで全機能が動作）
ollama pull gemma4:26b-a4b-it-q4_K_M

# サーバー起動（デスクトップアプリを使う場合は不要）
ollama serve
```

### 2. 拡張機能をインストールする

```bat
install.bat
```

ビルド・パッケージ作成・VSCodeへのインストールを一括で行います。

### 3. VSCode を再起動する

再起動後、左のアクティビティバーにロボットアイコンが表示されます。

### 4. チャットを開いて話しかける

アイコンをクリック → チャット欄に質問を入力 → **Enter** で送信。

> 詳細な設定・操作方法は [docs/user-guide.md](docs/user-guide.md) を参照してください。

---

## 機能

| 機能 | 説明 |
|---|---|
| **Auto モード（デフォルト）** | メッセージ内容を自動判定して Chat / Agent Loop / Debug / Plan へ転送。余分なLLM呼び出しなし |
| **Agent Loop** | Tool Callingを使って自律的に思考とツール実行を繰り返す（最大20ターン） |
| **Debug（3フェーズ+Verify）** | Localize→Repair→Validate（FAIL時はRepairへ1回戻る）→Behavior Verify。仮説生成→構造検索→ピンポイント修正→検証 |
| **Chat モード** | ツールなし・シンプルなsystem promptの純会話モード。壁打ち・質問・説明に最適 |
| **ReAct モード** | Tool Calling非対応モデル向けのThought/Action/Observationループ |
| **Repo Map & Plan** | リポジトリ構造＋タスクで名指しされたファイルのアウトライン→計画策定→ユーザー承認→ステップ別実行（[Step N/M]バナー・完了ゲート付き） |
| **Repo Map Loop** | 計画→承認→実行→エラー検出→再計画のPDCAサイクル（最大5回）。実行中にプランの前提誤りを発見したら STEP MISMATCH で即再計画 |
| **Behavior Verify** | .py 修正後、LLM自身がスモークテストを生成・実行し、失敗時はscoped repairで自動修正（起動成功だけでは見えない操作バグを検出） |
| **構文チェック** | `.py` への書き込み直後に `py_compile` で自動検証。構文を壊した編集は即座にエラー報告 |
| **エージェントモード切替** | 入力欄のボタンで7つのモードをその場で切替 |
| **スラッシュコマンド** | `/` でコマンドメニューを表示。カスタムスキルも設定から追加可能 |
| **ファイル編集ツール** | `read_file`（行番号付き）, `get_file_outline`（構造のみ）, `write_file`, `edit_file`, `replace_lines`, `glob_search`, `grep_search` |
| **3層ループ検知** | フィンガープリント（同一引数3回）＋ファイルパスレベル（同一ファイル再読、編集後はリセット）＋同一編集の即時ブロック |
| **縮退リトライ** | 文字列反復＋行頻度＋自己修正マーカーの3種検知で自動リカバリ（最大2回）。中断前の分析末尾を次試行に引き継ぎ |
| **宣言のみ終了の救済** | 「〜を検索します」と宣言だけしてツールを呼ばず終わる応答や、本文に書かれた疑似ツールコールを検知し、実行を促して再試行（最大2回、実ツール実行で回数リセット） |
| **安定サンプリング** | Mirostat 2 + temperature 0.25 + top_p 0.9でローカルモデルのループ崩壊を抑制 |
| **権限モード** | Ask / Edit / Plan / Auto の4モード。セッション中の一括許可も可能 |
| **承認前diffプレビュー** | `write_file` / `replace_lines` / `edit_file` の承認前に、実ファイルと照合した行番号付きdiff（+/-マーカー・テーマ連動の背景色・変更箇所±3行の文脈）を表示。クリックで全画面拡大 |
| **セッション履歴** | 過去のセッションを自動保存・復元（最大20件） |
| **ファイル添付** | 📎ボタン・クリップボード貼り付け（スクリーンショット可）・パネル全域へのドラッグ&ドロップ（VSCodeエクスプローラ/OSファイラ両対応） |
| **画像入力** | 添付画像はVisionモデルへ自動切替して解析 |
| **シンタックスハイライト** | コードブロックをhighlight.jsで色付け表示（VS Codeテーマ連動） |
| **TeX数式表示** | KaTeXで数式をレンダリング。ツールバーの∑ボタンでTeX⇔プレーン表示を切替（LLMとの往復は生のTeXのまま） |
| **Thinking表示** | DeepSeek-R1・Qwen3・Gemma4の推論過程を折り畳み表示 |
| **SSH トンネル** | Windows OpenSSH経由でLinux上のOllamaにセキュア接続 |
| **ローカルRAG** | 指定フォルダのドキュメントを索引化してコンテキストに活用 |
| **Web検索** | DuckDuckGo検索＋`fetch_url`によるページ本文取得。天気は wttr.in 直読み。システムプロンプトに現在日時を注入し「明日」等を解決 |
| **Git連携** | 変更前の自動スナップショットコミット・ロールバック |
| **コンテキスト圧縮** | 手動（トークンリングクリック・`/compact`）または自動（85%で起動） |
| **出力言語設定** | AIの最終回答言語を設定で指定（デフォルト: 日本語） |
| **リクエストタイムアウト** | ストリーミング10分・通常2分で自動タイムアウト（ハング防止） |
| **軽量起動** | KaTeX等の重い依存は数式出現時に遅延ロードして初期表示を高速化。起動中・モデル一覧取得中はローディング表示で状態を明示 |

---

## 必要環境

- **VSCode** 1.85 以上
- **Node.js** 18 以上
- **Ollama** ([ollama.ai](https://ollama.ai/)) — ローカルまたはLinuxサーバーで起動済み
- SSH接続を使う場合: **Windows 10/11** (OpenSSH標準搭載)

---

## インストール

```bat
install.bat
```

`install.bat` を実行すると依存パッケージのインストール・ビルド・`.vsix` パッケージの作成・VSCodeへのインストールを一括で行います。

### デバッグ起動（開発時）

VSCodeでこのフォルダを開いて **F5** を押すと、拡張機能ホストが起動します。

---

## 接続設定

VSCodeの設定（`Ctrl+,` → `localLlm` で検索）から変更できます。

### ローカル接続（デフォルト）

```jsonc
"localLlm.connection.mode": "local",
"localLlm.connection.local.host": "localhost",
"localLlm.connection.local.port": 11434
```

### Linux SSH トンネル接続

```jsonc
"localLlm.connection.mode": "ssh",
"localLlm.connection.ssh.host": "192.168.1.100",
"localLlm.connection.ssh.sshPort": 22,
"localLlm.connection.ssh.username": "myuser",
"localLlm.connection.ssh.privateKeyPath": "C:/Users/you/.ssh/id_rsa",
"localLlm.connection.ssh.remoteOllamaPort": 11434,
"localLlm.connection.ssh.localForwardPort": 11435
```

接続確立後、ステータスバー右下に `● LLM: Connected` が表示されます。

---

## モデル設定

タスクごとに使用モデルを個別に指定できます。

```jsonc
"localLlm.models.chat":       "gemma4:26b-a4b-it-q4_K_M",  // メインのチャット・コード生成
"localLlm.models.vision":     "gemma4:26b-a4b-it-q4_K_M",  // 画像入力
"localLlm.models.translate":  "gemma4:26b-a4b-it-q4_K_M",  // 翻訳
"localLlm.models.compaction": "gemma4:26b-a4b-it-q4_K_M"   // 会話履歴の圧縮・要約
```

---

## エージェント設定

```jsonc
"localLlm.agent.mode": "auto",               // "auto" | "agent-loop" | "repo-map-plan" | "repo-map-loop"
"localLlm.agent.framework": "tool-calling",  // "tool-calling" | "react"
"localLlm.agent.enableGitIntegration":   true,
"localLlm.agent.autoCommitBeforeChange": true,   // 最初の変更系ツール実行直前に1回だけスナップショット
"localLlm.agent.enableBehaviorVerify":   true    // .py修正後のLLM生成スモークテスト検証
```

### トークン設定

```jsonc
"localLlm.tokens.contextWindow": 16384,  // Ollamaへ num_ctx として送信（VRAM使用量に影響）
"localLlm.tokens.maxTokens":     4096    // 1生成あたりの上限（Repair系は自動で1.5倍）
```

> **ランタイム切替:** 設定を変更しなくても、入力欄の **Agent モードボタン** でセッション中にいつでもモードを切り替えられます。

### モード選択の目安

| タスク | 推奨モード |
|---|---|
| 迷ったら / なんでも | `auto`（自動判定・**デフォルト**） |
| 壁打ち・質問・説明 | `chat` |
| バグ修正・動かない機能の調査 | `debug` |
| 大きな機能実装・確認しながら進めたい | `repo-map-plan` |
| 自動修正サイクルが欲しい | `repo-map-loop` |
| Tool Calling非対応モデル | `agent-loop` + `react` |

## 出力言語設定

AIの最終回答言語を指定します（内部推論・Thinking は言語を問いません）。

```jsonc
"localLlm.outputLanguage": "Japanese"  // デフォルト。"English" / "Chinese" 等に変更可
```

---

## コマンド

| コマンド | 説明 |
|---|---|
| `Local LLM: Open Chat` | チャットパネルを開く |
| `Local LLM: Stop Agent` | 実行中のエージェントを強制停止 |
| `Local LLM: New Session` | 会話履歴をリセットして新セッション開始 |
| `Local LLM: Refresh Model List` | Ollamaのモデル一覧を再取得 |
| `Local LLM: Open Settings` | 設定画面を開く |

---

## アーキテクチャ

```
[Webview UI]  ← markdown/KaTeX(遅延ロード)描画・添付(📎/paste/D&D)・diff拡大モーダル
    │ postMessage
    ▼
[ChatViewProvider]  ← 承認UI（実ファイルと照合した行番号付きdiffを生成）
    │
    ├── AutoDispatchAgent  ← キーワード判定で以下へ転送（鮮度ガード: 天気/最新等はツール付きへ）
    ├── ChatOnlyAgent      ← ツールなし純会話
    ├── AgentLoop          ← tool-calling（デフォルト。空応答ガード・重複編集ブロック・宣言のみ終了の救済付き）
    ├── DebugPhaseAgent    ← Localize→Repair→Validate(+FAIL時バックエッジ)→Verify
    ├── ReActAgent         ← Thought/Action/Observation
    ├── RepoMapAgent       ← repo map + outline + plan & approve（STEP MISMATCH時1回再計画）
    ├── RepoMapLoopAgent   ← PDCA 最大5サイクル（Verify失敗も再計画入力に）
    └── BehaviorVerifier   ← LLM生成スモークテスト → 実行 → scoped repair（最大2回）
          │
          ▼
    [ToolRegistry]  ← 権限制御（FILE_EDIT_TOOLS集合で一元化）・スキーマ検証
          ├── read_file / get_file_outline / write_file / edit_file / replace_lines
          │     └─ 書き込み系: ワークスペース外パス拒否 + .py構文チェック(py_compile)
          ├── glob_search / grep_search
          ├── run_terminal（exit code基準・エラー行抽出つき圧縮）
          ├── web_search (DuckDuckGo) / fetch_url（JSON対応・天気はwttr.in誘導）
          ├── rag_search (local TF-IDF index)
          ├── ask_user
          └── git (安全コマンドのみ・トークン単位の危険判定)
          │
          ▼
    [OllamaClient] ─ streaming fetch / NDJSON行バッファ / num_ctx・num_predict注入
          │          / think打ち切り時の</think>保証 (timeout: 10min)
          │
    [ConnectionManager]
          ├── Local: http://localhost:11434
          └── SSH:  [SshTunnelManager]
                        └── ssh -N -L {port}:localhost:11434 user@host
```

---

## 開発

```bat
npm run watch     # ファイル変更を監視して自動ビルド
npm run package   # 本番用バンドル生成
```

---

## ライセンス

MIT
