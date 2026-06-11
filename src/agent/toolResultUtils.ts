/** Maximum characters stored per tool result in context.
 *  Keeps head + tail so error lines at the end are preserved. */
export const MAX_TOOL_RESULT_CHARS = 1400;

/** read_file gets a larger budget: it is the agent's primary information
 *  channel, and a targeted range-read that comes back with its middle cut out
 *  leaves the model unable to ever see the code it asked for (observed
 *  failure: 73-line read truncated to head+tail, dropEvent in the removed
 *  middle, model spiralled into a retry-narration loop). */
const READ_FILE_MAX_CHARS = 4000;
const READ_HEAD_BUDGET = 2600;
const READ_TAIL_BUDGET = 1100;

const ERROR_LINE_RE = /error|fail(?:ed|ure)?|exception|traceback|panic|fatal/i;

/** fetch_url is the model's "read the article" channel. Squashing it to the
 *  generic 1400-char head+tail meant the page MIDDLE — usually where the
 *  answer is — never reached the model even though the tool had fetched it.
 *  The budget covers the tool's default max_chars (6000), so the common case
 *  loses nothing. Trade-off: ~6000 CJK chars ≈ 6000 tokens of a 16K-token
 *  default context — acceptable for an explicit "go read this page" action. */
const FETCH_URL_MAX_CHARS = 6000;
const FETCH_HEAD_BUDGET = 4400;
const FETCH_TAIL_BUDGET = 1300;

/** web_search output is a list of "title\n  snippet\n  url" blocks separated
 *  by blank lines. The generic head+tail cut sliced entries in half mid-URL;
 *  keep whole entries instead. 2400 fits ~8 typical results. */
const WEB_SEARCH_MAX_CHARS = 2400;

/**
 * Compress a tool result before adding it to the conversation context.
 * The UI always receives the full output — this only protects the context
 * window from pollution.
 *
 * - read_file: line-aware truncation with an ACTIONABLE marker that names the
 *   omitted line range and tells the model exactly how to view it.
 * - fetch_url: large budget (the model explicitly asked to read the page);
 *   beyond it, head-weighted cut with the omission made explicit.
 * - web_search: whole result entries are kept, never sliced mid-entry.
 * - run_terminal: error lines are extracted instead of blind truncation.
 * - others: head 800 + tail 600.
 */
export function compressToolResult(output: string, toolName?: string): string {
  if (toolName === 'read_file') return compressReadFileResult(output);
  if (toolName === 'fetch_url') return compressFetchUrlResult(output);
  if (toolName === 'web_search') return compressWebSearchResult(output);

  if (output.length <= MAX_TOOL_RESULT_CHARS) return output;

  if (toolName === 'run_terminal') {
    const lines = output.split('\n');
    const errorLines = lines.filter(l => ERROR_LINE_RE.test(l));
    if (errorLines.length > 0) {
      const picked = errorLines.slice(-12).join('\n');
      const tail = output.slice(-400);
      const combined =
        `[${output.length} chars — error lines extracted]\n${picked}\n…[tail]…\n${tail}`;
      if (combined.length <= MAX_TOOL_RESULT_CHARS + 600) return combined;
      return combined.slice(0, 800) + '\n…\n' + combined.slice(-600);
    }
    // Large output, no error lines: the middle is gone — steer the model to
    // filter at the SOURCE instead of re-running the same command blindly.
    return (
      output.slice(0, 800) +
      `\n…[${output.length - 1400} chars truncated — output is large; if you need the omitted part, ` +
      `re-run with a filter, e.g. | Select-String "keyword" or | Select-Object -First 50]…\n` +
      output.slice(-600)
    );
  }

  const head = output.slice(0, 800);
  const tail = output.slice(-600);
  return head + `\n…[${output.length - 1400} chars truncated]…\n` + tail;
}

function compressFetchUrlResult(output: string): string {
  if (output.length <= FETCH_URL_MAX_CHARS) return output;
  const omitted = output.length - FETCH_HEAD_BUDGET - FETCH_TAIL_BUDGET;
  return (
    output.slice(0, FETCH_HEAD_BUDGET) +
    `\n…[${omitted} chars omitted from the MIDDLE of the page to save context]…\n` +
    output.slice(-FETCH_TAIL_BUDGET)
  );
}

function compressWebSearchResult(output: string): string {
  if (output.length <= WEB_SEARCH_MAX_CHARS) return output;
  const blocks = output.split('\n\n');
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.length + 2 > WEB_SEARCH_MAX_CHARS) break;
    kept.push(block);
    used += block.length + 2;
  }
  // Degenerate case: a single oversized block (e.g. an Instant Answer
  // summary) — fall back to a plain cut rather than dropping everything.
  if (kept.length === 0) {
    return output.slice(0, WEB_SEARCH_MAX_CHARS) + '\n…[truncated]';
  }
  return kept.join('\n\n') + `\n\n[+${blocks.length - kept.length} more results omitted to save context]`;
}

/** Extracts the line number from a read_file output line ("  42\tcode"). */
function parseLineNo(line: string | undefined): number | null {
  const m = line?.match(/^\s*(\d+)\t/);
  return m ? parseInt(m[1], 10) : null;
}

function compressReadFileResult(output: string): string {
  if (output.length <= READ_FILE_MAX_CHARS) return output;

  const lines = output.split('\n');

  // Keep whole lines from the head until the head budget is spent
  let headEnd = 0;
  let used = 0;
  while (headEnd < lines.length && used + lines[headEnd].length + 1 <= READ_HEAD_BUDGET) {
    used += lines[headEnd].length + 1;
    headEnd++;
  }

  // Keep whole lines from the tail until the tail budget is spent
  let tailStart = lines.length;
  used = 0;
  while (tailStart > headEnd && used + lines[tailStart - 1].length + 1 <= READ_TAIL_BUDGET) {
    used += lines[tailStart - 1].length + 1;
    tailStart--;
  }

  if (tailStart <= headEnd) return output; // nothing actually omitted

  const firstOmitted = parseLineNo(lines[headEnd]);
  const lastOmitted = parseLineNo(lines[tailStart - 1]);
  const marker = (firstOmitted !== null && lastOmitted !== null)
    ? `…[lines ${firstOmitted}–${lastOmitted} OMITTED to save context. ` +
      `To view them, call read_file again with start_line=${firstOmitted}, end_line=${lastOmitted}` +
      (lastOmitted - firstOmitted > 60 ? ' (split into chunks of ≤60 lines)' : '') +
      `. This narrower re-read is allowed and does not count as a wasteful re-read.]…`
    : `…[${tailStart - headEnd} lines omitted — re-read a narrower range with start_line/end_line to view them]…`;

  return [...lines.slice(0, headEnd), marker, ...lines.slice(tailStart)].join('\n');
}
