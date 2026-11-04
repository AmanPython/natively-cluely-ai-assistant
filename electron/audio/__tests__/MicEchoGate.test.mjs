import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { MicEchoGate, MIC_DELAY_MS, rmsInt16 } = await import(
  pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/audio/MicEchoGate.js')).href
);

const tone = (amp, samples = 320) => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 3)), i * 2);
  return b;
};

// 20 ms ticks; returns the levels of everything released.
function run(gate, seconds, sysAmp, micAmp) {
  const levels = [];
  for (let t = 0; t < seconds * 1000; t += 20) {
    gate.noteSystem(tone(sysAmp), t);
    for (const c of gate.pushMic(tone(micAmp), t)) levels.push(rmsInt16(c));
  }
  return levels;
}

test('silences the mic while it only carries speaker echo', () => {
  const gate = new MicEchoGate();
  const levels = run(gate, 4, 0.2, 0.06); // echo is 30% of the system level
  assert.ok(levels.slice(10).every((l) => l === 0));
});

test('lets the user through when much louder than the echo', () => {
  const gate = new MicEchoGate();
  run(gate, 3, 0.2, 0.06); // learn the echo level
  const levels = run(gate, 2, 0.2, 0.5);
  assert.ok(levels.slice(-20).every((l) => l > 0.1));
});

test('passes everything when the system audio is silent', () => {
  const gate = new MicEchoGate();
  const levels = run(gate, 2, 0, 0.1);
  assert.ok(levels.length > 0 && levels.every((l) => l > 0.05));
});

test('headphones: a mic with no echo is not gated for long', () => {
  const gate = new MicEchoGate();
  run(gate, 2, 0.2, 0.0005); // coupling learns ~0
  const levels = run(gate, 2, 0.2, 0.08); // user speaks over the meeting
  assert.ok(levels.slice(-20).every((l) => l > 0.03));
});

test('holds mic audio back by the delay and keeps lengths', () => {
  const gate = new MicEchoGate();
  assert.deepEqual(gate.pushMic(tone(0.1), 0), []);
  const out = gate.pushMic(tone(0.1), MIC_DELAY_MS);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 640);
});
