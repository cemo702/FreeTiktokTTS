import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withLeadPad, pcmToFloat32, percentToGain, percentToDb } from '../src/renderer/audio-engine.js';

const SR = 22050;

test('withLeadPad: basa sessizlik ekler, toplam uzunluk = pad + ornek', () => {
  const input = new Float32Array(1000).fill(1);
  const out = withLeadPad(input, SR);
  const padLen = Math.round(SR * 0.05);
  const fadeLen = Math.round(SR * 0.008);
  assert.equal(out.length, padLen + 1000);
  for (let i = 0; i < padLen; i += 1) assert.equal(out[i], 0, `pad[${i}] sessiz olmali`);
});

test('withLeadPad: konusma icerigi korunur, sadece basinda yumuşak gecis vardir', () => {
  const input = new Float32Array(1000).fill(1);
  const out = withLeadPad(input, SR);
  const padLen = Math.round(SR * 0.05);
  const fadeLen = Math.round(SR * 0.008);
  assert.equal(out[padLen], 0, 'pad sonrasi ilk ornek sifirdan baslamali (fade)');
  assert.ok(out[padLen + fadeLen - 1] > 0.9, 'fade sonuna dogru neredeyse tam seviye');
  assert.equal(out[padLen + fadeLen], 1, 'fade bittikten sonra ornekler aynen korunmali');
  assert.equal(out[out.length - 1], 1, 'son ornek degismemeli');
});

test('withLeadPad: kisa girdide fade tum sinyali yutmaz (yarisi korunur)', () => {
  const input = new Float32Array(50).fill(1);
  const out = withLeadPad(input, SR);
  const padLen = Math.round(SR * 0.05);
  assert.equal(out.length, padLen + 50);
  for (let i = 0; i < padLen; i += 1) assert.equal(out[i], 0);
  assert.equal(out[padLen], 0, 'fade sifirdan baslar');
  assert.ok(out[padLen + 24] > 0.9, 'fade yarida biter');
  assert.equal(out[padLen + 25], 1, 'kalan konusma aynen korunmali');
  assert.equal(out[out.length - 1], 1);
});

test('pcmToFloat32: int16 LE baytlari -1..1 araligina cevirir', () => {
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0xff, 0x7f]);
  const out = pcmToFloat32(bytes);
  assert.equal(out.length, 3);
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[1] + 1) < 1e-4);
  assert.ok(Math.abs(out[2] - 32767 / 32768) < 1e-6);
});

test('percentToGain: 0 sessiz, 100 birlik, 300 = +15 dB', () => {
  assert.equal(percentToGain(0), 0);
  assert.equal(percentToGain(100), 1);
  assert.ok(Math.abs(percentToDb(300) - 15) < 1e-9);
  assert.ok(Math.abs(percentToGain(300) - 10 ** (15 / 20)) < 1e-9);
  assert.equal(percentToGain(999), percentToGain(300), 'ust sinir kirpilir');
});