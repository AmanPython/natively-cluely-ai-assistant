// Session reference documents ride one conversation and disappear on New chat.
// Platform-agnostic (no Electron APIs).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const require = createRequire(path.join(repoRoot, 'package.json'));

const bundle = process.env.SESSION_REFERENCE_STORE_BUNDLE
  ? path.resolve(process.env.SESSION_REFERENCE_STORE_BUNDLE)
  : path.resolve(repoRoot, 'dist-electron/electron/services/SessionReferenceStore.js');

const { SessionReferenceStore, withSessionReferenceContext, SESSION_REFERENCE_MAX_DOCS } = require(bundle);

describe('SessionReferenceStore', () => {
  beforeEach(() => SessionReferenceStore.resetForTests());
  afterEach(() => SessionReferenceStore.resetForTests());

  test('add, list, remove, clear', () => {
    const store = SessionReferenceStore.getInstance();
    const a = store.add({ fileName: 'notes.txt', content: 'hello notes' });
    const b = store.add({ fileName: 'spec.pdf', content: 'the spec', pageCount: 3 });
    assert.equal(store.list().length, 2);
    assert.equal(store.list()[1].fileName, 'spec.pdf');
    assert.equal(store.list()[1].pageCount, 3);
    assert.ok(store.remove(a.id));
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, b.id);
    store.clear();
    assert.deepEqual(store.list(), []);
  });

  test('empty or whitespace content is refused', () => {
    const store = SessionReferenceStore.getInstance();
    assert.throws(() => store.add({ fileName: 'empty.txt', content: '   \n' }), /no extractable text/);
    assert.equal(store.list().length, 0);
  });

  test(`keeps only the last ${SESSION_REFERENCE_MAX_DOCS} documents`, () => {
    const store = SessionReferenceStore.getInstance();
    for (let i = 0; i < SESSION_REFERENCE_MAX_DOCS + 2; i++) {
      store.add({ fileName: `f${i}.txt`, content: `body ${i}` });
    }
    const names = store.list().map((d) => d.fileName);
    assert.equal(names.length, SESSION_REFERENCE_MAX_DOCS);
    assert.equal(names[0], 'f2.txt');
    assert.equal(names[names.length - 1], `f${SESSION_REFERENCE_MAX_DOCS + 1}.txt`);
  });

  test('buildContextBlock names the files and withSessionReferenceContext prepends them', () => {
    const store = SessionReferenceStore.getInstance();
    store.add({ fileName: 'brief.pdf', content: 'Q3 revenue was 12', pageCount: 2 });
    const block = store.buildContextBlock();
    assert.match(block, /SESSION REFERENCE DOCUMENTS/);
    assert.match(block, /brief\.pdf \(2 pages\)/);
    assert.match(block, /Q3 revenue was 12/);
    const merged = withSessionReferenceContext('MEETING TRANSCRIPT');
    assert.ok(merged.startsWith('SESSION REFERENCE DOCUMENTS'));
    assert.match(merged, /MEETING TRANSCRIPT/);
  });

  test('withSessionReferenceContext is a no-op when nothing is attached', () => {
    assert.equal(withSessionReferenceContext(undefined), undefined);
    assert.equal(withSessionReferenceContext('keep me'), 'keep me');
  });

  test('onChange fires for add/remove/clear', () => {
    const store = SessionReferenceStore.getInstance();
    const seen = [];
    const off = store.onChange((items) => seen.push(items.map((i) => i.fileName).join(',')));
    store.add({ fileName: 'a.txt', content: 'a' });
    store.add({ fileName: 'b.txt', content: 'b' });
    store.remove(store.list()[0].id);
    store.clear();
    off();
    store.add({ fileName: 'c.txt', content: 'c' });
    assert.deepEqual(seen, ['a.txt', 'a.txt,b.txt', 'b.txt', '']);
  });
});
