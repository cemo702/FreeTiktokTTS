/**
 * Is hatti: yorumlar gelir -> filtre -> kuyruk -> TTS -> ses cikisi.
 *
 * OnarÄ±m:
 *  - her zaman TEK konusma birden (Ã¼st uste binme yok)
 *  - bir sonraki yorum, su an konusulan ses calinirken onceden sentezlenir
 *    (bosluk olmaz, ilk ses gecikmesi his edilmez)
 *  - kuyruk bosken yeni yorum gelirse aninda konusmaya baslanir
 */
import { EventEmitter } from 'node:events';
import { detectCommentLanguage, evaluateComment, toSpeakable } from './filters.js';
import { SpeechQueue } from './speech-queue.js';

/**
 * TikTok, (yeniden) baglanmalarda son yorumlari bir "gecmis paketi" olarak
 * tekrar gonderir (connector WS parametresi: history_comment_count). Ayni
 * msgId ikinci kez gelirse yorum sessizce dusurulur; sinir, RAM etkisini
 * ~100 KB altinda tutar (~5000 msgId, tipik akista saatlerce kapsama).
 */
const SEEN_IDS_MAX = 5_000;

export class Pipeline extends EventEmitter {
  constructor({ tts, getSettings, resolveTts }) {
    super();
    this.tts = tts;
    this.getSettings = getSettings;
    // Dile gore motor cozumu (main verir); yoksa tek motor kullanilir.
    this.resolveTts = resolveTts ?? (async () => this.tts);
    this.queue = new SpeechQueue();
    this.seenIds = new Set();   // msgId tekrar korumasi (TikTok gecmis paketi)
    this.state = { lastText: new Map(), cooldown: new Map() };
    this.current = null;      // { item, startedAt }
    this.prefetched = null;   // { item, promise }
    this.timer = null;
    this.prefetchTimer = null;
    this.running = false;
    this.stats = {
      received: 0, spoken: 0, skipped: 0, dropped: 0, errors: 0,
      lastLatencyMs: null, avgLatencyMs: null,
      lastSynthMs: null, avgSynthMs: null,
      commentsPerMinute: 0
    };
    this.commentTimes = [];
  }

  applySettings(settings) {
    this.queue.maxSize = settings.queueMax;
    this.queue.maxPerMinute = settings.maxPerMinute;
    this.queue.queueAll = settings.queueAll !== false;
    this.queue.minGapMs = settings.minGapMs;
    this.#applySpeedToQueue(settings);
  }

  #applySpeedToQueue(settings) {
    // Arayuz "hiz carpani" gosterir (1 = normal, buyuk = hizli).
    // Piper'in length_scale'i ise tam tersi: kucuk = hizli.
    const rate = Number(settings.lengthScale) || 1;
    const base = {
      lengthScale: 1 / rate,
      noiseScale: settings.noiseScale,
      noiseWScale: settings.noiseWScale
    };
    // Hiz/gurultu ortak; konusmaci dile gore ayri (Ingilizce modelde baska kisi).
    this.speed = {
      tr: { ...base, speakerId: settings.speakerId ?? 0 },
      en: { ...base, speakerId: settings.englishSpeakerId ?? 0 }
    };
  }

  start() {
    this.running = true;
    this.#pump();
  }

  pause() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
  }

  /** Bir yorumu alir ve degerlendirir. */
  ingest(comment) {
    // Tekrar korumasi: ayni msgId birkac kez teslim edilebilir (yayin kapanip
    // yeniden baglanirken TikTok'un gonderdigi gecmis paketi). Ikinci teslimat
    // istatistige ve gecmise hic yazilmadan yutulur: yorum bir kez okunur.
    const dedupId = String(comment?.id ?? '');
    if (dedupId) {
      if (this.seenIds.has(dedupId)) {
        return { accepted: false, reason: 'duplicate', duplicate: true };
      }
      this.seenIds.add(dedupId);
      if (this.seenIds.size > SEEN_IDS_MAX) {
        this.seenIds.delete(this.seenIds.values().next().value);
      }
    }

    const settings = this.getSettings();
    this.stats.received += 1;
    this.#trackRate();

    const result = evaluateComment(comment, settings, this.state);
    if (result.mutatedSettings) this.emit('settings-mutated', result.mutatedSettings);

    const record = {
      id: comment.id,
      userId: comment.userId,
      userName: comment.userName,
      text: comment.text,
      at: comment.at ?? Date.now()
    };

    if (!result.speak) {
      this.stats.skipped += 1;
      this.emit('comment-skipped', { ...record, reason: result.reason, profanity: result.profanity });
      return { accepted: false, reason: result.reason };
    }

    // Yorum basina TEK motor: Ingilizce basladiysa tamami Ingilizce,
    // yoksa tamami Turkce (karisik cumlelerde motor degistirilmez).
    const lang = settings.englishRouting !== false
      ? detectCommentLanguage(comment.text, settings.cleanup || {})
      : 'tr';

    let spokenText = result.spokenText;
    if (settings.speakUsername && comment.userName) {
      const says = lang === 'en' ? 'says' : 'diyor ki';
      spokenText = `${toSpeakable(comment.userName, { expandAbbreviations: false }) || 'bir kullanici'} ${says}, ${spokenText}`;
    }

    const priority = comment.priority ?? 0;
    const item = this.queue.push({
      text: spokenText,
      lang,
      userId: comment.userId,
      userName: comment.userName,
      priority,
      beep: result.beep,
      meta: { commentId: comment.id, receivedAt: record.at, profanity: result.profanity }
    });

    this.stats.dropped = this.queue.dropped;
    this.emit('comment-queued', {
      ...record,
      spokenText,
      lang,
      queueId: item.id,
      position: this.queue.items.findIndex((i) => i.id === item.id) + 1,
      priority,
      beep: result.beep,
      profanity: result.profanity
    });
    this.#pump();
    return { accepted: true, queueId: item.id, spokenText };
  }

  /** Su an konusulani atla (kuyruktaki siraya gecer). */
  skipCurrent() {
    if (!this.current) return false;
    this.emit('speech-skipped', { queueId: this.current.item.id, text: this.current.item.text });
    this.current.cancelled = true;
    this.current = null;
    this.stats.skipped += 1;
    return true;
  }

  clearQueue() {
    const removed = this.queue.clear();
    this.prefetched = null;
    this.emit('queue-cleared', { removed });
    return removed;
  }

  /** Kuyruktaki belirli ogeyi kaldirir (okunmadan). */
  removeQueued(queueId) {
    this.prefetched = null;
    return this.queue.remove(queueId);
  }

  /** Kuyruktaki belirli ogeyi hemen okutur. */
  speakNow(queueId) {
    if (!this.queue.promote(queueId)) return false;
    this.prefetched = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.#pump();
    return true;
  }

  #trackRate() {
    const now = Date.now();
    this.commentTimes.push(now);
    while (this.commentTimes.length && this.commentTimes[0] < now - 60_000) this.commentTimes.shift();
    this.stats.commentsPerMinute = this.commentTimes.length;
  }

  /** Kuyrugu isler: gerekirse onceden sentezle, sonra oynat. */
  async #pump() {
    if (this.current || !this.running) return;

    const now = Date.now();
    if (this.queue.canSpeakAt(now) > now) {
      this.#scheduleNext(this.queue.canSpeakAt(now));
      return;
    }

    const item = this.queue.peek(now);
    if (!item) return;

    // Onceden sentezlenmis oge varsa onu kullan, siradan cikar
    let entry = this.prefetched;
    this.prefetched = null;
    if (!entry || entry.item.id !== item.id) {
      entry = { item, promise: this.#synthesize(item) };
    }

    this.current = { item, startedAt: Date.now(), cancelled: false };
    this.emit('speech-start', {
      queueId: item.id, text: item.text, lang: item.lang, userId: item.userId, userName: item.userName, beep: item.beep
    });
    this.queue.take(now);

    try {
      const { result, sampleRate } = await entry.promise;
      if (this.current?.cancelled) return;
      this.stats.spoken += 1;
      this.#recordLatency(Date.now() - item.enqueuedAt);
      // Saf sentez sÃ¼resi (kuyruk beklemesi hariÃ§)
      if (typeof result.firstMs === 'number') {
        this.stats.lastSynthMs = Math.round(result.firstMs);
        const prev = this.stats.avgSynthMs;
        this.stats.avgSynthMs = prev === null || prev === undefined
          ? this.stats.lastSynthMs
          : Math.round(prev * 0.7 + this.stats.lastSynthMs * 0.3);
      }
      this.emit('speech-audio', {
        queueId: item.id,
        pcm: result.pcm,
        sampleRate,
        durationSec: result.durationSec,
        synthFirstMs: result.firstMs,
        beep: item.beep,
        text: item.text,
        lang: item.lang
      });
      this.current = null;
      // Konusmanin bitis zamanini kuyruga bildir: bosluk onceki yorumun
      // bitisinden itibaren hesaplansin.
      const estimatedEnd = Date.now() + (result.durationSec ?? 0) * 1000;
      this.queue.noteEnd(estimatedEnd);
      this.#scheduleNext(estimatedEnd + (this.getSettings().gapSilenceMs ?? 120));
    } catch (err) {
      this.current = null;
      this.stats.errors += 1;
      this.emit('speech-error', { queueId: item.id, text: item.text, message: err.message });
      this.#scheduleNext(Date.now() + 500);
    }
  }

  #recordLatency(ms) {
    this.stats.lastLatencyMs = ms;
    const prev = this.stats.avgLatencyMs;
    this.stats.avgLatencyMs = prev === null || prev === undefined ? ms : Math.round(prev * 0.7 + ms * 0.3);
  }

  async #synthesize(item) {
    const lang = item.lang === 'en' ? 'en' : 'tr';
    const tts = await this.resolveTts(lang);
    const params = (this.speed ?? {})[lang] ?? this.speed ?? {};
    const result = await this.#withEngine(tts, () => tts.synthesize(item.text, params));
    return { result, sampleRate: tts.sampleRate ?? this.tts?.sampleRate ?? 22050 };
  }

  /** TTS motoru hazir olana kadar bekler (acilista model yüklenirken gerekli). */
  async #withEngine(tts, fn, timeoutMs = 25_000) {
    const started = Date.now();
    while (!tts.ready) {
      if (Date.now() - started > timeoutMs) throw new Error('TTS motoru hazir olmadi');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return fn();
  }

  /** Siradaki yorumu onceden sentezle (ses calarken hazir olsun). */
  prefetchNext() {
    if (!this.running || this.prefetched) return;
    const item = this.queue.peek(Date.now());
    if (!item) return;
    this.prefetched = { item, promise: this.#synthesize(item) };
    this.emit('prefetch', { queueId: item.id, text: item.text });
  }

  #scheduleNext(at) {
    clearTimeout(this.timer);
    const delay = Math.max(0, at - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#pump();
    }, Math.min(delay, 5_000));
    this.timer.unref?.();
    this.prefetchSoon();
  }

  /** Bir sonraki konusmaya hazir olmak icin kuyruktaki ilk ogeyi kisa sure sonra sentezle. */
  prefetchSoon(delayMs = 250) {
    if (!this.running || this.prefetched) return;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.prefetchNext();
    }, delayMs);
    this.prefetchTimer.unref?.();
  }

  getSnapshot() {
    return {
      stats: { ...this.stats },
      queue: this.queue.list(),
      queueLength: this.queue.length,
      dropped: this.queue.dropped,
      current: this.current
        ? { queueId: this.current.item.id, text: this.current.item.text, userName: this.current.item.userName }
        : null,
      nextInMs: this.queue.length ? Math.max(0, this.queue.canSpeakAt(Date.now()) - Date.now()) : 0,
      oldestAgeMs: this.queue.oldestAge(Date.now())
    };
  }
}

export default Pipeline;
