/**
 * Piper TTS motoru yoneticisi (Node tarafi).
 *
 * Alt surec: engine/venv/Scripts/python.exe src/main/piper-sidecar.py
 * Protokol  : stdin  -> NDJSON istek  {"id":1,"text":"..."}
 *             stdout -> JSON baslik + PCM govdesi (16-bit LE, mono, 22050 Hz)
 *
 * Onarım: surec cokerse bir kez yeniden baslatilir; bekleyen istekler
 * reddedilir ve uygulama bunu "motor yeniden baslatildi" olarak bildirir.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class TtsEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.root = options.root ?? ROOT;
    this.pythonPath = options.pythonPath;
    this.sidecarPath = options.sidecarPath;
    this.modelPath = options.modelPath;
    this.configPath = options.configPath;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.needBytes = 0;
    this.needId = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.readyPromise = null;
    this.sampleRate = 22050;
    this.channels = 1;
    this.info = null;
    this.restarts = 0;
    this.stopping = false;
  }

  /** engine.json dosyasindan yollari okur. */
  static fromEngineFile(root = ROOT) {
    const file = path.join(root, 'engine', 'engine.json');
    if (!existsSync(file)) {
      throw new Error(`TTS motoru tanimi yok: ${file}\n"npm run setup:voice" calistirin.`);
    }
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    const resolve = (p) => path.isAbsolute(p) ? p : path.join(root, p);
    const engine = new TtsEngine({
      root,
      pythonPath: resolve(cfg.python),
      sidecarPath: resolve(cfg.sidecar),
      modelPath: resolve(cfg.model),
      configPath: resolve(cfg.config)
    });
    engine.engineFile = file;
    engine.bundled = (cfg.bundled ?? []).map((p) => resolve(p));
    engine.defaultVoice = cfg.defaultVoice ?? null;
    if (cfg.sampleRate) engine.sampleRate = cfg.sampleRate;
    return engine;
  }

  /**
   * Baska bir Piper modeline gecer (Settings -> aktif ses).
   * Esreconu durdurup yeni modelle yeniden baslatir (~2 sn).
   */
  async switchModel(modelPath, configPath, { sampleRate = null } = {}) {
    if (this.modelPath === modelPath && this.ready) return this.status;
    if (!existsSync(modelPath) || !existsSync(configPath)) throw new Error('Ses dosyalari bulunamadi');
    await this.stop();
    this.modelPath = modelPath;
    this.configPath = configPath;
    this.restarts = 0;
    if (sampleRate) this.sampleRate = sampleRate;
    return this.start();
  }

  check() {
    const missing = [];
    for (const [label, p] of [['Python', this.pythonPath], ['sidecar', this.sidecarPath], ['model', this.modelPath]]) {
      if (!existsSync(p)) missing.push(`${label} (${path.relative(this.root, p)})`);
    }
    if (missing.length) throw new Error(`TTS motoru eksik: ${missing.join(', ')}\n"npm run setup:voice" calistirin.`);
    return true;
  }

  async start() {
    if (this.child) return this.readyPromise;
    this.check();
    this.stopping = false;
    this.buffer = Buffer.alloc(0);
    this.needBytes = 0;
    this.needId = null;

    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TTS motoru 60 sn icinde hazir olmadi')), 60_000);
      timer.unref?.();
      this._resolveReady = () => { clearTimeout(timer); resolve(this.info); };
      this._rejectReady = (err) => { clearTimeout(timer); reject(err); };
    });

    this.child = spawn(this.pythonPath, [this.sidecarPath, '--model', this.modelPath, '--config', this.configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });

    this.child.stdout.on('data', (data) => this._onData(data));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => {
      for (const line of String(text).split('\n')) {
        if (line.trim()) this.emit('log', `piper: ${line.trim()}`);
      }
    });
    this.child.on('exit', (code, signal) => this._onExit(code, signal));
    this.child.on('error', (err) => {
      this.emit('log', `piper hatasi: ${err.message}`);
      this._rejectReady?.(err);
    });

    return this.readyPromise;
  }

  _onExit(code, signal) {
    const wasStopping = this.stopping;
    this.child = null;
    this.ready = false;
    this.info = null;
    const error = new Error(`TTS motoru kapandi (code=${code} signal=${signal ?? '-'})`);
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
    if (!wasStopping) {
      this.restarts += 1;
      this.emit('log', `piper beklenmedik sekilde kapandi (code=${code}); yeniden baslatiliyor`);
      if (this.restarts <= 3) {
        this.start().catch((err) => this.emit('log', `piper yeniden baslatilamadi: ${err.message}`));
      }
    }
    this._rejectReady?.(error);
  }

  _onData(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    for (;;) {
      if (this.needBytes > 0) {
        if (this.buffer.length < this.needBytes) return;
        const entry = this.pending.get(this.needId);
        const chunk = this.buffer.subarray(0, this.needBytes);
        if (entry) {
          entry.chunks.push(chunk);
          if (entry.onChunk) {
            try {
              entry.onChunk(chunk);
            } catch (err) {
              this.emit('log', `chunk aktarim hatasi: ${err.message}`);
            }
          }
        }
        this.buffer = this.buffer.subarray(this.needBytes);
        this.needBytes = 0;
        this.needId = null;
        continue;
      }

      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) return;
      const line = this.buffer.subarray(0, nl).toString('utf8');
      this.buffer = this.buffer.subarray(nl + 1);

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('log', `piper: bozuk baslik: ${line.slice(0, 120)}`);
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    switch (msg.t) {
      case 'ready':
        this.info = msg;
        this.sampleRate = msg.sample_rate;
        this.channels = msg.channels;
        this.ready = true;
        this.emit('ready', msg);
        this._resolveReady?.(msg);
        break;
      case 'start':
        this.emit('synth-start', msg);
        break;
      case 'chunk':
        this.needBytes = msg.n;
        this.needId = msg.id;
        break;
      case 'end': {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          const pcm = Buffer.concat(entry.chunks);
          entry.resolve({
            pcm,
            bytes: msg.bytes ?? pcm.length,
            durationSec: pcm.length / 2 / this.sampleRate,
            firstMs: msg.first_ms,
            totalMs: msg.total_ms
          });
        }
        this.emit('synth-end', { ...msg, durationSec: (msg.bytes ?? 0) / 2 / this.sampleRate });
        break;
      }
      case 'error': {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry.reject(new Error(`TTS hatasi: ${msg.message}`));
        }
        this.emit('error', new Error(msg.message));
        break;
      }
      default:
        break;
    }
  }

  /**
   * Metni sese cevirir. onChunk verilirse her PCM blogu gelir gelmez cagrilir
   * (dusuk gecikmeli oynatma icin).
   * @param {string} text
   * @param {object} params { lengthScale, noiseScale, noiseWSclae }
   * @param {(chunk: Buffer) => void} [onChunk]
   */
  synthesize(text, params = {}, onChunk = null) {
    if (!this.child) return Promise.reject(new Error('TTS motoru calismiyor'));
    const id = this.nextId++;
    const entry = { chunks: [], onChunk, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pending.set(id, entry);

    const payload = {
      id,
      text: String(text ?? ''),
      speaker_id: params.speakerId ?? params.speaker_id ?? 0,
      length_scale: params.lengthScale ?? 1,
      noise_scale: params.noiseScale ?? 0.667,
      noise_w_scale: params.noiseWScale ?? 0.8
    };
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      this.pending.delete(id);
      return Promise.reject(err);
    }
    return promise;
  }

  async stop() {
    this.stopping = true;
    this.restarts = 0;
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.end();
      setTimeout(() => {
        if (!child.killed) child.kill();
        resolve();
      }, 1500).unref?.();
    });
    this.ready = false;
  }

  get status() {
    return {
      ready: this.ready,
      restarts: this.restarts,
      sampleRate: this.sampleRate,
      info: this.info,
      python: this.pythonPath,
      model: this.modelPath
    };
  }
}

/** Yedek motorun bos kalma suresi (ms). */
export const ENGLISH_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Yedek motor bu suredir kullanilmadiysa bellekten atilabilir. */
export function englishIdleExpired(lastUseAt, now = Date.now(), idleMs = ENGLISH_IDLE_TIMEOUT_MS) {
  if (!Number.isFinite(lastUseAt) || !Number.isFinite(now)) return false;
  return now - lastUseAt >= idleMs;
}

export default TtsEngine;