/**
 * Mic echo gate.
 *
 * With laptop speakers the mic re-records the meeting, so the mic channel
 * transcribes the other person too (Soniox/Deepgram do it nearly perfectly,
 * which is why both channels show the same sentence). The system-audio
 * channel is the clean copy, so mic audio is silenced (same length, timing
 * kept) while the meeting is audible, unless the mic is clearly louder than
 * the echo the speakers produce, i.e. the user is talking over it.
 *
 * "Echo level" is learned: the ratio of mic to system level while the mic is
 * assumed to carry only echo. With headphones it settles near zero and the
 * user is never gated. Mic audio is held back MIC_DELAY_MS so the system
 * channel, which arrives later than the mic, has reported by decision time.
 *
 * Level-only (no sample rates), so it is independent of the capture format.
 * Platform-independent; both captures deliver Int16LE mono.
 */

export const MIC_DELAY_MS = 700;
const SYSTEM_ACTIVE_RMS = 0.006;
const LOOK_BACK_MS = 300; // room reverb after the system audio stops
const PASS_FACTOR = 2.5; // mic must beat the learned echo by this much
const COUPLING_START = 1.0; // assume the worst until measured
const COUPLING_FALL = 0.1; // quick to trust a quieter echo
const COUPLING_RISE = 0.01; // slow to believe a louder one: that is likely the user
const COUPLING_CAP = 2.0; // ratios above this are the user, not echo
const HISTORY_MS = 3000;

export function rmsInt16(chunk: Buffer): number {
  const n = chunk.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = chunk.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

interface Held {
  at: number;
  chunk: Buffer;
  rms: number;
}

export class MicEchoGate {
  private system: Array<{ at: number; rms: number }> = [];
  private held: Held[] = [];
  private coupling = COUPLING_START;

  /** Call for every system-audio chunk. */
  noteSystem(chunk: Buffer, now: number): void {
    this.system.push({ at: now, rms: rmsInt16(chunk) });
    const cutoff = now - HISTORY_MS;
    while (this.system.length && this.system[0].at < cutoff) this.system.shift();
  }

  /** Feeds a mic chunk; returns the chunks now due, oldest first, gated. */
  pushMic(chunk: Buffer, now: number): Buffer[] {
    this.held.push({ at: now, chunk, rms: rmsInt16(chunk) });
    const out: Buffer[] = [];
    while (this.held.length && this.held[0].at <= now - MIC_DELAY_MS) {
      out.push(this.decide(this.held.shift()!));
    }
    return out;
  }

  reset(): void {
    this.system = [];
    this.held = [];
    this.coupling = COUPLING_START;
  }

  private decide(item: Held): Buffer {
    const from = item.at - LOOK_BACK_MS;
    const to = item.at + MIC_DELAY_MS;
    let ref = 0;
    for (const s of this.system) if (s.at >= from && s.at <= to && s.rms > ref) ref = s.rms;
    if (ref < SYSTEM_ACTIVE_RMS) return item.chunk;

    const ratio = item.rms / ref;
    if (ratio <= COUPLING_CAP) {
      this.coupling += (ratio < this.coupling ? COUPLING_FALL : COUPLING_RISE) * (ratio - this.coupling);
    }
    if (item.rms > PASS_FACTOR * this.coupling * ref) return item.chunk;
    return Buffer.alloc(item.chunk.length);
  }
}
