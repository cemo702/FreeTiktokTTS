import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechQueue } from '../src/main/speech-queue.js';

const opts = { maxSize: 5, maxPerMinute: 3, minGapMs: 200, sameUserPenalty: 5000 };

test('push: artan id ve sira korunur', () => {
  const q = new SpeechQueue(opts);
  const a = q.push({ text: 'bir', userId: 'u1' });
  const b = q.push({ text: 'iki', userId: 'u2' });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(q.length, 2);
});

test('peek/take: sira ile alinir', () => {
  const q = new SpeechQueue(opts);
  q.push({ text: 'bir', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'iki', userId: 'u2', enqueuedAt: 2000 });
  const item = q.take(10_000);
  assert.equal(item.text, 'bir');
  assert.equal(q.length, 1);
  assert.equal(q.take(10_500).text, 'iki', 'minGapMs gectiginde ikinci oge okunur');
  assert.equal(q.take(11_000), null);
});

test('oncelik: yuksek oncelikli oge one gecer', () => {
  const q = new SpeechQueue(opts);
  q.push({ text: 'normal', userId: 'u1', priority: 0, enqueuedAt: 1000 });
  q.push({ text: 'hediye', userId: 'u2', priority: 10, enqueuedAt: 2000 });
  assert.equal(q.take(10_000).text, 'hediye');
});

test('ayni kullanici cezasi: tekrar eden kullanici geriye atilir', () => {
  const q = new SpeechQueue(opts);
  q.push({ text: 'u1-ilk', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'u2', userId: 'u2', enqueuedAt: 2000 });
  q.push({ text: 'u1-ikinci', userId: 'u1', enqueuedAt: 3000 });
  assert.equal(q.take(10_000).text, 'u2');
});

test('kapasite: en dusuk oncelikli elenir', () => {
  const q = new SpeechQueue(opts); // maxSize 5
  for (let i = 0; i < 4; i += 1) q.push({ text: `n${i}`, userId: `u${i}`, enqueuedAt: 1000 + i });
  q.push({ text: 'vip', userId: 'vip', priority: 5, enqueuedAt: 5000 });
  q.push({ text: 'n5', userId: 'u5', enqueuedAt: 6000 });
  assert.equal(q.length, 5);
  assert.ok(q.list().some((i) => i.text === 'vip'));
  assert.equal(q.dropped, 1);
});

test('hiz limiti: dakikada en fazla N konusma', () => {
  const q = new SpeechQueue({ ...opts, maxPerMinute: 2, minGapMs: 0 });
  q.push({ text: 'a', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'b', userId: 'u2', enqueuedAt: 1000 });
  q.push({ text: 'c', userId: 'u3', enqueuedAt: 1000 });
  const t0 = 60_000;
  assert.ok(q.take(t0));
  assert.ok(q.take(t0 + 1));
  assert.equal(q.peek(t0 + 2), null, 'sinir doldu, beklemeli');
  assert.ok(q.peek(t0 + 60_000), 'pencere dolunca devam etmeli');
});

test('kapasite: esit oncelikte EN YENI duser, en eski korunur', () => {
  const q = new SpeechQueue({ maxSize: 3, maxPerMinute: 100, minGapMs: 0 });
  q.push({ text: 'eski', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'orta', userId: 'u2', enqueuedAt: 2000 });
  q.push({ text: 'yeni', userId: 'u3', enqueuedAt: 3000 });
  q.push({ text: 'en-yeni', userId: 'u4', enqueuedAt: 4000 });
  const texts = q.list().map((i) => i.text);
  assert.deepEqual(texts, ['eski', 'orta', 'yeni']);
  assert.equal(q.dropped, 1);
});

test('queueAll: dakikada-limit kapaliysa hepsi siraya girer', () => {
  const q = new SpeechQueue({ maxSize: 10, maxPerMinute: 2, minGapMs: 0, queueAll: true });
  q.push({ text: 'a', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'b', userId: 'u2', enqueuedAt: 1000 });
  q.push({ text: 'c', userId: 'u3', enqueuedAt: 1000 });
  const t0 = 60_000;
  assert.ok(q.take(t0));
  assert.ok(q.take(t0 + 1));
  assert.ok(q.take(t0 + 2), 'queueAll acikken dakika limiti uygulanmaz');
});

test('noteEnd: bosluk onceki yorumun BITISinden sayilir', () => {
  const q = new SpeechQueue({ ...opts, maxPerMinute: 100, minGapMs: 2000 });
  q.push({ text: 'uzun yorum', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'sonraki', userId: 'u2', enqueuedAt: 1000 });
  q.take(10_000);
  // konusma 5 sn surdu: gercek bitis 15.000
  q.noteEnd(15_000);
  assert.equal(q.peek(16_500), null, 'bitis + 1.5 sn olmadan okunmamali');
  assert.ok(q.peek(17_100), 'bitis + 2.1 sn sonra okunmali');
});

test('minGapMs: iki konusma arasi bekleme', () => {
  const q = new SpeechQueue({ ...opts, maxPerMinute: 100, minGapMs: 500 });
  q.push({ text: 'a', userId: 'u1', enqueuedAt: 1000 });
  q.push({ text: 'b', userId: 'u2', enqueuedAt: 1000 });
  q.take(10_000);
  assert.equal(q.peek(10_100), null);
  assert.ok(q.peek(10_500));
});

test('remove/clear', () => {
  const q = new SpeechQueue(opts);
  const a = q.push({ text: 'bir', userId: 'u1' });
  q.push({ text: 'iki', userId: 'u2' });
  assert.equal(q.remove(a.id), true);
  assert.equal(q.remove(999), false);
  assert.equal(q.clear(), 1);
  assert.equal(q.length, 0);
});

test('oldestAge', () => {
  const q = new SpeechQueue(opts);
  assert.equal(q.oldestAge(5000), 0);
  q.push({ text: 'a', userId: 'u1', enqueuedAt: 2000 });
  assert.equal(q.oldestAge(5000), 3000);
});
