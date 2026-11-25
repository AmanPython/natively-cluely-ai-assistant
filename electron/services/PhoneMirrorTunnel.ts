import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Internet access for Phone Mirror through a Cloudflare "quick tunnel"
 * (`cloudflared tunnel --url http://127.0.0.1:<port>`).
 *
 * The tunnel is an outbound-only connection from this machine to Cloudflare, so
 * it needs no router/firewall changes, and cloudflared dials the mirror on
 * loopback — LAN exposure is NOT required for it. Every tunnelled request
 * therefore arrives at PhoneMirrorService from 127.0.0.1; the service tells
 * them apart by the Cloudflare edge headers (see requestIdentity in
 * PhoneMirrorService) so that "loopback" never grants the extension's powers
 * to someone on the internet.
 *
 * Platform surface (kept here, injectable for tests):
 *  - darwin: GUI apps do not inherit the shell PATH, so Homebrew locations are
 *    searched explicitly.
 *  - win32: `cloudflared.exe`, winget / installer locations, no POSIX signals —
 *    ChildProcess.kill() terminates the process on Windows.
 */

export type TunnelState = 'off' | 'starting' | 'running' | 'error';

export type TunnelErrorCode =
  | 'not-installed'
  | 'spawn-failed'
  | 'timeout'
  | 'exited'
  | 'unsupported-platform';

export interface TunnelStatus {
  state: TunnelState;
  /** https://<random>.trycloudflare.com — no token, safe to log. */
  url: string | null;
  error: string | null;
  errorCode: TunnelErrorCode | null;
}

export const TUNNEL_START_TIMEOUT_MS = 30_000;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const LOG_TAIL_LINES = 12;

export const OFF_STATUS: TunnelStatus = { state: 'off', url: null, error: null, errorCode: null };

export function cloudflaredBinaryName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'cloudflared.exe';
  if (platform === 'darwin') return 'cloudflared';
  throw new Error(`Unsupported platform: ${platform}`);
}

/** Install instructions for the platform, shown when the binary is missing. */
export function installHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Install it with "brew install cloudflared", then try again.';
  if (platform === 'win32') return 'Install it with "winget install Cloudflare.cloudflared", then try again.';
  return 'Install cloudflared, then try again.';
}

export interface CandidateContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** process.resourcesPath in a packaged app, otherwise undefined. */
  resourcesPath?: string;
  userDataDir: string;
}

/** Ordered places to look for cloudflared. Pure — no filesystem access. */
export function cloudflaredCandidates(ctx: CandidateContext): string[] {
  const { platform, env, resourcesPath, userDataDir } = ctx;
  const name = cloudflaredBinaryName(platform);
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };

  add(env.NATIVELY_CLOUDFLARED_PATH);
  if (resourcesPath) add(path.join(resourcesPath, 'cloudflared', name));
  add(path.join(userDataDir, 'bin', name));

  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (dir) add(path.join(dir, name));
  }

  if (platform === 'darwin') {
    add(path.join('/opt/homebrew/bin', name));
    add(path.join('/usr/local/bin', name));
  } else {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (base) add(path.join(base, 'cloudflared', name));
    }
    if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name));
  }
  return out;
}

export function findCloudflared(
  ctx: CandidateContext,
  isFile: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  for (const candidate of cloudflaredCandidates(ctx)) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Extract the quick-tunnel URL from a cloudflared log line, or null. */
export function parseTunnelUrl(line: string): string | null {
  const m = TUNNEL_URL_RE.exec(line);
  if (!m) return null;
  // api.trycloudflare.com appears in cloudflared's own error text — it is the
  // control plane, never a tunnel hostname.
  if (m[0].toLowerCase() === 'https://api.trycloudflare.com') return null;
  return m[0].toLowerCase();
}

/**
 * `--config <empty file>` stops a user's ~/.cloudflared/config.yml from
 * turning this quick tunnel into a named-tunnel run (cloudflared rejects
 * `--url` quick tunnels when that file exists).
 */
export function buildTunnelArgs(port: number, emptyConfigPath: string): string[] {
  return ['--config', emptyConfigPath, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
}

/** Compose the link a phone opens: the tunnel origin plus the pairing token. */
export function buildTunnelPairingUrl(tunnelUrl: string | null, token: string | null): string | null {
  if (!tunnelUrl || !token) return null;
  return `${tunnelUrl}/?t=${token}`;
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;
type StatusListener = (status: TunnelStatus) => void;

export interface TunnelDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  resourcesPath?: string;
  userDataDir: string;
  spawn?: SpawnFn;
  isFile?: (p: string) => boolean;
  writeEmptyConfig?: (p: string) => void;
  startTimeoutMs?: number;
}

export class PhoneMirrorTunnel {
  private child: ChildProcess | null = null;
  private status: TunnelStatus = OFF_STATUS;
  private listeners = new Set<StatusListener>();
  private timer: NodeJS.Timeout | null = null;
  private logTail: string[] = [];
  /** Bumped on every start/stop so a late event from a dead child is ignored. */
  private generation = 0;

  constructor(private readonly deps: TunnelDeps) {}

  getStatus(): TunnelStatus {
    return this.status;
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(port: number): Promise<TunnelStatus> {
    if (this.status.state === 'starting' || this.status.state === 'running') return this.status;
    const gen = ++this.generation;
    this.logTail = [];

    let binary: string | null;
    try {
      binary = findCloudflared(
        {
          platform: this.deps.platform,
          env: this.deps.env,
          resourcesPath: this.deps.resourcesPath,
          userDataDir: this.deps.userDataDir,
        },
        this.deps.isFile,
      );
    } catch {
      return this.set({
        state: 'error',
        url: null,
        errorCode: 'unsupported-platform',
        error: `Internet access is not supported on ${this.deps.platform}.`,
      });
    }
    if (!binary) {
      return this.set({
        state: 'error',
        url: null,
        errorCode: 'not-installed',
        error: `cloudflared was not found. ${installHint(this.deps.platform)}`,
      });
    }

    const emptyConfig = path.join(this.deps.userDataDir, 'cloudflared-empty.yml');
    try {
      (this.deps.writeEmptyConfig ?? defaultWriteEmptyConfig)(emptyConfig);
    } catch (e: any) {
      return this.set({
        state: 'error',
        url: null,
        errorCode: 'spawn-failed',
        error: `Could not prepare the tunnel: ${e?.message || e}`,
      });
    }

    this.set({ state: 'starting', url: null, error: null, errorCode: null });

    let child: ChildProcess;
    try {
      child = (this.deps.spawn ?? (nodeSpawn as unknown as SpawnFn))(binary, buildTunnelArgs(port, emptyConfig), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e: any) {
      return this.fail(gen, 'spawn-failed', `Could not start cloudflared: ${e?.message || e}`);
    }
    this.child = child;

    const onChunk = (chunk: Buffer | string) => {
      if (gen !== this.generation) return;
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logTail.push(line.trim());
        if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
        if (this.status.state !== 'starting') continue;
        const url = parseTunnelUrl(line);
        if (url) {
          this.clearTimer();
          this.set({ state: 'running', url, error: null, errorCode: null });
        }
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('error', (e: any) => {
      if (gen !== this.generation) return;
      this.fail(
        gen,
        e?.code === 'ENOENT' ? 'not-installed' : 'spawn-failed',
        e?.code === 'ENOENT'
          ? `cloudflared was not found. ${installHint(this.deps.platform)}`
          : `Could not start cloudflared: ${e?.message || e}`,
      );
    });
    child.once('exit', (code, signal) => {
      if (gen !== this.generation) return;
      this.child = null;
      this.fail(
        gen,
        'exited',
        `cloudflared stopped (${signal ?? `exit code ${code}`}). ${this.lastUsefulLogLine()}`.trim(),
      );
    });

    this.timer = setTimeout(() => {
      if (gen !== this.generation || this.status.state !== 'starting') return;
      this.killChild();
      this.fail(
        gen,
        'timeout',
        `Cloudflare did not hand out a link within ${Math.round((this.deps.startTimeoutMs ?? TUNNEL_START_TIMEOUT_MS) / 1000)}s. Check your internet connection and try again.`,
      );
    }, this.deps.startTimeoutMs ?? TUNNEL_START_TIMEOUT_MS);
    this.timer.unref?.();

    return this.status;
  }

  async stop(): Promise<TunnelStatus> {
    this.generation++;
    this.clearTimer();
    this.killChild();
    return this.set(OFF_STATUS);
  }

  private fail(gen: number, code: TunnelErrorCode, message: string): TunnelStatus {
    if (gen !== this.generation) return this.status;
    this.clearTimer();
    this.killChild();
    return this.set({ state: 'error', url: null, errorCode: code, error: message });
  }

  private lastUsefulLogLine(): string {
    for (let i = this.logTail.length - 1; i >= 0; i--) {
      const l = this.logTail[i];
      if (/\b(ERR|error|failed|unable)\b/i.test(l)) return l.replace(/^\S+\s+(ERR|INF|WRN)\s+/, '').slice(0, 200);
    }
    return '';
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.removeAllListeners('exit');
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(next: TunnelStatus): TunnelStatus {
    this.status = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        /* a bad listener must not break the tunnel */
      }
    }
    return next;
  }
}

function defaultWriteEmptyConfig(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '# intentionally empty: keeps quick tunnels independent of ~/.cloudflared\n');
}
