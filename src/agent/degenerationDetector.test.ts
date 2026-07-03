import { describe, it, expect, beforeEach } from 'vitest';
import { DegenerationDetector, SelfCorrectionDetector } from './degenerationDetector';

describe('DegenerationDetector', () => {
  let detector: DegenerationDetector;

  beforeEach(() => {
    detector = new DegenerationDetector();
  });

  it('does not flag normal prose', () => {
    const text =
      'This function reads the file, parses the AST, and returns the list of exported symbols found in it.';
    expect(detector.feed(text)).toBe(false);
  });

  it('detects a substring repeated many times consecutively', () => {
    const unit = 'this is a repeating pattern that keeps coming back again and again. ';
    const text = unit.repeat(6);
    expect(detector.feed(text)).toBe(true);
  });

  it('detects repetition split across multiple feed() calls', () => {
    const unit = 'the model keeps saying the exact same sentence over and over now. ';
    let detected = false;
    for (let i = 0; i < 6; i++) {
      detected = detector.feed(unit) || detected;
    }
    expect(detected).toBe(true);
  });

  it('detects a line repeated beyond the line-frequency threshold', () => {
    const line = 'console.log("this exact line keeps repeating in the output");\n';
    let detected = false;
    for (let i = 0; i < 6; i++) {
      detected = detector.feed(line) || detected;
    }
    expect(detected).toBe(true);
  });

  it('ignores short repeated lines below LINE_MIN_LEN', () => {
    // Kept short enough that the substring-repetition check (buffer < 80 chars)
    // can't fire either — this isolates the per-line length filter.
    const line = '});\n';
    let detected = false;
    for (let i = 0; i < 15; i++) {
      detected = detector.feed(line) || detected;
    }
    expect(detected).toBe(false);
  });

  it('reset() clears buffered state', () => {
    const unit = 'a fairly long repeating chunk of output text goes here. ';
    detector.feed(unit.repeat(3));
    detector.reset();
    // Only 3 more repeats after reset — below REPEAT_THRESHOLD(4) on its own.
    expect(detector.feed(unit.repeat(3))).toBe(false);
  });
});

describe('SelfCorrectionDetector', () => {
  let detector: SelfCorrectionDetector;

  beforeEach(() => {
    detector = new SelfCorrectionDetector();
  });

  it('does not flag healthy chain-of-thought with a couple of "wait,"', () => {
    const text = 'Wait, let me check the error message. Wait, that confirms the root cause.';
    expect(detector.feed(text)).toBe(false);
  });

  it('flags output once strong self-correction markers hit the threshold', () => {
    const text =
      'Let me reconsider this approach. On second thought, scratch that. Let me redo the whole thing.';
    expect(detector.feed(text)).toBe(true);
  });

  it('flags output once weak "wait," markers hit their higher threshold', () => {
    const text = Array(8).fill('wait,').join(' actually ');
    expect(detector.feed(text)).toBe(true);
  });

  it('detects Japanese self-correction markers', () => {
    const text = 'やっぱり違う。考え直してみる。もう一度やり直す。';
    expect(detector.feed(text)).toBe(true);
  });

  it('reset() clears the marker count', () => {
    detector.feed('let me reconsider. on second thought, scratch that.');
    detector.reset();
    expect(detector.feed('wait, one more check')).toBe(false);
  });
});
