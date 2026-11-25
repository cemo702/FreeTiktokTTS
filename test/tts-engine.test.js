import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGLISH_IDLE_TIMEOUT_MS, TtsEngine, englishIdleExpired } from '../src/main/tts-engine.js';

test('englishIdleExpired: 5 dk dolmadan atilmaz, dolunca atilir', () => {
  assert.equal(ENGLISH_IDLE_TIMEOUT_MS, 5 * 60 * 1000);
  const now = 1_000_000;
  assert.equal(englishIdleExpired(now - 60_000, now), false);
  assert.equal(englishIdleExpired(now - ENGLISH_IDLE_TIMEOUT_MS, now), true);
  assert.equal(englishIdleExpired(now - ENGLISH_IDLE_TIMEOUT_MS - 1, now), true);
  assert.equal(englishIdleExpired(now, now), false);
});

test('englishIdleExpired: gecersiz girdiler guvenli', () => {
  assert.equal(englishIdleExpired(undefined), false);
  assert.equal(englishIdleExpired(null), false);
  assert.equal(englishIdleExpired(Number.NaN), false);
});

test('synthesize: yanit gelmezse zaman asiminda reddeder ve motoru yeniden baslatir', async () => {
  const engine = new TtsEngine({ synthTimeoutMs: 30 });
  let killed = false;
  engine.child = { stdin: { write() {} }, kill() { killed = true; } };

  await assert.rejects(engine.synthesize('merhaba'), /yaniti .* sn icinde gelmedi/);
  assert.equal(engine.pending.size, 0, 'zaman asiminda bekleyen istek temizlenmeli');
  assert.equal(killed, true, 'asili motor yeniden baslatilmali');
});

test('synthesize: basarili yanitta zamanlayici temizlenir', async () => {
  const engine = new TtsEngine({ synthTimeoutMs: 30 });
  let killed = false;
  engine.child = { stdin: { write() {} }, kill() { killed = true; } };

  const promise = engine.synthesize('selam');
  engine._onMessage({ t: 'end', id: 1, bytes: 0 });
  const result = await promise;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(result.bytes, 0);
  assert.equal(killed, false, 'basarili sentez motoru kapatmamali');
  assert.equal(engine.pending.size, 0);
});
