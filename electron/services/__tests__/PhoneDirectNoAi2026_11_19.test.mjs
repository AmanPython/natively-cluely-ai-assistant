import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

test('web page has a Direct toggle that sends type:direct, not chat', () => {
  const { PHONE_MIRROR_HTML: html } = require(path.resolve(root, 'dist-electron/electron/services/phoneMirrorClient.js'));
  assert.match(html, /id="directBtn"/);
  assert.match(html, /sendCommand\(\{ type: 'direct', message: text \}\)/);
});

test('desktop direct handler never reaches a model, saves to session and shows in overlay', () => {
  const src = read('electron/ipcHandlers.ts');
  const start = src.indexOf("cmd.type === 'direct'");
  const end = src.indexOf("cmd.type === 'chat'", start);
  assert.ok(start > 0 && end > start);
  const branch = src.slice(start, end);
  assert.doesNotMatch(branch, /streamChat|llmHelper|getLLMHelper|planAnswer|generate/i);
  assert.match(branch, /store_conversational_only/);
  assert.match(branch, /phone-mirror:incoming-direct/);
});

test('server validates direct frames with its own larger limit', () => {
  const src = read('electron/services/PhoneMirrorService.ts');
  assert.match(src, /c\.type === 'direct'/);
  assert.match(src, /PHONE_DIRECT_MAX_CHARS = 20_000/);
});
