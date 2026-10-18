/**
 * Ses motoru (renderer tarafi, Web Audio API).
 *
 * Zincir:
 *   PCM (22050 Hz s16le) -> AudioBuffer -> GainNode(0..2) -> Limiter -> Analyser -> cikis
 *                                                                               -> Windows secili aygit
 *
 * %200 ses: GainNode 2.0 + DynamicsCompressor (limiter) ile kırpma olmadan calisir.
 * Konusma sirasinda kazanca yumusak gecis uygulanir (pop sesi olmaz).
 */

const MIN_PERCENT = 0;
const MAX_PERCENT = 300;
const MAX_BOOST_DB = 15; // %300 = +15.0 dB

/**
 * Yuzde -> kazanc donusumu.
 *   %0   = sessiz (gain 0)
 *   %100 = 0.0 dB  (gain 1.0)
 *   %300 = +15 dB (gain ~5.62)
 * Yuksek kazanc araligi cizgisel ESILTME degil, desibel tabanli ARTIRMA ile
 * calisir; boylece %100 -> %300 arasi kontrollu ve "kulakla karsilastirilabilir".
 */
export function percentToGain(percent) {
  const p = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Number(percent) || 0));
  if (p <= 0) return 0;
  if (p <= 100) return p / 100;
  const db = ((p - 100) / (MAX_PERCENT - 100)) * MAX_BOOST_DB;
  return 10 ** (db / 20);
}

/** Yuzdeyi dB'ye cevirir (gosterim icin). */
export function percentToDb(percent) {
  const p = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Number(percent) || 0));
  if (p <= 0) return -Infinity;
  if (p <= 100) return 20 * Math.log10(p / 100);
  return ((p - 100) / (MAX_PERCENT - 100)) * MAX_BOOST_DB;
}

/**
 * Ilk blogun planlanmasi icin guvenlik payi.
 * start(currentTime) ile planlama, cihaz tamponu (baseLatency/outputLatency)
 * nedeniyle sesin ilk hecesini yutabiliyor -> bastaki 1-2 harf kesiliyordu.
 */
function leadTimeFor(ctx) {
  const base = Number(ctx?.baseLatency) || 0;
  const out = Number(ctx?.outputLatency) || 0;
  return Math.min(0.25, Math.max(0.06, base + out + 0.02));
}

/**
 * Konusma basina bastan eklenen sessizlik (saniye).
 *
 * Windows cikis cihazi akisi yeni baslayan bir akista ilk onlarca ms'yi
 * yutabiliyor; bu yuzden bastaki kisa/unsesli hece (orn. "amin" -> "a")
 * duyulmuyordu. Onceden sessizlik eklersek yutulan kisim konusma degil,
 * sessizlik olur. Ayni blogun icinde oldugu icin ek gecikme yaratmaz.
 */
const LEAD_PAD_SEC = 0.05;
/** Pad ile konusma arasindaki sert gecisi yumuşatir (tik sesi olmasin). */
const LEAD_FADE_SEC = 0.008;

/**
 * Konusmanin basina sessizlik + kisa fade-in ekler.
 * Boylece cihazin yuttugu ilk ms'ler konusmaya degil sessizlige gider.
 */
export function withLeadPad(samples, sampleRate) {
  const padLen = Math.round(sampleRate * LEAD_PAD_SEC);
  if (padLen <= 0) return samples;
  const fadeLen = Math.min(Math.round(sampleRate * LEAD_FADE_SEC), samples.length >> 1);
  const out = new Float32Array(padLen + samples.length);
  for (let i = 0; i < fadeLen; i += 1) out[padLen + i] = samples[i] * (i / fadeLen);
  out.set(samples.subarray(fadeLen), padLen + fadeLen);
  return out;
}

/** Konusma basina akan PCM parcalarini yapisik (gapless) planlayan akis. */
export class PcmStream {
  constructor(engine, jobId, sampleRate) {
    this.engine = engine;
    this.jobId = jobId;
    this.sampleRate = sampleRate;
    this.nextTime = 0;
    this.totalSamples = 0;
    this.sources = [];
    this.finished = false;
    this.ended = false;
    this.startedAt = performance.now();
    this.firstChunkAt = null;
    this.leadSec = 0;
  }

  /** Yeni PCM blogunu ekler; oynatma zamanlamasi kesintisiz devam eder. */
  push(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!bytes.length || this.ended) return 0;

    const isFirst = this.firstChunkAt === null;
    const samples = isFirst ? withLeadPad(pcmToFloat32(bytes), this.sampleRate) : pcmToFloat32(bytes);
    const ctx = this.engine.ctx;
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);

    const now = ctx.currentTime;
    // Ilk blok: guvenlik payi ver (bastaki hece kaybolmasin).
    // Sonraki bloklar nextTime'a zincirlenir -> yapisiz (gapless) devam.
    const startAt = this.nextTime > 0
      ? Math.max(this.nextTime, now + 0.005)
      : now + leadTimeFor(ctx);
    this.nextTime = startAt + buffer.duration;
    if (this.firstChunkAt === null) {
      this.firstChunkAt = performance.now();
      this.leadSec = startAt - now;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.engine.gain);
    source.start(startAt);
    source.onended = () => {
      const index = this.sources.indexOf(source);
      if (index !== -1) this.sources.splice(index, 1);
      this.#checkDone();
    };
    this.sources.push(source);
    // Pad gercek konusma suresine dahil degil (bosluk hesabi yanlmasin).
    this.totalSamples += samples.length - (isFirst ? Math.round(this.sampleRate * LEAD_PAD_SEC) : 0);
    return buffer.duration;
  }

  /** Son blogun gelip gelmedigini bildirir. */
  finish() {
    this.finished = true;
    this.#checkDone();
  }

  stop() {
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch { /* zaten bitti */ }
    }
    this.sources = [];
    if (!this.ended) {
      this.ended = true;
      this.engine.onStreamEnd?.(this.jobId, { stopped: true });
    }
  }

  #checkDone() {
    if (this.ended) return;
    if (!this.finished || this.sources.length > 0) return;
    this.ended = true;
    this.engine.onStreamEnd?.(this.jobId, {
      durationSec: this.durationSec,
      wallMs: performance.now() - this.startedAt,
      firstChunkMs: this.firstChunkAt === null ? null : this.firstChunkAt - this.startedAt,
      leadSec: this.leadSec
    });
  }

  get started() {
    return this.firstChunkAt !== null;
  }

  get durationSec() {
    return this.totalSamples / this.sampleRate;
  }

  get queuedSec() {
    return this.engine.ctx ? Math.max(0, this.nextTime - this.engine.ctx.currentTime) : 0;
  }
}

/** Int16 LE PCM -> Float32Array (-1..1) */
export function pcmToFloat32(pcm) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(view.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.limiter = null;
    this.analyser = null;
    this.volumePercent = 100;
    this.gainValue = 1;
    this.ready = false;
    this.limiterActive = false;
    this.current = null;
    this.onStreamEnd = null;
    this.onStateChange = null;
  }

  /** Kullanici etkilesimiyle cagrilir (autoplay politikasi icin). */
  async init() {
    if (this.ready) {
      await this.resume();
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volumePercent / 100;

    // Limiter: %100 uzeri kazanda kırpma olmasin (+15 dB'ye kadar)
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.gain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.#watchLimiter();
    this.ready = true;
    return this.ctx;
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** 0 - 300 arasi yuzde; yumusak gecisli. */
  setVolume(percent) {
    const clamped = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Number(percent) || 0));
    this.volumePercent = clamped;
    this.gainValue = percentToGain(clamped);
    if (this.gain && this.ctx) {
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(this.gainValue, now, 0.012); // ~30 ms
    }
    return this.gainValue;
  }

  /** Yuzdeyi dB'ye cevirir: %100 = 0.0 dB, %300 = +15.0 dB */
  static toDb(percent) {
    return percentToDb(percent);
  }

  /**
   * Limiter izleyici. requestAnimationFrame yerine setInterval kullanilir:
   * pencere arka plandayken (OBS/Oyun sirasinda) rAF durur ve gosterge donardi.
   * reduction degeri Chromium'da yapiskandir; bu yuzden "ses akarken sikiştiriyor"
   * durumu sinyal varligi ile birlikte kontrol edilir.
   */
  #watchLimiter() {
    this.lastSignalAt = 0;
    this.limiterTimer = setInterval(() => {
      if (!this.ready) return;
      const { rms } = this.level();
      if (rms > 0.0015) this.lastSignalAt = performance.now();
      const flowing = performance.now() - this.lastSignalAt < 600;
      // DynamicsCompressor.reduction negatif doner (<0 = kazanc azaltma)
      const active = flowing && (this.limiter?.reduction ?? 0) < -1.5;
      if (active !== this.limiterActive) {
        this.limiterActive = active;
        this.onStateChange?.({ limiterActive: active });
      }
    }, 80);
  }

  /** Tam PCM tamponunu oynatir (test cumlesi gibi tek parca icin). */
  playBuffer(pcmBuffer, sampleRate, jobId = -1) {
    const stream = this.createStream(jobId, sampleRate);
    stream.push(pcmBuffer);
    stream.finish();
    return stream;
  }

  createStream(jobId, sampleRate) {
    if (!this.ready) throw new Error('Ses motoru baslatilmadi');
    this.current?.stop();
    const stream = new PcmStream(this, jobId, sampleRate);
    this.current = stream;
    return stream;
  }

  stopCurrent() {
    if (!this.current) return false;
    this.current.stop();
    this.current = null;
    return true;
  }

  /** Anlik seviye (arayuz gostergesi). */
  level() {
    if (!this.analyser) return { rms: 0, peak: 0 };
    const buffer = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    let peak = 0;
    for (const sample of buffer) {
      sum += sample * sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    return { rms: Math.sqrt(sum / buffer.length), peak };
  }
}

export default AudioEngine;