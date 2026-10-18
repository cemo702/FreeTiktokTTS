import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGLISH_IDLE_TIMEOUT_MS, englishIdleExpired } from '../src/main/tts-engine.js';

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
