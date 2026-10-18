#!/usr/bin/env node
/**
 * Piper sidecar dogrulama araci.
 *
 *   node scripts/verify-pipeline.mjs ["metin" ...]
 *
 * Sidecar'i baslatir, Turkce test cumleleri gonderir, ilk ses gecikmesini ve
 * sureleri olcer, .cache/verify-*.wav dosyalari yazar (dinlenebilir).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const PYTHON = path.join(ROOT, 'engine', 'venv', 'Scripts', 'python.exe');
const SIDECAR = path.join(ROOT, 'src', 'main', 'piper-sidecar.py');
const MODEL = path.join(ROOT, 'voices', 'turkish', 'model.onnx');
const CONFIG = `${MODEL}.json`;

const SAMPLES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'Şeker bankacı üç ünlü yığın, çabuk ol!',
      'merhaba dünya',
      'yorumları sesli okuma testi başarılı'
    ];

for (const [label, p] of [['python', PYTHON], ['sidecar', SIDECAR], ['model', MODEL], ['config', CONFIG]]) {
  if (!existsSync(p)) {
    console.error(`[verify] EKSIK: ${label} -> ${path.relative(ROOT, p)}`);
    console.error('[verify] Once "npm run setup:voice" calistir.');
    process.exit(1);
  }
}
mkdirSync(CACHE, { recursive: true });

const child = spawn(PYTHON, [SIDECAR, '--model', MODEL, '--config', CONFIG], {
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`  [sidecar] ${d}`));

const results = [];
let buffer = Buffer.alloc(0);
let needBytes = 0; // beklenen PCM govdesi (basliktan sonra)
let needId = null;
let pending = null; // { id, chunks, resolve, reject, firstByteAt }
let onReady = null;

child.stdout.on('data', (onData) => {
  buffer = buffer.length ? Buffer.concat([buffer, onData]) : onData;
  for (;;) {
    // 1) Once bekleyen PCM govdesini tuket (ilk basta \n arama!)
    if (needBytes > 0) {
      if (buffer.length < needBytes) return;
      if (pending && pending.id === needId) {
        if (!pending.firstByteAt) pending.firstByteAt = performance.now();
        pending.chunks.push(buffer.subarray(0, needBytes));
      }
      buffer = buffer.subarray(needBytes);
      needBytes = 0;
      needId = null;
      continue;
    }

    // 2) Baslik satirini oku
    const nl = buffer.indexOf(0x0a);
    if (nl === -1) return;
    const line = buffer.subarray(0, nl).toString('utf8');
    buffer = buffer.subarray(nl + 1);

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[verify] bozuk baslik satiri:', line.slice(0, 120));
      continue;
    }

    if (msg.t === 'chunk') {
      needBytes = msg.n;
      needId = msg.id;
      continue;
    }
    if (msg.t === 'ready') {
      onReady?.(msg);
      continue;
    }
    if (msg.t === 'start') {
      if (pending && pending.id === msg.id) pending.startedAt = performance.now();
      continue;
    }
    if (msg.t === 'end' || msg.t === 'error') {
      if (pending && pending.id === msg.id) {
        if (msg.t === 'end') pending.resolve({ ...msg, chunks: pending.chunks });
        else pending.reject(new Error(msg.message));
        pending = null;
      }
    }
  }
});

let nextId = 1;
const readyPromise = new Promise((resolve) => {
  onReady = resolve;
});

function synthesize(text, extra = {}) {
  const id = nextId++;
  const state = { id, chunks: [], startedAt: 0, firstByteAt: 0 };
  const promise = new Promise((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
  });
  pending = state;
  child.stdin.write(`${JSON.stringify({ id, text, ...extra })}\n`);
  return promise;
}

function writeWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const info = await readyPromise;
console.log(`[verify] motor hazir: sample_rate=${info.sample_rate} phoneme_type=${info.phoneme_type} espeak=${info.espeak_voice}`);

const t0 = performance.now();
let wallPrev = 0;
let i = 0;
for (const text of SAMPLES) {
  i += 1;
  const res = await synthesize(text);
  const pcm = Buffer.concat(res.chunks);
  const duration = pcm.length / 2 / info.sample_rate;
  const out = path.join(CACHE, `verify-${i}.wav`);
  writeFileSync(out, writeWav(pcm, info.sample_rate));
  const wall = performance.now() - t0;
  console.log(
    `[verify] #${i} "${text}"\n` +
    `         ilk ses: ${res.first_ms} ms | toplam: ${res.total_ms} ms | ses: ${duration.toFixed(2)} sn ` +
    `| blok: ${res.chunks.length} | rtf: ${(res.total_ms / 1000 / Math.max(duration, 0.01)).toFixed(3)} ` +
    `| duvar: ${(wall - wallPrev).toFixed(0)} ms | dosya: ${path.relative(ROOT, out)}`
  );
  wallPrev = wall;
  results.push({ text, res });
}

child.stdin.end();
await new Promise((r) => child.once('exit', r));

const avgFirst = results.reduce((a, r) => a + r.res.first_ms, 0) / results.length;
console.log(`\n[verify] TAMAM. Ortalama ilk ses gecikmesi: ${avgFirst.toFixed(0)} ms`);
console.log(`[verify] Dinleme: ${path.relative(ROOT, path.join(CACHE, 'verify-1.wav'))} vb.`);
if (info.phoneme_type.toLowerCase().includes('espeak') === false && !/espeak/i.test(info.espeak_voice)) {
  console.warn('[verify] UYARI: espeak phoneme_type kullanilmiyor, Turkce okunusu bozuk olabilir.');
  process.exit(2);
}
