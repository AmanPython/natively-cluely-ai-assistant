/**
 * Cross-channel echo filter.
 *
 * On laptop speakers the mic hears the meeting too, so the mic ("user")
 * channel transcribes the other person's words a second time, usually garbled
 * and sometimes fused with the user's own speech. The system-audio
 * ("interviewer") channel is the clean copy, so words in a mic segment that
 * also appear in the interviewer's recent text are removed from the mic
 * segment.
 *
 * Platform-independent text logic; the audio itself is untouched.
 */

const WINDOW_MS = 20_000;
/** A run this long (in words) shared with the interviewer is treated as echo. */
const MIN_RUN = 4;
/** A shorter run (2+) only counts when it explains most of the segment. */
const MIN_SHORT_RUN = 2;
const WHOLE_SEGMENT_COVERAGE = 0.7;
const FUZZY_MIN_LEN = 5;
const FUZZY_RATIO = 0.8;

interface Heard {
  at: number;
  words: string[];
}

const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < FUZZY_MIN_LEN || b.length < FUZZY_MIN_LEN) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

const sameWord = (a: string, b: string): boolean => similarity(a, b) >= FUZZY_RATIO;

export class CrossChannelEchoFilter {
  private heard: Heard[] = [];

  /** Records what the system-audio channel just said (partials and finals). */
  noteInterviewer(text: string, now: number = Date.now()): void {
    const words = text.split(/\s+/).map(normalize).filter(Boolean);
    if (!words.length) return;
    this.heard.push({ at: now, words });
    this.prune(now);
  }

  /**
   * Returns the mic text with words the interviewer channel also produced
   * removed, or '' when nothing of the user's own speech is left.
   */
  filterUser(text: string, now: number = Date.now()): string {
    this.prune(now);
    if (!this.heard.length) return text;

    const original = text.split(/\s+/).filter(Boolean);
    const words = original.map(normalize);
    const reference = this.heard.flatMap((h) => h.words);
    const echoed = new Array<boolean>(words.length).fill(false);
    const runs: Array<{ start: number; length: number }> = [];

    for (let i = 0; i < words.length; ) {
      let best = 0;
      if (words[i]) {
        for (let r = 0; r < reference.length; r++) {
          let len = 0;
          while (i + len < words.length && r + len < reference.length && words[i + len]
            && sameWord(words[i + len], reference[r + len])) len++;
          if (len > best) best = len;
        }
      }
      if (best >= MIN_SHORT_RUN) runs.push({ start: i, length: best });
      i += Math.max(best, 1);
    }

    const total = words.filter(Boolean).length;
    let covered = 0;
    for (const run of runs) covered += run.length;
    const wholeSegment = total > 0 && covered / total >= WHOLE_SEGMENT_COVERAGE;
    for (const run of runs) {
      if (run.length >= MIN_RUN || wholeSegment) {
        for (let k = 0; k < run.length; k++) echoed[run.start + k] = true;
      }
    }

    const kept = original.filter((_, i) => !echoed[i]);
    const removed = original.length - kept.length;
    // A word or two left beside a much longer removed echo is its ragged edge, not speech.
    if (removed >= MIN_RUN && kept.length <= 2 && removed >= kept.length * 4) return '';
    return kept.join(' ');
  }

  reset(): void {
    this.heard = [];
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.heard.length && this.heard[0].at < cutoff) this.heard.shift();
  }
}
