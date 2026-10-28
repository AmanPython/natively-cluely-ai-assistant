import { EventEmitter } from 'events';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

/**
 * Underdog Bark 3.0 (on-device, English, Apple silicon / MLX) via a Python
 * worker — see resources/bark/bark_worker.py for the line protocol. One
 * instance per audio channel, so mic ("user") and system audio ("interviewer")
 * are transcribed independently and never need diarization.
 *
 * Install layout (created by hand, outside the repo): ~/.natively-bark/
 *   .venv/            python with mlx, mlx-audio, constriction, numpy, soundfile, soxr
 *   bark-3.0/         model.bark, bark_mlx.py, bark_loader.py, mlx/
 * NATIVELY_BARK_HOME overrides the base directory.
 */
const STARTUP_TIMEOUT_MS = 180_000; // first run unpacks the model (~6 GB RAM, one time)

export function barkHome(): string {
  return process.env.NATIVELY_BARK_HOME || path.join(os.homedir(), '.natively-bark');
}
function workerScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bark', 'bark_worker.py')
    : path.join(app.getAppPath(), 'resources', 'bark', 'bark_worker.py');
}

export class BarkSTT extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sampleRate = 16000;
  private active = false;
  private ready = false;
  private blocked = false;
  private generation = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private finalizePending = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private channel = 'mic';

  setChannel(channel: 'mic' | 'system') { this.channel = channel; }
  setRecognitionLanguage(_language: string) { /* Bark 3.0 is English-only. */ }
  setCredentials(_path: string): void { /* On-device; no credentials. */ }
  setSampleRate(rate: number) {
    if (Number.isFinite(rate) && rate >= 8000 && rate <= 192000) this.sampleRate = rate;
  }
  setAudioChannelCount(count: number) { if (count !== 1) this.fail('Bark expects mono audio.'); }

  start() {
    if (this.active) return;
    this.active = true; this.ready = false; this.blocked = false; this.finalizePending = false;
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      this.fail('Bark runs on Apple silicon Macs only. Choose a different speech provider in Audio settings.'); return;
    }
    const python = path.join(barkHome(), '.venv', 'bin', 'python');
    const script = workerScriptPath();
    if (!fs.existsSync(python) || !fs.existsSync(path.join(barkHome(), 'bark-3.0', 'model.bark'))) {
      this.fail(`Bark is not installed. Expected ${python} and ${path.join(barkHome(), 'bark-3.0', 'model.bark')}.`); return;
    }
    const generation = ++this.generation;
    const child = this.child = spawn(python, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NATIVELY_BARK_HOME: barkHome() },
    });
    const current = () => this.child === child && generation === this.generation;
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!current()) return;
      output += chunk;
      let end: number;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        if (!line) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; } // tolerate stray library output
        if (message.type === 'ready') {
          this.ready = true;
          if (this.startupTimer) clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this.emit('ready'); this.drain();
        } else if (message.type === 'transcript' && typeof message.text === 'string' && message.text.trim()) {
          this.emit('transcript', { text: message.text, isFinal: !!message.isFinal, confidence: 0.9 });
        } else if (message.type === 'error') { this.fail(String(message.message)); return; }
        else if (message.type === 'status') this.emit('status', message.message);
      }
    });
    child.stderr.on('data', () => {}); // drained so the child never blocks; never log audio
    child.stdin.on('error', (err) => { if (current() && this.active) this.fail(err.message); });
    child.on('error', (err) => { if (current()) this.fail(`Cannot start Bark: ${err.message}`); });
    child.on('exit', (code, signal) => {
      if (current() && this.active) this.fail(`Bark stopped unexpectedly (${signal ?? code}). Restart the session.`);
    });
    child.stdin.on('drain', () => { if (current()) { this.blocked = false; this.drain(); } });
    child.stdin.write('{"type":"init"}\n');
    this.startupTimer = setTimeout(
      () => this.fail('Bark did not become ready within 3 minutes. Check ~/.natively-bark.'),
      STARTUP_TIMEOUT_MS,
    );
  }

  write(chunk: Buffer) {
    if (!this.active || !chunk.length) return;
    if (chunk.length % 2) { this.fail('Invalid Int16 audio buffer.'); return; }
    this.pending.push(Buffer.from(chunk)); this.pendingBytes += chunk.length;
    // Keep the most recent 30 s while the model loads or a long phrase is being
    // transcribed; drop the oldest audio rather than failing the session.
    const maxBytes = this.sampleRate * 2 * 30;
    while (this.pendingBytes > maxBytes && this.pending.length) this.pendingBytes -= this.pending.shift()!.length;
    this.drain();
  }

  private drain() {
    while (this.ready && !this.blocked && this.child && this.pending.length) {
      const pcm = this.pending.shift()!; this.pendingBytes -= pcm.length;
      this.blocked = !this.child.stdin.write(JSON.stringify({ type: 'audio', sampleRate: this.sampleRate, pcm: pcm.toString('base64') }) + '\n');
    }
    if (this.ready && !this.blocked && this.child && !this.pending.length && this.finalizePending) {
      this.finalizePending = false;
      this.blocked = !this.child.stdin.write('{"type":"flush"}\n');
    }
  }

  finalize(): boolean {
    if (!this.active || !this.ready || !this.child) return false;
    this.finalizePending = true;
    this.drain();
    return true;
  }

  stop() {
    this.active = false; this.ready = false; this.blocked = false; this.finalizePending = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.pending = []; this.pendingBytes = 0;
    const child = this.child;
    if (child && !child.killed) {
      child.stdin.end('{"type":"stop"}\n');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
  }

  private fail(message: string) {
    this.active = false; this.ready = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.pending = []; this.pendingBytes = 0;
    const child = this.child; this.child = null;
    if (child && !child.killed) child.kill('SIGKILL');
    // Same code Apple Speech uses, so the existing "local STT unavailable" handling applies.
    this.emit('error', Object.assign(new Error(message), { code: 'local_stt_unavailable' }));
  }
}
