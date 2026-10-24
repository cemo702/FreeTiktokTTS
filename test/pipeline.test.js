import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/main/pipeline.js';
import { DEFAULT_PROFANITY_WORDS } from '../src/main/filters.js';

const baseSettings = () => ({
  profanityWords: DEFAULT_PROFANITY_WORDS,
  profanityAction: 'mask',
  minLength: 2,
  minLetters: 1,
  englishRouting: true,
  speakUsername: true,
  queueMax: 40,
  maxPerMinute: 12,
  queueAll: true,
  minGapMs: 0,
  lengthScale: 1,
  noiseScale: 0.4,
  noiseWScale: 0.3,
  speakerId: 0,
  englishSpeakerId: 1
});

const fakeTts = (sampleRate) => ({
  ready: true,
  sampleRate,
  synthesize: async (text, params) => ({
    pcm: Buffer.alloc(0),
    durationSec: 0.1,
    firstMs: 5,
    text,
    speakerId: params.speakerId
  })
});

test('ingest: Ingilizce baslayan yorum en, one says ile isaretlenir', () => {
  const p = new Pipeline({ tts: fakeTts(22050), getSettings: baseSettings });
  const r = p.ingest({ id: 'c1', userId: 'u1', userName: 'Ali', text: 'hello guys welcome' });
  assert.equal(r.accepted, true);
  assert.equal(r.spokenText, 'Ali says, hello guys welcome');
  assert.equal(p.queue.list()[0].lang, 'en');
});

test('ingest: Turkce baslayan yorum tr, one diyor ki ile isaretlenir', () => {
  const p = new Pipeline({ tts: fakeTts(22050), getSettings: baseSettings });
  const r = p.ingest({ id: 'c2', userId: 'u2', userName: 'Veli', text: 'sa abi welcome' });
  assert.equal(r.accepted, true);
  assert.equal(r.spokenText, 'Veli diyor ki, selam aleyküm abi welcome');
  assert.equal(p.queue.list()[0].lang, 'tr');
});

test('ingest: englishRouting kapaliysa hepsi tr', () => {
  const p = new Pipeline({
    tts: fakeTts(22050),
    getSettings: () => ({ ...baseSettings(), englishRouting: false })
  });
  p.ingest({ id: 'c3', userId: 'u3', userName: 'Can', text: 'hello guys' });
  assert.equal(p.queue.list()[0].lang, 'tr');
});

test('pump: her dil kendi motoruyla sentezlenir, ornek hizi motordan gelir', async () => {
  const seen = [];
  const tr = fakeTts(22050);
  const en = fakeTts(16000);
  const p = new Pipeline({
    tts: tr,
    getSettings: baseSettings,
    resolveTts: async (lang) => { seen.push(lang); return lang === 'en' ? en : tr; }
  });
  const audios = [];
  p.on('speech-audio', (e) => audios.push(e));
  p.ingest({ id: 'c1', userId: 'u1', userName: 'Ali', text: 'hello guys' });
  p.ingest({ id: 'c2', userId: 'u2', userName: 'Veli', text: 'merhaba abi' });
  p.start();
  const deadline = Date.now() + 5000;
  while (audios.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  p.pause();
  assert.equal(audios.length, 2);
  assert.deepEqual(seen, ['en', 'tr']);
  assert.equal(audios[0].sampleRate, 16000);
  assert.equal(audios[1].sampleRate, 22050);
  assert.equal(audios[0].lang, 'en');
  assert.equal(audios[1].lang, 'tr');
});

test('ingest: ayni msgId ikinci kez gelirse dusurulur (TikTok gecmis tekrari)', () => {
  const p = new Pipeline({ tts: fakeTts(22050), getSettings: baseSettings });
  const r1 = p.ingest({ id: 'msg-1', userId: 'u1', userName: 'Ali', text: 'selam' });
  const r2 = p.ingest({ id: 'msg-1', userId: 'u1', userName: 'Ali', text: 'selam' });
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, false);
  assert.equal(r2.reason, 'duplicate');
  assert.equal(r2.duplicate, true);
  assert.equal(p.queue.length, 1);
  assert.equal(p.stats.received, 1, 'tekrar teslimat istatistigi sisirmez');
});

test('ingest: farkli msgIDler ve idsi olmayan olaylar tekrar korumasina takilmaz', () => {
  const p = new Pipeline({ tts: fakeTts(22050), getSettings: baseSettings });
  assert.equal(p.ingest({ id: 'msg-1', userId: 'u1', userName: 'Ali', text: 'selam' }).accepted, true);
  assert.equal(p.ingest({ id: 'msg-2', userId: 'u2', userName: 'Veli', text: 'iyi yayin' }).accepted, true);
  // Hediye/takip olaylarinin idsi olmayabilir: koruma devre disi kalmali.
  assert.equal(p.ingest({ userId: 'u3', userName: 'Can', text: 'gul x1', priority: 5 }).accepted, true);
  assert.equal(p.ingest({ userId: 'u4', userName: 'Ece', text: 'gul x2', priority: 5 }).accepted, true);
  assert.equal(p.queue.length, 4);
});
