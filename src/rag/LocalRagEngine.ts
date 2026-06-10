import * as fs from 'fs/promises';
import * as path from 'path';

const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml',
]);

interface DocChunk {
  filePath: string;
  content: string;
  tokens: number;
}

/**
 * ローカルファイルのRAGエンジン。
 * 指定パスを再帰的に読み込み、テキスト類似検索（TF-IDF風の単純な語彙重み付け）で
 * 関連チャンクを返す。外部埋め込みモデル不要で動作する。
 */
export class LocalRagEngine {
  private chunks: DocChunk[] = [];
  private indexed = false;

  async index(paths: string[]): Promise<void> {
    this.chunks = [];
    for (const p of paths) {
      await this.indexPath(p);
    }
    this.indexed = true;
  }

  /** クエリに最も関連するチャンクを返す */
  search(query: string, topK = 5): string {
    if (!this.indexed || this.chunks.length === 0) {
      return '(RAG index is empty. Configure rag.indexPaths in settings.)';
    }

    const queryTerms = tokenize(query);
    const scored = this.chunks.map((chunk) => ({
      chunk,
      score: tfidfScore(queryTerms, tokenize(chunk.content)),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored
      .slice(0, topK)
      .filter((s) => s.score > 0)
      .map((s) => `--- ${s.chunk.filePath} ---\n${s.chunk.content}`)
      .join('\n\n');
  }

  get isIndexed(): boolean {
    return this.indexed;
  }

  private async indexPath(p: string): Promise<void> {
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) return;

    if (stat.isDirectory()) {
      const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
        await this.indexPath(path.join(p, entry.name));
      }
    } else if (stat.isFile() && SUPPORTED_EXTS.has(path.extname(p).toLowerCase())) {
      await this.indexFile(p);
    }
  }

  private async indexFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf8').catch(() => null);
    if (!content) return;

    // 1000文字ごとにチャンク分割（オーバーラップ200文字）
    const chunkSize = 1000;
    const overlap = 200;
    for (let i = 0; i < content.length; i += chunkSize - overlap) {
      const slice = content.slice(i, i + chunkSize);
      this.chunks.push({
        filePath,
        content: slice,
        tokens: Math.ceil(slice.length / 4),
      });
    }
  }
}

function tokenize(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return freq;
}

function tfidfScore(queryTerms: Map<string, number>, docTerms: Map<string, number>): number {
  let score = 0;
  for (const [term, qFreq] of queryTerms) {
    const dFreq = docTerms.get(term) ?? 0;
    if (dFreq > 0) {
      score += qFreq * Math.log(1 + dFreq);
    }
  }
  return score;
}
