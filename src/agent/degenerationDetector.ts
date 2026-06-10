/**
 * Detects LLM output degeneration (runaway repetition loops).
 *
 * When a local model receives confusing tool output, its token probability
 * distribution can collapse into a repetition spiral that repeat_penalty
 * alone cannot stop. This detector catches that condition early.
 *
 * Algorithm: keep a rolling window of recent output. If the same substring
 * of MIN_PATTERN_LEN or more characters is repeated REPEAT_THRESHOLD times
 * consecutively, declare degeneration.
 */

// Window must hold REPEAT_THRESHOLD copies of the repeating unit. Alternating
// two-variant loops (A B A B …) have an effective unit of len(A)+len(B) —
// observed in the wild at ~250+ chars per pair, so 600 was mathematically
// unable to catch them.
const WINDOW_CHARS = 2000;    // characters to inspect
const MIN_PATTERN_LEN = 20;   // minimum repeated unit to count
const REPEAT_THRESHOLD = 4;   // how many consecutive repeats = degeneration

// Line-frequency detection: catches loops that substring tiling misses
// (alternating variants, interleaved filler) by counting how often the same
// normalized line reappears anywhere in the generation.
const LINE_MIN_LEN = 20;          // ignore short lines („});" etc.)
const LINE_REPEAT_THRESHOLD = 6;  // same line 6 times in one generation = loop

export class DegenerationDetector {
  private buffer = '';
  private pendingLine = '';
  private lineCounts = new Map<string, number>();

  /** Feed new text; returns true if degeneration is detected. */
  feed(chunk: string): boolean {
    this.buffer += chunk;
    if (this.buffer.length > WINDOW_CHARS) {
      this.buffer = this.buffer.slice(this.buffer.length - WINDOW_CHARS);
    }
    if (this.feedLines(chunk)) return true;
    return this.isDegenerated(this.buffer);
  }

  reset(): void {
    this.buffer = '';
    this.pendingLine = '';
    this.lineCounts.clear();
  }

  /** Counts completed lines (normalized); true when any line repeats enough. */
  private feedLines(chunk: string): boolean {
    this.pendingLine += chunk;
    let nl: number;
    let detected = false;
    while ((nl = this.pendingLine.indexOf('\n')) !== -1) {
      const line = this.pendingLine.slice(0, nl);
      this.pendingLine = this.pendingLine.slice(nl + 1);
      const norm = line.trim().replace(/\s+/g, ' ');
      if (norm.length < LINE_MIN_LEN) continue;
      const count = (this.lineCounts.get(norm) ?? 0) + 1;
      this.lineCounts.set(norm, count);
      if (count >= LINE_REPEAT_THRESHOLD) detected = true;
    }
    return detected;
  }

  private isDegenerated(text: string): boolean {
    if (text.length < MIN_PATTERN_LEN * REPEAT_THRESHOLD) return false;

    // Try pattern lengths from large to small; detect the first clear repetition.
    const maxPatLen = Math.floor(text.length / REPEAT_THRESHOLD);
    for (let len = maxPatLen; len >= MIN_PATTERN_LEN; len--) {
      const tail = text.slice(text.length - len);
      let count = 1;
      let pos = text.length - len - len;
      while (pos >= 0 && text.slice(pos, pos + len) === tail) {
        count++;
        pos -= len;
        if (count >= REPEAT_THRESHOLD) return true;
      }
    }
    return false;
  }
}

/**
 * Detects unbounded self-correction loops: the model keeps discarding its own
 * draft with "wait, actually let's reconsider / let me refine / scratch that"
 * and redrafting from scratch with different wording each time.
 *
 * Unlike DegenerationDetector (literal substring repetition), the redrafts
 * here differ textually, so substring matching doesn't catch it — instead
 * this counts self-correction marker phrases across the whole generation.
 */
// STRONG markers: explicit draft-discarding phrases — rare in healthy output.
const STRONG_MARKERS =
  /\*self-correction\*|\bre-?evaluat\w*|\b(?:let'?s|let me)\s+(?:refine|reconsider|re-?think|redo|revise)\b|\bon second thought\b|\bscratch that\b|やっぱり|考え直|見直そう|やり直|すみません、|失礼しました/gi;

// WEAK markers: "wait," appears constantly in HEALTHY chain-of-thought
// (observed: Gemma4 reached a correct root-cause diagnosis with 2–3 "Wait,"s
// and a threshold of 3 aborted it mid-diagnosis). Only a much higher count
// indicates a true self-correction spiral.
const WEAK_MARKERS = /\bwait,/gi;

const STRONG_THRESHOLD = 3;
const WEAK_THRESHOLD = 8;

export class SelfCorrectionDetector {
  private buffer = '';

  /** Feed new text; returns true once marker phrases reach the threshold count. */
  feed(chunk: string): boolean {
    this.buffer += chunk;
    const strong = this.buffer.match(STRONG_MARKERS)?.length ?? 0;
    if (strong >= STRONG_THRESHOLD) return true;
    const weak = this.buffer.match(WEAK_MARKERS)?.length ?? 0;
    return weak >= WEAK_THRESHOLD;
  }

  reset(): void {
    this.buffer = '';
  }
}
