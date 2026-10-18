import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForEngine } from '../src/main/engine-wait.js';

test('motor hazirsa hemen doner, beklemez', async () => {
  const started = Date.now();
  const ok = await waitForEngine({ isReady: () => true }, { timeoutMs: 5000, pollMs: 50 });
  assert.equal(ok, true);
  assert.ok(Date.now() - started < 300, 'hazir motor icin bekleme olmamali');
});

test('gec hazir olan motor poll ile yakalanir', async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 120);
  const ok = await waitForEngine({ isReady: () => ready }, { timeoutMs: 3000, pollMs: 20 });
  assert.equal(ok, true);
});

test('kesin basarisizlik sinyali bekleme suresini beklemez, hemen false', async () => {
  const started = Date.now();
  const ok = await waitForEngine(
    { isReady: () => false, isFailed: () => true },
    { timeoutMs: 10_000, pollMs: 20 }
  );
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 500, 'zaman asimi kadar beklememeli');
});

test('sure dolunca hala hazir degilse false', async () => {
  const started = Date.now();
  const ok = await waitForEngine({ isReady: () => false }, { timeoutMs: 150, pollMs: 20 });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 1000);
});

test('bos poll araligi ile de calisir (hizli test)', async () => {
  let calls = 0;
  const ok = await waitForEngine({ isReady: () => { calls += 1; return calls > 2; } }, { timeoutMs: 1000, pollMs: 5 });
  assert.equal(ok, true);
  assert.ok(calls >= 3);
});
