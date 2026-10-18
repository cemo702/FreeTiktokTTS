#!/usr/bin/env node
/**
 * Turkce Piper TTS motoru + ses modeli kurulumu.
 *
 *   voices/turkish/model.onnx        99eren99/piper-turkish-tts  (espeak, tr)
 *   voices/turkish/model.onnx.json   ayni dosyanin piper konfigurasyonu
 *   engine/venv/                     piper-tts (Python) - espeak-ng + onnxruntime
 *   engine/engine.json               uygulamanin okudugu motor tanimi
 *
 * Idempotent. Kullanim:
 *   node scripts/setup-voice.mjs [--force] [--optional]
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = path.join(ROOT, 'engine');
const VENV_DIR = path.join(ENGINE_DIR, 'venv');
const VOICE_DIR = path.join(ROOT, 'voices', 'turkish');
const MODEL_PATH = path.join(VOICE_DIR, 'model.onnx');
const CONFIG_PATH = path.join(VOICE_DIR, 'model.onnx.json');
const ENGINE_JSON = path.join(ENGINE_DIR, 'engine.json');
const SIDECAR = path.join(ENGINE_DIR, 'piper-sidecar.py');

const PIPER_VERSION = '1.8.0';
const VOICE_REPO = 'https://huggingface.co/99eren99/piper-turkish-tts/resolve/main';
const VOICE_FILES = [
  { url: `${VOICE_REPO}/model.onnx`, to: MODEL_PATH, minBytes: 40 * 1024 * 1024 },
  { url: `${VOICE_REPO}/config.json`, to: CONFIG_PATH, minBytes: 200 }
];

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const OPTIONAL = argv.includes('--optional');
const SKIP_VENV = argv.includes('--no-venv');

const log = (...m) => console.log('[setup]', ...m);
const warn = (...m) => console.warn('[setup] !!', ...m);
const isWin = process.platform === 'win32';
const venvPython = path.join(VENV_DIR, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

const fileSize = (p) => { try { return statSync(p).size; } catch { return -1; } };
const venvBytes = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) total += statSync(full).size;
    }
  };
  try { walk(dir); } catch { /* yok */ }
  return total;
};

async function download(url, dest, minBytes = 1) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const size = statSync(tmp).size;
  if (size < minBytes) {
    rmSync(tmp, { force: true });
    throw new Error(`dosya cok kucuk (${size} bayt) - indirme bozuk olabilir`);
  }
  renameSync(tmp, dest);
  return size;
}

function sha256(p) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(p).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

function findPython() {
  const candidates = isWin ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, prefix] of candidates) {
    const probe = spawnSync(cmd, [...prefix, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { encoding: 'utf8' });
    if (probe.status === 0) {
      const [major, minor] = probe.stdout.trim().split('.').map(Number);
      if (major === 3 && minor >= 9) return { cmd, prefix };
      warn(`${cmd} surumu eski (${probe.stdout.trim()}), atlandi`);
    }
  }
  return null;
}

async function setupVoice() {
  mkdirSync(VOICE_DIR, { recursive: true });
  for (const file of VOICE_FILES) {
    if (!FORCE && existsSync(file.to) && fileSize(file.to) >= file.minBytes) {
      log('ses dosyasi zaten var:', path.relative(ROOT, file.to));
      continue;
    }
    log(`indiriliyor: ${file.url.split('/').pop()}`);
    const size = await download(file.url, file.to, file.minBytes);
    log(`  ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

  // Kullaniciya guzel gosterilebilmesi icin ses meta dosyasi
  const metaFile = path.join(VOICE_DIR, 'voice.json');
  if (FORCE || !existsSync(metaFile)) {
    writeFileSync(metaFile, `${JSON.stringify({
      id: 'turkish',
      catalogId: '99eren99/piper-turkish-tts',
      label: 'Türkçe',
      language: { code: 'tr_TR', family: 'tr', native: 'Türkçe', english: 'Turkish', country: 'Turkey' },
      quality: 'medium',
      source: 'bundled'
    }, null, 2)}\n`, 'utf8');
    log('ses meta dosyasi yazildi: voices/turkish/voice.json');
  }

  log(`model: sample_rate=${cfg.audio?.sample_rate} konusmaci=${cfg.num_speakers} fonem=${cfg.phoneme_type} espeak=${cfg.espeak?.voice}`);
  return true;
}

function setupVenv() {
  if (FORCE) rmSync(VENV_DIR, { recursive: true, force: true });
  if (existsSync(venvPython) && !FORCE) {
    log('Python ortami zaten var');
    return true;
  }
  const py = findPython();
  if (!py) throw new Error('Python 3.9+ bulunamadi (https://www.python.org/downloads/ adresinden kurun)');
  log(`Python ortami olusturuluyor (${py.cmd})...`);
  const venv = spawnSync(py.cmd, [...py.prefix, '-m', 'venv', VENV_DIR], { stdio: 'inherit', shell: isWin });
  if (venv.status !== 0 || !existsSync(venvPython)) throw new Error('venv olusturulamadi');

  log(`piper-tts==${PIPER_VERSION} kuruluyor (bu birkac dakika surebilir)...`);
  const pip = spawnSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
  if (pip.status !== 0) warn('pip guncellemesi basarisiz, devam ediliyor');
  const install = spawnSync(venvPython, ['-m', 'pip', 'install', `piper-tts==${PIPER_VERSION}`], { stdio: 'inherit' });
  if (install.status !== 0) throw new Error('piper-tts kurulamadi');
  log(`ortam boyutu: ${(venvBytes(VENV_DIR) / 1024 / 1024).toFixed(0)} MB`);
  return true;
}

function writeEngineJson() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const payload = {
    engine: 'piper-tts',
    piperVersion: PIPER_VERSION,
    python: path.relative(ROOT, venvPython).split(path.sep).join('/'),
    sidecar: path.relative(ROOT, SIDECAR).split(path.sep).join('/'),
    model: path.relative(ROOT, MODEL_PATH).split(path.sep).join('/'),
    config: path.relative(ROOT, CONFIG_PATH).split(path.sep).join('/'),
    // Paketle gelen (salt okunur) sesler: Settings sekmesinde "paketle gelir" olarak gosterilir
    bundled: [path.relative(ROOT, VOICE_DIR).split(path.sep).join('/')],
    defaultVoice: 'turkish',
    sampleRate: cfg.audio?.sample_rate ?? 22050,
    espeakVoice: cfg.espeak?.voice ?? 'tr',
    defaults: {
      lengthScale: 1.0,
      noiseScale: cfg.inference?.noise_scale ?? 0.667,
      noiseWScale: cfg.inference?.noise_w ?? 0.8
    },
    installedAt: new Date().toISOString()
  };
  mkdirSync(ENGINE_DIR, { recursive: true });
  writeFileSync(ENGINE_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log('motor tanimi yazildi:', path.relative(ROOT, ENGINE_JSON));
}

function engineComplete() {
  if (!existsSync(ENGINE_JSON)) return false;
  try {
    const cfg = JSON.parse(readFileSync(ENGINE_JSON, 'utf8'));
    return existsSync(path.join(ROOT, cfg.python)) && existsSync(path.join(ROOT, cfg.model)) && existsSync(SIDECAR);
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(ENGINE_DIR, { recursive: true });
  await setupVoice();
  if (!SKIP_VENV) {
    setupVenv();
    writeEngineJson();
  }
  log('model sha256:', (await sha256(MODEL_PATH)).slice(0, 16));
  if (engineComplete()) {
    log('KURULUM TAMAM. Dogrulama: npm run verify');
  } else if (SKIP_VENV) {
    warn('--no-venv: motor tanimi yazilmadi, uygulama calismaz.');
  } else {
    throw new Error('motor tanimi eksik');
  }
}

try {
  await main();
} catch (err) {
  if (OPTIONAL) {
    warn('Kurulum atlandi (postinstall):', err.message);
    warn('Manuel kurulum icin: npm run setup:voice');
  } else {
    console.error('[setup] HATA:', err.message);
    process.exit(1);
  }
}
