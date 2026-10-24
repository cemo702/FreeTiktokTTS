/**
 * Electron ana sureci: pencere, IPC, TikTok kaynagi, TTS motoru, is hatti.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IPC } from './ipc.js';
import { loadSettings, normalizeSettings, saveSettings } from './settings.js';
import { TtsEngine, ENGLISH_IDLE_TIMEOUT_MS, englishIdleExpired } from './tts-engine.js';
import { waitForEngine } from './engine-wait.js';
// electron-updater CommonJS paketidir: ESM'de isimli import calismaz.
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;
import { TikTokSource } from './tiktok-source.js';
import { Pipeline } from './pipeline.js';
import { CommentStore } from './comment-store.js';
import { VoiceManager, formatBytes } from './voice-manager.js';
import { createTranslator, resolveLanguage } from '../shared/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Gelistirmede proje kokü; kurulumda extraResources klasoru. */
const BASE = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..');
const isDev = process.argv.includes('--dev');

/**
 * Kullanici veri klasoru ESKI uygulama adina sabitlenir: ad degisikligi
 * (FreeTiktokTTS) klasor degistirmesin diye. Ayarlar, yorum gecmisi ve
 * indirilen sesler %APPDATA%\tiktok-yorum-ses icinde kalmaya devam eder.
 * App sinifi kurucunda ayarlari okudugu icin BURADA, olusturulmadan once
 * sabitlenmelidir.
 */
app.setPath('userData', path.join(app.getPath('appData'), 'tiktok-yorum-ses'));
// Windows'ta 'logs' yolu userData'dan degil app.name'den turetilir;
// ad degisikligi log klasorunu de degistirmesin diye onu da sabitliyoruz.
app.setPath('logs', path.join(app.getPath('userData'), 'logs'));

/** Onizleme cumlesi: sesin diline gore. */
const PREVIEW_SENTENCES = {
  tr: 'al bu takatukaları takatukacıya götür. takatukacı takatukaları takatukalamazsa tiktoka iade et',
  en: 'Hello, this is a voice sample.',
  de: 'Guten Tag, das ist eine Stimmprobe.',
  fr: 'Bonjour, ceci est un échantillon vocal.',
  es: 'Hola, esta es una muestra de voz.',
  it: 'Ciao, questo è un campione vocale.',
  ru: 'Привет, это образец голоса.',
  ar: 'مرحبا، هذا نموذج صوتي.',
  ja: 'こんにちは。これは音声サンプルです。',
  zh: '你好，这是一个语音样本。',
  ko: '안녕하세요, 이것은 음성 샘플입니다.',
  nl: 'Hallo, dit is een stemmonster.',
  pt: 'Olá, esta é uma amostra de voz.',
  pl: 'Cześć, to próbka głosu.',
  sv: 'Hej, det här är ett röstprov.',
  default: 'Merhaba, bu bir ses örneğidir.'
};

/**
 * Autoplay kilidi: kullanici tiklamadan da ses calabilsin.
 * Bu anahtar Chromium'un "ses calmak icin etkilesim gerekli" kuralini kaldirir;
 * app hazir olmadan EKLENMELIDIR.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.disableHardwareAcceleration = false;

const SIMULATION_SAMPLES = [
  ['testci', 'merhaba arkadaşlar, sesli okuma çalışıyor mu?'],
  ['kufurlu', 'sen bi siktir be'],
  ['kamerci', 's.i.k.e.n yazdım bak'],
  ['selamci', 'günaydın, iyi yayınlar!'],
  ['uzunmetin', 'https://tiktok.com/@ornek/video/123 bu videoyu beğendim çok güzel olmuş eline sağlık'],
  ['kamerci', 'sıklık var mı arkadaş?'],
  ['kisa', 'a'],
  ['emojici', '😂😂😂🔥🔥'],
  ['ingilizce', 'this is a test comment'],
  ['harfci', 'ığ şü çö öü İĞŞÜ harfleri doğru okunuyor mu?']
];

class App {
  #switchChain = Promise.resolve();
  #voiceToken = 0;

  constructor() {
    this.window = null;
    this.settings = loadSettings();
    this.source = new TikTokSource({ t: (key, vars) => this.#t(key, vars) });
    this.tts = null;
    this.ttsEn = null; // Ingilizce yorumlar icin ikinci motor (tembel baslatilir)
    this.englishVoice = null;
    this.englishStarting = null;
    this.englishMissingLogged = false;
    this.englishLastUseAt = 0;
    this.englishUnloadTimer = null;
    this.pipeline = null;
    this.store = null;
    this.pendingComments = new Map(); // queueId -> yorum kaydi (nihai statuyle yazilir)
    this.voices = null;
    this.updateStatus = null; // {state: latest|downloading|ready|error, version?, percent?}
    this.engineError = null;
    this.logBuffer = [];
    this.statsTimer = null;
    this.t = createTranslator(resolveLanguage(this.settings.uiLanguage));
  }

  /** Kullaniciya giden gunluk mesaji: anahtar + degiskenler, metin gonderilirken uretilir. */
  #t(key, vars = null) {
    return this.t(key, vars);
  }

  /**
   * Ayar "hiz carpani" (1 = normal, buyuk = hizli).
   * Piper length_scale'i tam tersi oldugu icin 1/x olarak gonderiyoruz.
   */
  #ttsLengthScale() {
    const rate = Number(this.settings.lengthScale) || 1;
    return 1 / Math.min(2, Math.max(0.5, rate));
  }

  async init() {
    this.#createWindow();

    this.source.on('comment', (comment) => this.pipeline?.ingest(comment));
    this.source.on('event', (event) => this.pipeline?.ingest(event));
    this.source.on('log', (message) => this.#logRaw(message));
    this.source.on('status', (status) => this.#send(IPC.EVT_STATUS, status));
    this.source.on('connected', (info) => {
      this.#log('log.connected', { user: info.username });
      this.pipeline?.start(); // yayin (yeniden) acildi: is hatti devam eder
    });
    this.source.on('streamEnd', () => {
      // Yayin kapandi: aktif cumle biter ama birikmis kuyruk okunmaz
      // ('dropped' olarak gecmise yazilir). Yeniden baglanma denemelerinde
      // TikTok'un gonderdigi eski yorum paketi de msgId tekrar korumasina
      // takilir: kapali yayinda eski yorum tekrar okunmaz.
      this.pipeline?.clearQueue();
      this.pipeline?.pause();
      this.#log('log.streamQueueCleared');
    });

    this.pipeline = new Pipeline({ tts: this.#ttsProxy(), getSettings: () => this.settings, resolveTts: (lang) => this.#resolveTts(lang) });
    this.pipeline.applySettings(this.settings);
    this.source.setSettings(this.settings);

    // Kalici yorum gecmisi: append-only JSONL, arama akisla yapilir (RAM ~0)
    this.store = new CommentStore({
      dir: path.join(app.getPath('userData'), 'comments'),
      maxEntries: this.settings.historyMaxEntries ?? 100_000,
      enabled: this.settings.historyEnabled !== false
    });
    void this.store.trim(); // acilista bir kez: tavan astiysa en yenileri tut

    this.#wirePipelineEvents();
    this.#wireIpc();
    this.#initUpdater();
    void this.#checkUpdates(); // acilista arka planda surum kontrolu

    this.#startTts();
    this.statsTimer = setInterval(() => this.#send(IPC.EVT_STATS, this.pipeline.getSnapshot()), 1000);
  }

  /** Ses yoneticisi: paketli (salt okunur) + kullanici sesleri. */
  #initVoices() {
    const bundled = this.tts?.bundled ?? [];
    // Kullanici sesleri HER ZAMAN userData'ya (%APPDATA%) yazilir: yukseltme
    // sirasinda kurulum klasoru silinse bile indirilen sesler kaybolmaz.
    // Eski konum (kurulum klasoru) salt-okunur kok olarak taranmaya devam eder.
    this.voices = new VoiceManager({
      bundledDirs: bundled.length ? bundled : [path.join(BASE, 'voices', 'turkish')],
      userRoot: path.join(app.getPath('userData'), 'voices'),
      fallbackRoot: path.join(app.getPath('userData'), 'voices'),
      readOnlyRoots: [path.join(BASE, 'voices')],
      cacheDir: app.getPath('userData')
    });
    this.voices.on('progress', (p) => this.#send(IPC.EVT_VOICE_PROGRESS, p));
    this.voices.on('notice', (message) => this.#log('log.notWritable', { path: this.voices.resolveUserRoot() }));
    this.voices.on('notice', (message) => console.warn('[voices]', message));
  }

  /** Varsayilan (paketle gelen) ses. */
  #defaultVoice() {
    const list = this.voices?.getInstalled() ?? [];
    return list.find((v) => v.origin === 'bundled') ?? list[0] ?? null;
  }

  /** Aktif ses cozumlemesi: ayar -> kurulu ses; yoksa varsayilan. */
  #activeVoice() {
    const list = this.voices?.getInstalled() ?? [];
    const wanted = this.settings.voiceId;
    return list.find((v) => v.id === wanted) ?? this.#defaultVoice();
  }

  /**
 * Aktif sesi degistirir. Islemler siralanir: arka arkaya gelen istekler
 * kuyruga girer ve ESKIS olan atlanir (motor ile ayar hep ayni sesde kalir).
 */
async #applyVoice(voice, { announce = true } = {}) {
    if (!voice) return;
    const label = voice.label ?? voice.id;
    const token = ++this.#voiceToken;
    this.#switchChain = this.#switchChain.then(async () => {
      if (token !== this.#voiceToken) return; // daha yeni bir istek geldi
      if (announce) this.#log('log.voiceSwitching', { voice: label });
      await this.tts.switchModel(voice.modelPath, voice.configPath, { sampleRate: voice.sampleRate });
      if (token !== this.#voiceToken) return; // bu arada baska ses istendi
      this.activeVoice = voice;
      if (announce) {
        const speakers = voice.speakers?.length ? ` · ${voice.speakers.length}` : '';
        this.#log('log.voiceReady', { voice: label, rate: voice.sampleRate, speakers });
      }
      this.#send(IPC.EVT_ENGINE, {
        ready: true,
        sampleRate: voice.sampleRate,
        espeak: voice.espeakVoice,
        voiceId: voice.id,
        speakers: voice.speakers ?? [],
        error: null
      });
      this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'voice', id: voice.id });
    }).catch((err) => {
      this.#log('log.voiceFailed', { message: err.message }, 'error');
    });
    return this.#switchChain;
  }

  /**
   * Son kullanilan yayina otomatik baglan (ayarlarda kapatilabilir).
   * TTS motoru hazir olmasa da baglanti kurulur; is hatti motoru bekler.
   */
  async #maybeAutoStart() {
    const { autoStart, username } = this.settings;
    if (!autoStart) return;
    if (!username) {
      // Ayar acik ama kayitli yayinci yok: nedenini belirt, sessizce gecme.
      this.#log('log.autoStartNoUser');
      return;
    }
    this.#log('log.autoStart', { user: username });
    this.pipeline.start();
    try {
      await this.source.start(username);
    } catch (err) {
      this.#log('log.autoStartFailed', { message: err.message }, 'error');
    }
  }

  /**
   * TTS motorunun hazir olmasini bekler (en fazla 20 sn).
   * Erken tiklamalarda motor ~2 sn icinde hazir olur; kesin basarisizlikta
   * beklemeden doner. Kullanicinin "TTS motoru hazir degil" ham hatasi almasini onler.
   */
  #waitForEngine() {
    return waitForEngine({
      isReady: () => Boolean(this.tts?.ready),
      isFailed: () => Boolean(this.engineError)
    });
  }

  /** Motor hazir olmadan da hattin calismasi icin gecikmeli proxy. */
  #ttsProxy() {
    const self = this;
    return {
      get sampleRate() { return self.tts?.sampleRate ?? 22050; },
      get ready() { return Boolean(self.tts?.ready); },
      synthesize(text, params) {
        if (!self.tts) return Promise.reject(new Error('TTS motoru baslatilmadi'));
        return self.tts.synthesize(text, params);
      }
    };
  }

  #englishProxy() {
    const self = this;
    return {
      get sampleRate() { return self.ttsEn?.sampleRate ?? 22050; },
      get ready() { return Boolean(self.ttsEn?.ready); },
      synthesize(text, params) {
        if (!self.ttsEn) return Promise.reject(new Error('Ingilizce motor baslatilmadi'));
        return self.ttsEn.synthesize(text, params);
      }
    };
  }

  /** Yorumun diline gore motor cozumu (yorum basina tek motor). */
  async #resolveTts(lang) {
    if (lang === 'en' && this.settings.englishRouting !== false) {
      const engine = await this.#ensureEnglishEngine();
      if (engine) {
        this.#noteEnglishUse();
        return this.#englishProxy();
      }
      if (!this.englishMissingLogged) {
        this.englishMissingLogged = true;
        this.#log('log.englishVoiceMissing');
      }
    }
    return this.#ttsProxy();
  }

  /** Kurulu Ingilizce ses: ayar -> ilk gecerli en-ailesi ses. */
  #resolveEnglishVoice() {
    const list = (this.voices?.getInstalled() ?? []).filter((v) => v.valid);
    const wanted = this.settings.englishVoiceId;
    if (wanted) {
      const exact = list.find((v) => v.id === wanted);
      if (exact) return exact;
    }
    return list.find((v) => v.language?.family === 'en')
      ?? list.find((v) => String(v.espeakVoice ?? '').toLowerCase().startsWith('en'))
      ?? null;
  }

  /**
   * Ingilizce motoru tembel baslatir (ilk Ingilizce yorumda, ~2 sn).
   * Turkce motoruna dokunmaz; ikisi ayni anda sicak kalir.
   */
  async #ensureEnglishEngine() {
    const voice = this.#resolveEnglishVoice();
    if (!voice || !this.tts) return null;
    if (this.ttsEn?.ready && this.englishVoice?.id === voice.id) return this.ttsEn;
    if (this.englishStarting) {
      try { await this.englishStarting; } catch { /* asagida yeniden dene */ }
      if (this.ttsEn?.ready && this.englishVoice?.id === voice.id) return this.ttsEn;
    }
    const starting = (async () => {
      try { await this.ttsEn?.stop(); } catch { /* yoksay */ }
      const engine = new TtsEngine({
        root: BASE,
        pythonPath: this.tts.pythonPath,
        sidecarPath: this.tts.sidecarPath,
        modelPath: voice.modelPath,
        configPath: voice.configPath
      });
      engine.on('log', (message) => this.#logRaw(message));
      await engine.start();
      this.ttsEn = engine;
      this.englishVoice = voice;
      this.#log('log.englishReady', { voice: voice.label ?? voice.id, rate: engine.sampleRate });
      return engine;
    })();
    this.englishStarting = starting;
    try {
      return await starting;
    } catch (err) {
      this.#log('log.voiceFailed', { message: err.message }, 'error');
      return null;
    } finally {
      if (this.englishStarting === starting) this.englishStarting = null;
    }
  }

  async #startTts() {
    try {
      const engine = TtsEngine.fromEngineFile(BASE);
      engine.check();
      engine.on('log', (message) => this.#logRaw(message));
      this.tts = engine;
      this.#initVoices();

      const voice = this.#activeVoice();
      if (voice) {
        await this.#applyVoice(voice, { announce: false });
        this.#send(IPC.EVT_ENGINE, {
          ready: true,
          sampleRate: voice.sampleRate,
          espeak: voice.espeakVoice,
          voiceId: voice.id,
          speakers: voice.speakers ?? [],
          error: null
        });
        this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'engine-ready', id: voice.id });
      } else {
        const info = await engine.start();
        this.#send(IPC.EVT_ENGINE, { ready: true, sampleRate: info.sample_rate, espeak: info.espeak_voice, error: null });
      }
      this.#log('log.engineReady', { rate: this.tts.sampleRate, voice: voice?.espeakVoice ?? '?' });
      // Otomatik baglanma motor hazir olduktan sonra: once durum/rozetler otursun,
      // ayrica ilk yorumlar icin motor hazir olur.
      this.#maybeAutoStart();
    } catch (err) {
      this.engineError = err.message;
      this.#log('log.engineFailed', { message: err.message }, 'error');
      this.#send(IPC.EVT_ENGINE, { ready: false, error: err.message });
    }
  }

  /** Bir yorum kaydini gecmise yazar (store kapaliysa sessizce yok sayilir). */
  #storeComment(record) {
    try { this.store?.append(record); } catch { /* yazim hatasi uygulamayi dusurmesin */ }
  }

  /** Pending siniri asilirsa en eskileri 'dropped' olarak kaydedilip silinir. */
  #prunePending() {
    const max = Math.max(50, (this.settings.queueMax ?? 200) * 2);
    while (this.pendingComments.size > max) {
      const oldest = this.pendingComments.keys().next().value;
      const rec = this.pendingComments.get(oldest);
      if (rec) { rec.status = 'dropped'; this.#storeComment(rec); }
      this.pendingComments.delete(oldest);
    }
  }

  #wirePipelineEvents() {
    const p = this.pipeline;
    const forward = (channel) => (payload) => this.#send(channel, payload);

    p.on('comment-queued', (e) => {
      forward(IPC.EVT_COMMENT_QUEUED)(e);
      // Nihai statu sonradan belli olur: speech-audio -> spoken, silme -> dropped
      this.pendingComments.set(e.queueId, {
        id: e.id, userId: e.userId, userName: e.userName, text: e.text,
        spokenText: e.spokenText ?? '', at: e.at, status: 'queued', reason: null
      });
      this.#prunePending();
    });
    p.on('comment-skipped', (e) => {
      forward(IPC.EVT_COMMENT_SKIPPED)(e);
      this.#storeComment({ ...e, status: 'skipped', reason: e.reason ?? null });
    });
    p.on('speech-start', forward(IPC.EVT_SPEECH_START));
    p.on('speech-skipped', (e) => {
      forward(IPC.EVT_SPEECH_SKIPPED)(e);
      const rec = this.pendingComments.get(e.queueId);
      if (rec) {
        rec.status = 'skipped';
        rec.reason = 'atlandi';
        this.#storeComment(rec);
        this.pendingComments.delete(e.queueId);
      }
    });
    p.on('queue-cleared', (e) => {
      forward(IPC.EVT_QUEUE_CLEARED)(e);
      for (const rec of this.pendingComments.values()) { rec.status = 'dropped'; this.#storeComment(rec); }
      this.pendingComments.clear();
    });
    p.on('settings-mutated', (settings) => this.#saveSettings(settings));
    p.on('speech-error', (e) => {
      this.#log('log.speechError', { message: e.message }, 'error');
      forward(IPC.EVT_SPEECH_ERROR)(e);
    });
    p.on('speech-audio', (payload) => {
      this.#send(IPC.EVT_SPEECH_AUDIO, payload);
      const rec = this.pendingComments.get(payload.queueId);
      if (rec) {
        rec.status = 'spoken';
        this.#storeComment(rec);
        this.pendingComments.delete(payload.queueId);
      }
      p.prefetchNext(); // siradaki yorumu hazirla
    });
  }

  #wireIpc() {
    ipcMain.handle(IPC.GET_STATE, () => ({
      settings: this.settings,
      source: this.source.getStatus(),
      snapshot: this.pipeline.getSnapshot(),
      engine: {
        ready: Boolean(this.tts?.ready),
        ...(this.tts?.status ?? {}),
        voiceId: this.activeVoice?.id ?? null
      },
      engineError: this.engineError,
      voices: this.voices?.getInstalled() ?? [],
      activeVoiceId: this.activeVoice?.id ?? this.#activeVoice()?.id ?? null,
      version: app.getVersion(),
      base: BASE,
      logs: this.logBuffer.slice(-200)
    }));

    ipcMain.handle(IPC.GET_SETTINGS, () => this.settings);
    ipcMain.handle(IPC.SET_SETTINGS, (_e, patch) => this.#saveSettings(patch ?? {}));

    ipcMain.handle(IPC.START, async (_e, username) => {
      const name = String(username ?? this.settings.username).trim().replace(/^@/, '');
      if (!name) return { ok: false, error: this.#t('log.enterStreamer') };
      await this.#saveSettings({ username: name });
      this.pipeline.start();
      try {
        await this.source.start(name);
        return { ok: true };
      } catch (err) {
        this.#log('log.startFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.STOP, async () => {
      await this.source.stop();
      // Kuyruk da bosaltilir: bir sonraki baglanmada onceki oturumun birikmis
      // yorumlari ("eski yorumlar") tekrar okunmasin.
      this.pipeline.clearQueue();
      this.pipeline.pause();
      return { ok: true };
    });

    ipcMain.handle(IPC.SPEAK_TEST, async (_e, text) => {
      const value = String(text ?? '').trim() || 'Merhaba, ben sesli okuma testiyim.';
      if (!await this.#waitForEngine()) {
        return { ok: false, error: this.#t('log.engineNotReady') };
      }
      this.pipeline.clearQueue();
      this.pipeline.pause();
      try {
        const result = await this.tts.synthesize(value, {
          lengthScale: this.#ttsLengthScale(),
          noiseScale: this.settings.noiseScale,
          noiseWScale: this.settings.noiseWScale
        });
        this.#send(IPC.EVT_SPEECH_AUDIO, {
          queueId: -1,
          pcm: result.pcm,
          sampleRate: this.tts.sampleRate,
          durationSec: result.durationSec,
          synthFirstMs: result.firstMs,
          beep: false,
          test: true,
          text: value
        });
        return { ok: true, durationSec: result.durationSec };
      } finally {
        this.pipeline.start();
      }
    });

    ipcMain.handle(IPC.QUEUE_SKIP, () => ({ ok: this.pipeline.skipCurrent() }));
    ipcMain.handle(IPC.QUEUE_CLEAR, () => ({ removed: this.pipeline.clearQueue() })); // 'queue-cleared' olayi pending'i kaydeder
    ipcMain.handle(IPC.QUEUE_REMOVE, (_e, queueId) => {
      const id = Number(queueId);
      const rec = this.pendingComments.get(id);
      if (rec) { rec.status = 'dropped'; this.#storeComment(rec); this.pendingComments.delete(id); }
      return { ok: this.pipeline.removeQueued(id) };
    });
    ipcMain.handle(IPC.QUEUE_SPEAK_NOW, (_e, queueId) => ({ ok: this.pipeline.speakNow(Number(queueId)) }));

    /* ------------------------- yorum gecmisi ------------------------- */

    ipcMain.handle(IPC.HISTORY_SEARCH, async (_e, query) => {
      if (!this.store) return { ok: false, total: 0, entries: [] };
      const { total, entries } = await this.store.search(query, { limit: 100 });
      return { ok: true, total, entries };
    });
    ipcMain.handle(IPC.HISTORY_CLEAR, () => {
      this.store?.clear();
      this.#log('log.historyCleared');
      return { ok: true };
    });

    /* ------------------------- otomatik guncelleme ------------------------- */

    ipcMain.handle(IPC.UPDATE_CHECK, () => this.#checkUpdates());
    ipcMain.handle(IPC.UPDATE_RESTART, () => {
      if (this.updateStatus?.state === 'ready' && app.isPackaged) autoUpdater.quitAndInstall();
      return { ok: true };
    });

    ipcMain.handle(IPC.BLOCK_USER, (_e, userId) => {
      const list = new Set(this.settings.blockedUsers.map(String));
      list.add(String(userId));
      this.#saveSettings({ blockedUsers: [...list] });
      return { ok: true };
    });
    ipcMain.handle(IPC.UNBLOCK_USER, (_e, userId) => {
      this.#saveSettings({ blockedUsers: this.settings.blockedUsers.filter((u) => String(u) !== String(userId)) });
      return { ok: true };
    });

    ipcMain.handle(IPC.SIMULATE, (_e, count) => {
      const n = Math.min(Math.max(Number(count) || 5, 1), 50);
      this.pipeline.start(); // simülasyon da seslendirir
      for (let i = 0; i < n; i += 1) {
        const [userId, text] = SIMULATION_SAMPLES[i % SIMULATION_SAMPLES.length];
        this.pipeline.ingest({
          id: `sim-${Date.now()}-${i}`,
          userId,
          userName: userId,
          text,
          at: Date.now()
        });
      }
      return { ok: true, count: n };
    });

    ipcMain.handle(IPC.CHECK_ENGINE, () => {
      try {
        const engine = TtsEngine.fromEngineFile(BASE);
        engine.check();
        return { ok: true, base: BASE };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.OPEN_EXTERNAL, (_e, url) => {
      if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
      return { ok: true };
    });

    /* ------------------------- ses yonetimi ------------------------- */

    ipcMain.handle(IPC.VOICE_PATHS, () => ({
      userRoot: this.voices?.resolveUserRoot() ?? path.join(BASE, 'voices'),
      bundledDirs: this.voices?.bundledDirs ?? []
    }));

    ipcMain.handle(IPC.VOICE_INSTALLED, () => ({
      voices: this.voices?.getInstalled() ?? [],
      // Motor henuz yuklenmemis olsa bile aktif ses cozumlenebilsin
      activeId: this.activeVoice?.id ?? this.#activeVoice()?.id ?? null,
      englishId: this.englishVoice?.id ?? this.#resolveEnglishVoice()?.id ?? null
    }));

    ipcMain.handle(IPC.VOICE_CATALOG, async (_e, refresh) => {
      try {
        const catalog = await this.voices.getCatalog({ refresh: Boolean(refresh) });
        const installed = new Set((this.voices.getInstalled() ?? []).map((v) => v.catalogId).filter(Boolean));
        return {
          ok: true,
          updatedAt: catalog.updatedAt,
          count: catalog.count,
          entries: catalog.entries.map((e) => ({ ...e, installed: installed.has(e.id) }))
        };
      } catch (err) {
        this.#log('log.catalogError', { message: err.message }, 'error');
        return { ok: false, error: err.message, entries: [] };
      }
    });

    ipcMain.handle(IPC.VOICE_INSTALL, async (_e, id) => {
      try {
        const entry = this.voices.catalogEntry(String(id));
        this.#log('log.downloadStart', { voice: `${entry.language.native} · ${entry.name}` });
        const voice = await this.voices.install(String(id));
        this.#log('log.downloadDone', { voice: voice.label ?? voice.id, size: formatBytes(voice.sizeBytes) });
        this.englishMissingLogged = false;
        this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'installed', id: voice.id });
        return { ok: true, voice };
      } catch (err) {
        if (err?.name === 'AbortError') {
          this.#log('log.downloadCancel');
          return { ok: false, cancelled: true };
        }
        this.#log('log.importFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.VOICE_CANCEL, (_e, id) => ({ ok: this.voices.cancel(String(id)) }));

    ipcMain.handle(IPC.VOICE_REMOVE, (_e, id) => {
      const voice = (this.voices.getInstalled() ?? []).find((v) => v.id === String(id));
      const result = this.voices.remove(String(id));
      if (result.ok) {
        this.#log('log.removed', { voice: voice?.label ?? String(id) });
        this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'removed', id: String(id) });
      } else {
        this.#log('log.removeFailed', { message: result.error }, 'error');
      }
      return result;
    });

    ipcMain.handle(IPC.VOICE_IMPORT, async () => {
      try {
        const picked = await dialog.showOpenDialog(this.window, {
          title: this.#t('settings.pickModelFile'),
          properties: ['openFile'],
          filters: [{ name: 'Piper ONNX', extensions: ['onnx'] }]
        });
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };

        let modelPath = picked.filePaths[0];
        let configPath = null;
        const base = path.basename(modelPath).replace(/\.onnx$/i, '');
        const dir = path.dirname(modelPath);
        const guess = [path.join(dir, `${base}.onnx.json`), path.join(dir, `${base}.json`)]
          .find((p) => existsSync(p));
        if (guess) {
          configPath = guess;
        } else {
          const pickedConfig = await dialog.showOpenDialog(this.window, {
            title: this.#t('settings.pickConfigFile'),
            properties: ['openFile'],
            filters: [{ name: 'Piper config', extensions: ['json'] }]
          });
          if (pickedConfig.canceled || !pickedConfig.filePaths[0]) return { ok: false, cancelled: true };
          configPath = pickedConfig.filePaths[0];
        }

        const voice = this.voices.importLocal(modelPath, configPath);
        this.#log('log.imported', { voice: voice.label ?? voice.id });
        this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'imported', id: voice.id });
        return { ok: true, voice };
      } catch (err) {
        this.#log('log.importFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.VOICE_SET_ACTIVE, async (_e, id) => {
      try {
        if (!await this.#waitForEngine()) return { ok: false, error: this.#t('log.engineNotReady') };
        const voice = this.voices.resolve(String(id));
        await this.#applyVoice(voice);
        await this.#saveSettings({ voiceId: voice.id, speakerId: 0 });
        this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'active', id: voice.id });
        return { ok: true, voice };
      } catch (err) {
        this.#log('log.voiceFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.VOICE_SET_ENGLISH, async (_e, id) => {
      try {
        const voice = this.voices.resolve(String(id));
        await this.#saveSettings({ englishVoiceId: voice.id, englishSpeakerId: 0 });
        this.englishMissingLogged = false;
        // Farkli model caliyorsa simdi durdur; yenisi tembel baslatilir.
        if (this.ttsEn && this.englishVoice?.id !== voice.id) {
          try { await this.ttsEn.stop(); } catch { /* yoksay */ }
          this.ttsEn = null;
          this.englishVoice = null;
        }
        this.#send(IPC.EVT_VOICES_CHANGED, { reason: 'english', id: voice.id });
        return { ok: true, voice };
      } catch (err) {
        this.#log('log.voiceFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.VOICE_PREVIEW_ENGLISH, async (_e, id) => {
      try {
        if (id) {
          const voice = this.voices.resolve(String(id));
          await this.#saveSettings({ englishVoiceId: voice.id, englishSpeakerId: 0 });
          this.englishMissingLogged = false;
          if (this.ttsEn && this.englishVoice?.id !== voice.id) {
            try { await this.ttsEn.stop(); } catch { /* yoksay */ }
            this.ttsEn = null;
            this.englishVoice = null;
          }
        }
        const engine = await this.#ensureEnglishEngine();
        if (!engine) return { ok: false, error: this.#t('log.englishVoiceMissing') };
        this.#noteEnglishUse();
        const voice = this.englishVoice;
        const result = await engine.synthesize(PREVIEW_SENTENCES.en, {
          lengthScale: this.#ttsLengthScale(),
          noiseScale: this.settings.noiseScale,
          noiseWScale: this.settings.noiseWScale,
          speakerId: this.settings.englishSpeakerId ?? 0
        });
        this.#send(IPC.EVT_SPEECH_AUDIO, {
          queueId: -2,
          pcm: result.pcm,
          sampleRate: engine.sampleRate,
          durationSec: result.durationSec,
          test: true,
          voiceLabel: voice.label ?? voice.id,
          text: PREVIEW_SENTENCES.en,
          lang: 'en'
        });
        return { ok: true, durationSec: result.durationSec, voice: voice.label ?? voice.id };
      } catch (err) {
        this.#log('log.voiceFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle(IPC.VOICE_PREVIEW, async (_e, id) => {
      try {
        if (!await this.#waitForEngine()) return { ok: false, error: this.#t('log.engineNotReady') };
        const list = this.voices.getInstalled() ?? [];
        const voice = id ? list.find((v) => v.id === String(id)) : this.activeVoice;
        if (!voice) return { ok: false, error: 'voice yok' };
        const wasActive = this.activeVoice?.id === voice.id;
        if (!wasActive) {
          await this.#applyVoice(voice, { announce: false });
          this.#saveSettings({ voiceId: voice.id, speakerId: 0 });
        }
        const sentence = PREVIEW_SENTENCES[voice.language?.family] ?? PREVIEW_SENTENCES.default;
        const result = await this.tts.synthesize(sentence, {
          lengthScale: this.#ttsLengthScale(),
          noiseScale: this.settings.noiseScale,
          noiseWScale: this.settings.noiseWScale,
          speakerId: wasActive ? (this.settings.speakerId ?? 0) : 0
        });
        this.#send(IPC.EVT_SPEECH_AUDIO, {
          queueId: -2,
          pcm: result.pcm,
          sampleRate: this.tts.sampleRate,
          durationSec: result.durationSec,
          test: true,
          voiceLabel: voice.label ?? voice.id,
          text: sentence
        });
        return { ok: true, durationSec: result.durationSec, voice: voice.label ?? voice.id };
      } catch (err) {
        this.#log('log.voiceFailed', { message: err.message }, 'error');
        return { ok: false, error: err.message };
      }
    });
  }

  /** Ingilizce motor kullanimini isler ve tutma ayarini uygular. */
  #noteEnglishUse() {
    this.englishLastUseAt = Date.now();
    this.#scheduleEnglishUnload();
  }

  /* ------------------------- otomatik guncelleme ------------------------- */

  /** electron-updater olaylarini baglar (yalnizca paketlenmis surumde). */
  #initUpdater() {
    if (!app.isPackaged) return; // gelistirme: kontrol kapali
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // kapanista kendiliginden kurulur
    autoUpdater.on('update-available', (info) => {
      this.updateStatus = { state: 'downloading', version: info?.version ?? '' };
      this.#send(IPC.EVT_UPDATE, this.updateStatus);
      this.#log('log.updateFound', { version: info?.version ?? '?' });
    });
    autoUpdater.on('update-not-available', () => {
      this.updateStatus = { state: 'latest' };
      this.#send(IPC.EVT_UPDATE, this.updateStatus);
    });
    autoUpdater.on('download-progress', (p) => {
      this.updateStatus = { state: 'downloading', percent: Math.round(p?.percent ?? 0) };
      this.#send(IPC.EVT_UPDATE, this.updateStatus);
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.updateStatus = { state: 'ready', version: info?.version ?? '' };
      this.#send(IPC.EVT_UPDATE, this.updateStatus);
      this.#log('log.updateReady', { version: info?.version ?? '?' });
    });
    autoUpdater.on('error', () => { /* cevrimdisi vb: sessiz kal */ });
  }

  /** Surum kontrolu yapar (manuel dugme + acilis). Son durumu dondurur. */
  async #checkUpdates() {
    if (!app.isPackaged) return { state: 'dev' };
    try {
      await autoUpdater.checkForUpdates();
      return this.updateStatus ?? { state: 'latest' };
    } catch {
      this.updateStatus = { state: 'error' };
      return this.updateStatus;
    }
  }

  #scheduleEnglishUnload() {
    clearTimeout(this.englishUnloadTimer);
    this.englishUnloadTimer = null;
    if (this.settings.keepBothEngines !== false || !this.ttsEn) return;
    this.englishUnloadTimer = setTimeout(() => {
      void this.#maybeUnloadEnglish();
    }, ENGLISH_IDLE_TIMEOUT_MS);
    this.englishUnloadTimer.unref?.();
  }

  async #maybeUnloadEnglish() {
    this.englishUnloadTimer = null;
    if (this.settings.keepBothEngines !== false || !this.ttsEn) return;
    if (!englishIdleExpired(this.englishLastUseAt)) {
      this.#scheduleEnglishUnload();
      return;
    }
    try { await this.ttsEn.stop(); } catch { /* yoksay */ }
    this.ttsEn = null;
    this.englishVoice = null;
    this.#log('log.englishUnloaded');
  }

  #saveSettings(patch) {
    const previousLanguage = resolveLanguage(this.settings.uiLanguage);
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    saveSettings(this.settings);
    this.pipeline?.applySettings(this.settings);
    this.source.setSettings(this.settings);
    this.#scheduleEnglishUnload();

    if (this.store) {
      this.store.setEnabled(this.settings.historyEnabled !== false);
      this.store.maxEntries = Math.max(1000, Number(this.settings.historyMaxEntries) || 100_000);
    }

    // Arayuz dili degistiyse cevirici degistir + son mesaji yeniden cevir
    const nextLanguage = resolveLanguage(this.settings.uiLanguage);
    if (nextLanguage !== previousLanguage) {
      this.t = createTranslator(nextLanguage);
      const last = [...this.logBuffer].reverse().find((l) => l.key);
      if (last) {
        last.message = this.#t(last.key, last.vars);
        this.#send(IPC.EVT_LOG, { level: last.level, message: last.message, at: last.at });
      }
      this.source.t = (key, vars) => this.#t(key, vars);
    }
    this.#send(IPC.EVT_SETTINGS, this.settings);
    return this.settings;
  }

  #log(key, vars = null, level = 'info') {
    const message = this.#t(key, vars);
    const line = { key, vars, level, message, at: Date.now() };
    this.logBuffer.push(line);
    if (this.logBuffer.length > 500) this.logBuffer.shift();
    this.#appendLogFile(line);
    this.#send(IPC.EVT_LOG, { level, message, at: line.at });
    console.log(`[${new Date(line.at).toISOString().slice(11, 19)}] ${level.toUpperCase()} ${message}`);
  }

  /** Ceviri yok, dogrudan metin (motor/connector loglari). */
  #logRaw(message, level = 'info') {
    const line = { key: null, raw: message, level, message, at: Date.now() };
    this.logBuffer.push(line);
    if (this.logBuffer.length > 500) this.logBuffer.shift();
    this.#appendLogFile(line);
    this.#send(IPC.EVT_LOG, { level, message, at: line.at });
    console.log(`[${new Date(line.at).toISOString().slice(11, 19)}] ${level.toUpperCase()} ${message}`);
  }

  /** Kullanici ve destek icin dosya gunlugu (userData/app.log). */
  #appendLogFile({ at, level, message }) {
    try {
      const dir = app.getPath('logs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        path.join(dir, 'app.log'),
        `${new Date(at).toISOString()} [${level}] ${message}\n`,
        'utf8'
      );
    } catch { /* gunluk yazilamadi, onemsiz */ }
  }

  #send(channel, payload) {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  #createWindow() {
    // Gelistirmede pencere simgesi build/icon.png'den alinir; paketlenmis
    // kurulumda simge zaten .exe icine gomuludur.
    const iconPath = path.join(BASE, 'build', 'icon.png');
    this.window = new BrowserWindow({
      width: 1380,
      height: 880,
      minWidth: 1060,
      minHeight: 700,
      backgroundColor: '#0e1116',
      title: 'FreeTiktokTTS',
      autoHideMenuBar: true,
      ...(existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    if (isDev) this.window.webContents.openDevTools({ mode: 'detach' });
    this.window.on('closed', () => { this.window = null; });
  }

  async shutdown() {
    clearInterval(this.statsTimer);
    clearTimeout(this.englishUnloadTimer);
    await this.source.stop(); // once kaynak dursun: yeni yorum gelmesin
    // Gecmis kaybi yok: bekleyen yorumlari yaz, tamponu diske dok
    for (const rec of this.pendingComments.values()) this.#storeComment(rec);
    this.pendingComments.clear();
    this.store?.flush();
    await this.tts?.stop();
    await this.ttsEn?.stop();
  }
}

const instance = new App();

app.whenReady().then(() => {
  // Web Audio icin mikrofon/ses izinlerini otomatik ver (autoplay switch'i ile birlikte)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'audioCapture' || permission === 'media');
  });
  instance.init();
});

app.on('window-all-closed', async () => {
  await instance.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) instance.init();
});

process.on('uncaughtException', (err) => {
  console.error('[main] yakalanmamis hata:', err);
});

export { App };
