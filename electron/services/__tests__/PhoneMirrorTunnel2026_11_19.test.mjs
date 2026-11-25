import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (f) => import(pathToFileURL(path.resolve(root, 'dist-electron/electron/services', f)).href);

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  return { child, spawn, calls };
}
const deps = (platform, extra = {}) => ({
  platform, env: { PATH: '' }, userDataDir: path.join('u', 'data'),
  isFile: () => true, writeEmptyConfig: () => {}, ...extra,
});

test('binary name and install hint differ per platform', async () => {
  const m = await load('PhoneMirrorTunnel.js');
  assert.equal(m.cloudflaredBinaryName('win32'), 'cloudflared.exe');
  assert.equal(m.cloudflaredBinaryName('darwin'), 'cloudflared');
  assert.throws(() => m.cloudflaredBinaryName('linux'));
  assert.match(m.installHint('darwin'), /brew/);
  assert.match(m.installHint('win32'), /winget/);
});

test('candidates: darwin searches Homebrew, win32 searches Program Files/WinGet', async () => {
  const m = await load('PhoneMirrorTunnel.js');
  const mac = m.cloudflaredCandidates({ platform: 'darwin', env: {}, userDataDir: 'u' });
  assert.ok(mac.includes(path.join('/opt/homebrew/bin', 'cloudflared')));
  const win = m.cloudflaredCandidates({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' },
    userDataDir: 'u',
  });
  assert.ok(win.some((p) => p.endsWith('cloudflared.exe')));
  assert.ok(win.some((p) => p.includes('WinGet')));
  assert.ok(!win.some((p) => p.includes('homebrew')));
});

test('parseTunnelUrl finds the quick-tunnel host and ignores the API host', async () => {
  const m = await load('PhoneMirrorTunnel.js');
  assert.equal(
    m.parseTunnelUrl('INF |  https://fancy-words-here.trycloudflare.com  |'),
    'https://fancy-words-here.trycloudflare.com',
  );
  assert.equal(m.parseTunnelUrl('ERR Post "https://api.trycloudflare.com/tunnel": dial tcp'), null);
  assert.equal(m.parseTunnelUrl('no url here'), null);
});

test('args: empty config, loopback origin, no autoupdate', async () => {
  const m = await load('PhoneMirrorTunnel.js');
  const a = m.buildTunnelArgs(4123, 'cfg.yml');
  assert.deepEqual(a, ['--config', 'cfg.yml', 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4123']);
  assert.equal(m.buildTunnelPairingUrl('https://a.trycloudflare.com', 'tok'), 'https://a.trycloudflare.com/?t=tok');
  assert.equal(m.buildTunnelPairingUrl(null, 'tok'), null);
});

for (const platform of ['darwin', 'win32']) {
  test(`lifecycle on ${platform}: starting -> running -> stop kills child`, async () => {
    const { PhoneMirrorTunnel } = await load('PhoneMirrorTunnel.js');
    const f = fakeSpawn();
    const t = new PhoneMirrorTunnel(deps(platform, { spawn: f.spawn }));
    const seen = [];
    t.onStatus((s) => seen.push(s.state));
    await t.start(4123);
    assert.equal(t.getStatus().state, 'starting');
    assert.equal(f.calls[0].opts.windowsHide, true);
    f.child.stderr.emit('data', 'INF https://abc-def.trycloudflare.com\n');
    assert.equal(t.getStatus().state, 'running');
    assert.equal(t.getStatus().url, 'https://abc-def.trycloudflare.com');
    await t.stop();
    assert.equal(f.child.killed, true);
    assert.deepEqual(seen, ['starting', 'running', 'off']);
  });
}

test('missing binary -> not-installed error with platform hint', async () => {
  const { PhoneMirrorTunnel } = await load('PhoneMirrorTunnel.js');
  const t = new PhoneMirrorTunnel(deps('win32', { isFile: () => false }));
  const s = await t.start(1);
  assert.equal(s.state, 'error');
  assert.equal(s.errorCode, 'not-installed');
  assert.match(s.error, /winget/);
});

test('unexpected exit and timeout surface as errors', async () => {
  const { PhoneMirrorTunnel } = await load('PhoneMirrorTunnel.js');
  let f = fakeSpawn();
  let t = new PhoneMirrorTunnel(deps('darwin', { spawn: f.spawn }));
  await t.start(1);
  f.child.stderr.emit('data', 'ERR failed to connect to the edge\n');
  f.child.emit('exit', 1, null);
  assert.equal(t.getStatus().errorCode, 'exited');
  assert.match(t.getStatus().error, /failed to connect/);

  f = fakeSpawn();
  t = new PhoneMirrorTunnel(deps('win32', { spawn: f.spawn, startTimeoutMs: 20 }));
  await t.start(1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.getStatus().errorCode, 'timeout');
  assert.equal(f.child.killed, true);
});

test('requestIdentity: tunnelled requests are never loopback', async () => {
  const { requestIdentity } = await load('phoneMirrorRequestIdentity.js');
  const local = requestIdentity('127.0.0.1', {});
  assert.deepEqual([local.loopback, local.viaProxy, local.ip], [true, false, '127.0.0.1']);
  const tunnelled = requestIdentity('::ffff:127.0.0.1', { 'cf-connecting-ip': '8.8.8.8', 'cf-ray': 'x' });
  assert.equal(tunnelled.loopback, false);
  assert.equal(tunnelled.viaProxy, true);
  assert.equal(tunnelled.ip, 'proxy:8.8.8.8');
  assert.equal(requestIdentity('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }).loopback, false);
  assert.equal(requestIdentity('192.168.1.9', {}).loopback, false);
});
