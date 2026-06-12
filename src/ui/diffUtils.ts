// 承認ダイアログ用の構造化diff。拡張ホスト側で実ファイルの現内容と照合して
// 生成し、webviewが行番号・+/-マーカー・背景色付きで描画する。
// 文字列のunified diffではなく構造化データで渡すのは、webview側で
// エスケープ・行番号桁揃え・拡大表示を安全に行うため。

export interface DiffLine {
  /** add=追加行 / del=削除行 / ctx=文脈行 / gap=省略マーカー */
  kind: 'add' | 'del' | 'ctx' | 'gap';
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** 変更行の前後に残す文脈行数 */
const CONTEXT = 3;
/** webviewへ送る行数上限(拡大表示でもこれ以上は末尾省略) */
const MAX_ROWS = 400;
/** LCS DPをかける変更領域サイズ(行数の積)の上限。超えたら一塊のdel/addにする */
const MAX_LCS_AREA = 250_000;

export function splitLines(text: string): string[] {
  const norm = text.replace(/\r\n/g, '\n');
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm;
  return body === '' ? [] : body.split('\n');
}

type Op = { kind: 'add' | 'del' | 'ctx'; text: string };

/** 共通プレフィックス/サフィックスを文脈化し、残った変更領域をLCSで対応付ける */
function diffOps(oldLines: string[], newLines: string[]): Op[] {
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  ) s++;

  const oldMid = oldLines.slice(p, oldLines.length - s);
  const newMid = newLines.slice(p, newLines.length - s);

  const mid: Op[] =
    oldMid.length * newMid.length <= MAX_LCS_AREA
      ? lcsOps(oldMid, newMid)
      : [
          ...oldMid.map((t): Op => ({ kind: 'del', text: t })),
          ...newMid.map((t): Op => ({ kind: 'add', text: t })),
        ];

  return [
    ...oldLines.slice(0, p).map((t): Op => ({ kind: 'ctx', text: t })),
    ...mid,
    ...oldLines.slice(oldLines.length - s).map((t): Op => ({ kind: 'ctx', text: t })),
  ];
}

/** 標準的なLCS DP。変更領域はprefix/suffix除去済みなので通常は小さい */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}

/** 旧ファイル全体と新ファイル全体から、文脈±CONTEXT行+行番号付きのdiffを作る */
export function buildLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const ops = diffOps(oldLines, newLines);

  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.kind !== 'ctx') {
      const from = Math.max(0, i - CONTEXT);
      const to = Math.min(ops.length - 1, i + CONTEXT);
      for (let k = from; k <= to; k++) keep[k] = true;
    }
  });

  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let skipped = 0;
  const flushGap = () => {
    if (skipped > 0) {
      out.push({ kind: 'gap', text: `… ${skipped} unchanged lines …` });
      skipped = 0;
    }
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!keep[i]) {
      // keep対象外はctxのみ(変更行は必ずkeepされる)
      skipped++;
      oldNo++;
      newNo++;
      continue;
    }
    flushGap();
    if (op.kind === 'ctx') out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: op.text });
    else if (op.kind === 'del') out.push({ kind: 'del', oldNo: oldNo++, text: op.text });
    else out.push({ kind: 'add', newNo: newNo++, text: op.text });
  }
  flushGap();

  if (out.length > MAX_ROWS) {
    const omitted = out.length - MAX_ROWS;
    out.length = MAX_ROWS;
    out.push({ kind: 'gap', text: `… ${omitted} more lines …` });
  }
  return out;
}

/** replace_lines: ツールと同じマージ規則(1始まり両端含む・末尾clamp)で新ファイルを合成して比較 */
export function diffForReplaceLines(
  fileContent: string,
  startLine: number,
  endLine: number,
  newContent: string
): DiffLine[] {
  const lines = splitLines(fileContent);
  const clampedEnd = Math.min(endLine, lines.length);
  const newLines = newContent === '' ? [] : splitLines(newContent);
  const merged = [...lines.slice(0, startLine - 1), ...newLines, ...lines.slice(clampedEnd)];
  return buildLineDiff(lines, merged);
}

/** write_file: 既存ファイルがあれば差分、新規なら全行追加 */
export function diffForWriteFile(oldContent: string | null, newContent: string): DiffLine[] {
  const newLines = splitLines(newContent);
  if (oldContent === null) {
    const out: DiffLine[] = newLines
      .slice(0, MAX_ROWS)
      .map((t, i): DiffLine => ({ kind: 'add', newNo: i + 1, text: t }));
    if (newLines.length > MAX_ROWS) {
      out.push({ kind: 'gap', text: `… ${newLines.length - MAX_ROWS} more lines …` });
    }
    return out;
  }
  return buildLineDiff(splitLines(oldContent), newLines);
}

/** edit_file: old_strをファイル内で特定できれば行番号付き、できなければ素朴な-/+表示 */
export function diffForEditFile(
  fileContent: string | null,
  oldStr: string,
  newStr: string
): DiffLine[] {
  if (fileContent !== null) {
    const norm = fileContent.replace(/\r\n/g, '\n');
    const oldNorm = oldStr.replace(/\r\n/g, '\n');
    const idx = norm.indexOf(oldNorm);
    if (idx >= 0) {
      const replaced =
        norm.slice(0, idx) + newStr.replace(/\r\n/g, '\n') + norm.slice(idx + oldNorm.length);
      return buildLineDiff(splitLines(norm), splitLines(replaced));
    }
  }
  return [
    ...splitLines(oldStr).map((t): DiffLine => ({ kind: 'del', text: t })),
    ...splitLines(newStr).map((t): DiffLine => ({ kind: 'add', text: t })),
  ];
}
