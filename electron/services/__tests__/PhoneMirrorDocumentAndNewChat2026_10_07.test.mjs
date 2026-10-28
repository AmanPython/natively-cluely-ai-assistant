// Phone Mirror: session PDF/text upload + New chat command.
// Platform-agnostic (loopback HTTP / ws). Same port guard as other PhoneMirror tests.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const require = createRequire(path.join(repoRoot, 'package.json'));
const WS = require('ws').WebSocket;
const http = require('node:http');

const serviceBundle = process.env.PHONE_MIRROR_SERVICE_BUNDLE
  ? path.resolve(process.env.PHONE_MIRROR_SERVICE_BUNDLE)
  : path.resolve(repoRoot, 'dist-electron/electron/services/PhoneMirrorService.js');
const clientBundle = process.env.PHONE_MIRROR_CLIENT_BUNDLE
  ? path.resolve(process.env.PHONE_MIRROR_CLIENT_BUNDLE)
  : path.resolve(repoRoot, 'dist-electron/electron/services/phoneMirrorClient.js');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-pm-doc-'));
const electronStub = {
  app: { isReady: () => true, getPath: () => userDataDir, whenReady: () => Promise.resolve(), on: () => {} },
  BrowserWindow: class {
    static getFocusedWindow() { return null; }
    static getAllWindows() { return []; }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^enc:/, ''),
  },
};
const originalLoad = Module._load;
const originalListen = http.Server.prototype.listen;

let svc;
let info;
before(async () => {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  http.Server.prototype.listen = function (...args) {
    if (typeof args[0] === 'number' && args[0] >= 4123 && args[0] < 4135) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('taken (test)'), { code: 'EADDRINUSE' })));
      return this;
    }
    return originalListen.apply(this, args);
  };
  const mod = await import(pathToFileURL(serviceBundle).href);
  svc = mod.PhoneMirrorService.getInstance();
  info = await svc.start({ exposeOnLan: false, persist: false });
  assert.ok(info.port < 4123 || info.port >= 4135, `must never use a port a real Natively may hold (got ${info.port})`);
});

after(async () => {
  svc?.clearSessionDocuments?.();
  if (svc?.isRunning()) await svc.stop({ persist: false });
  Module._load = originalLoad;
  http.Server.prototype.listen = originalListen;
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  svc.clearSessionDocuments();
});

const url = (pathname, token) =>
  `http://127.0.0.1:${info.port}${pathname}${token === null ? '' : `?t=${encodeURIComponent(token)}`}`;

async function postDoc(body, { token = info.token, fileName = 'notes.txt', method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (fileName !== null) headers['X-Filename'] = fileName;
  const res = await fetch(url('/document', token), {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

describe('phone document upload (POST /document)', () => {
  test('a text file becomes a session document', async () => {
    const r = await postDoc(Buffer.from('Q3 revenue was 12 million'), { fileName: 'brief.txt' });
    assert.equal(r.status, 200);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json?.fileName, 'brief.txt');
    assert.ok(typeof r.json?.id === 'string');
    const listed = svc.getDocuments();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].fileName, 'brief.txt');
  });

  test('no token, wrong token, missing filename, or GET → refused', async () => {
    const body = Buffer.from('hello');
    assert.equal((await postDoc(body, { token: null })).status, 401);
    assert.equal((await postDoc(body, { token: 'x'.repeat(32) })).status, 401);
    assert.equal((await postDoc(body, { fileName: null })).status, 400);
    assert.equal((await postDoc(body, { fileName: '../secret.exe' })).status, 400);
    assert.equal((await postDoc(body, { method: 'GET' })).status, 405);
    assert.equal(svc.getDocuments().length, 0);
  });

  test('the page has the document picker and New chat', () => {
    const { PHONE_MIRROR_HTML: html } = require(clientBundle);
    assert.match(html, /id="docInput"/);
    assert.match(html, /id="docBtn"/);
    assert.match(html, /data-menu="new-chat"/);
    assert.match(html, /id="docTray"/);
  });
});

describe('phone new-chat and detach-document commands', () => {
  test('new-chat and detach-document reach onPhoneCommand', async () => {
    const received = [];
    const off = svc.onPhoneCommand((cmd) => received.push(cmd));
    const ws = new WS(`ws://127.0.0.1:${info.port}/ws?t=${encodeURIComponent(info.token)}`);
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const id = '11111111-1111-1111-1111-111111111111';
    ws.send(JSON.stringify({ type: 'new-chat' }));
    ws.send(JSON.stringify({ type: 'detach-document', id }));
    ws.send(JSON.stringify({ type: 'detach-document', id: 'not-a-uuid' }));
    await new Promise((r) => setTimeout(r, 150));
    ws.close();
    off?.();
    assert.deepEqual(received, [
      { type: 'new-chat' },
      { type: 'detach-document', id },
    ]);
  });
});
