/**
 * TikTok canli yayin yorum kaynagi (tiktok-live-connector).
 *
 * Yalnizca kullanici adi gerekir; giris bilgisi yoktur.
 * Olaylar: CHAT, GIFT, SUBSCRIBE, FOLLOW, CONNECTED/DISCONNECTED.
 */
import { EventEmitter } from 'node:events';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

const RECONNECT_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000];
const VIEWER_FALLBACK_DELAY_MS = 30_000;

/** TikTok sayaclari sayi ya da sayisal metin olarak gelebilir. */
export function normalizeViewerCount(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) return null;
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const asNumber = Number(text);
    return Number.isFinite(asNumber) && asNumber >= 0 ? Math.floor(asNumber) : null;
  }
  if (value && typeof value === 'object') {
    const { high, low } = value;
    if (Number.isInteger(high) && Number.isInteger(low) && high >= 0 && low >= 0) {
      const asBigInt = (BigInt(high) << 32n) + BigInt(low);
      const asNumber = Number(asBigInt);
      return Number.isSafeInteger(asNumber) ? asNumber : null;
    }
    if (typeof value.toNumber === 'function') {
      try {
        return normalizeViewerCount(value.toNumber());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** tiktok-live-connector farkli surumlerde alan adlari degismis olabilir; savunmacı oku. */
function readUser(data) {
  const user = data?.user ?? data?.fromUser ?? {};
  const id = user.displayId ?? user.uniqueId ?? user.idStr ?? user.id ?? '';
  return { id: String(id), name: String(user.nickname ?? id) };
}

function readRoomInfoCount(roomInfo) {
  return normalizeViewerCount(roomInfo?.data?.user_count)
    ?? normalizeViewerCount(roomInfo?.data?.stats?.total_user)
    ?? normalizeViewerCount(roomInfo?.user_count)
    ?? normalizeViewerCount(roomInfo?.viewerCount)
    ?? null;
}

function formatViewerCount(value) {
  return value ?? '—';
}

function readRoomTitle(roomInfo) {
  return roomInfo?.data?.title ?? roomInfo?.title ?? '';
}

/** Connector bazen string, bazen Error, bazen bilinmeyen nesne gonderir. */
function describeError(err) {
  if (!err) return 'bilinmeyen hata';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.reason) return String(err.reason);
  try {
    return JSON.stringify(err).slice(0, 200);
  } catch {
    return String(err);
  }
}

const OFFLINE_RE = /offline|not live|isn't online|not online|is offline|yayinda degil/i;

export class TikTokSource extends EventEmitter {
  /** @param {{t?: (key:string, vars?:object) => string, createConnection?: Function}} options cevirici (main'den gelir) */
  constructor(options = {}) {
    super();
    this.t = options.t ?? ((key) => key);
    this.createConnection = options.createConnection ?? ((username, connectionOptions) => new TikTokLiveConnection(username, connectionOptions));
    this.connection = null;
    this.username = '';
    this.status = 'kapali'; // kapali | baglaniyor | canli | hata | bekliyor
    this.retryIndex = 0;
    this.timer = null;
    this.stopped = true;
    this.viewerCount = null;
    this.roomInfo = null;
    this.startedAt = 0;
    this.viewerFallbackTimer = null;
    this.viewerFetchInFlight = false;
    this.lastViewerEventAt = 0;
    this.settings = null;
  }

  get isLive() {
    return this.status === 'canli';
  }

  /** Ayarlar (readGifts vb.) aninda etkili olsun. */
  setSettings(settings) {
    this.settings = settings;
  }

  async start(username) {
    const name = String(username ?? '').trim().replace(/^@/, '');
    if (!name) throw new Error('TikTok kullanici adi gerekli');
    await this.stop();
    this.username = name;
    this.stopped = false;
    this.retryIndex = 0;
    await this.#connect();
  }

  async #connect() {
    if (this.stopped) return;
    // Onceki baglantiyi once kapat: uzerine yazilan socket'ler kapanmaz ve
    // dinleyicileri canli kalirdi -> cift "Yayin bitti" ve tekrar yorum paketi.
    this.#closeConnection();
    this.#resetViewerState();
    this.#setStatus('baglaniyor');
    const conn = this.createConnection(this.username, { retryCount: 0 });
    this.connection = conn;
    // Hayalet olay korumasi: bu socket artik guncel degilse olaylari yoksay.
    const isCurrent = () => this.connection === conn;

    conn.on(WebcastEvent.ROOM_USER, (data) => { if (isCurrent()) this.#handleRoomUser(data); });
    conn.on(WebcastEvent.CHAT, (data) => {
      if (!isCurrent()) return;
      const { id, name } = readUser(data);
      this.emit('comment', {
        id: String(data.common?.msgId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        userId: id,
        userName: name,
        text: String(data.content ?? data.comment ?? ''),
        at: Date.now()
      });
    });

    if (this.settings?.readGifts) {
      conn.on(WebcastEvent.GIFT, (data) => {
        if (!isCurrent()) return;
        const { id, name } = readUser(data);
        const gift = data.gift ?? data.giftDetails ?? {};
        const count = data.repeatCount ?? 1;
        const giftName = gift.name ?? gift.describe ?? data.displayTextForAudience ?? data.trayDisplayText ?? 'hediye';
        this.emit('event', {
          id: String(data.common?.msgId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          kind: 'hediye',
          userId: id,
          userName: name,
          text: `${giftName} x${count}`,
          priority: 5,
          at: Date.now()
        });
      });

      conn.on(WebcastEvent.SUB_NOTIFY, (data) => {
        if (!isCurrent()) return;
        const { id, name } = readUser(data);
        this.emit('event', {
          id: String(data.common?.msgId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          kind: 'abone',
          userId: id,
          userName: name || 'bir kullanici',
          text: 'abone oldu',
          priority: 4,
          at: Date.now()
        });
      });

      conn.on(WebcastEvent.FOLLOW, (data) => {
        if (!isCurrent()) return;
        const { id, name } = readUser(data);
        this.emit('event', {
          id: String(data.common?.msgId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          kind: 'takip',
          userId: id,
          userName: name || 'bir kullanici',
          text: 'takip etti',
          priority: 3,
          at: Date.now()
        });
      });
    }

    conn.on(WebcastEvent.STREAM_END, () => {
      if (!isCurrent()) return;
      this.emit('log', this.t('log.streamEnd'));
      this.emit('streamEnd');
      this.#resetViewerState();
      this.#setStatus('bekliyor');
      this.#scheduleReconnect();
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      if (this.stopped || !isCurrent()) return;
      this.emit('log', this.t('log.disconnected'));
      this.#resetViewerState();
      this.#setStatus('hata');
      this.#scheduleReconnect();
    });

    conn.on(ControlEvent.ERROR, (err) => {
      if (!isCurrent()) return;
      this.emit('log', this.t('log.tiktokError', { message: describeError(err) }));
    });

    try {
      await conn.connect();
      this.roomInfo = conn.roomInfo ?? null;
      this.#setViewerCount(readRoomInfoCount(this.roomInfo));
      this.startedAt = Date.now();
      this.retryIndex = 0;
      this.#setStatus('canli');
      this.emit('connected', { username: this.username, roomInfo: this.roomInfo });
      this.emit('log', this.t('log.liveConnected', { user: this.username, viewers: formatViewerCount(this.viewerCount) }));
      this.#scheduleViewerFallback();
    } catch (err) {
      const message = describeError(err);
      this.emit('log', this.t('log.connectRetry', { message }));
      this.#setStatus('hata');
      // Kullanici yayinda degilse surekli denemek yerine bekle
      if (OFFLINE_RE.test(message)) this.#setStatus('bekliyor');
      // Basarisiz socket hemen kapatilir: TikTok bazen baglanma tamamlanmadan
      // eski yorum paketi gonderip sonra reddediyor; o socket'in dinleyicileri
      // kalmasin.
      this.#closeConnection();
      this.#scheduleReconnect();
    }
  }

  /**
   * ROOM_USER yukundeki `total`, eszamanli izleyici sayisidir.
   * `totalUser` kumule/toplam bir sayac oldugu icin goruntu metrigi olarak kullanilmaz.
   */
  #handleRoomUser(data) {
    const next = normalizeViewerCount(data?.viewerCount ?? data?.total);
    if (next === null) return;
    this.lastViewerEventAt = Date.now();
    this.#setViewerCount(next);
    this.#scheduleViewerFallback();
  }

  #setViewerCount(next) {
    if (next === null || next === this.viewerCount) return;
    this.viewerCount = next;
    this.emit('status', this.getStatus());
  }

  #resetViewerState() {
    this.viewerCount = null;
    this.roomInfo = null;
    this.lastViewerEventAt = 0;
    this.viewerFetchInFlight = false;
    clearTimeout(this.viewerFallbackTimer);
    this.viewerFallbackTimer = null;
  }

  #scheduleViewerFallback() {
    clearTimeout(this.viewerFallbackTimer);
    this.viewerFallbackTimer = null;
    if (this.stopped || this.status !== 'canli') return;
    this.viewerFallbackTimer = setTimeout(() => {
      void this.#refreshViewerCount();
    }, VIEWER_FALLBACK_DELAY_MS);
    this.viewerFallbackTimer.unref?.();
  }

  async #refreshViewerCount() {
    this.viewerFallbackTimer = null;
    if (this.stopped || this.status !== 'canli') return;
    if (this.viewerFetchInFlight || Date.now() - this.lastViewerEventAt < VIEWER_FALLBACK_DELAY_MS) {
      this.#scheduleViewerFallback();
      return;
    }
    const conn = this.connection;
    if (!conn || typeof conn.fetchRoomInfo !== 'function') return;
    this.viewerFetchInFlight = true;
    try {
      const roomInfo = await conn.fetchRoomInfo();
      if (this.stopped || this.status !== 'canli' || this.connection !== conn) return;
      this.roomInfo = roomInfo ?? null;
      this.#setViewerCount(readRoomInfoCount(this.roomInfo));
    } catch {
      // Oda bilgisi alinamazsa son bilinen/bilinmeyen durum korunur.
    } finally {
      this.viewerFetchInFlight = false;
      this.#scheduleViewerFallback();
    }
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const delay = RECONNECT_DELAYS[Math.min(this.retryIndex, RECONNECT_DELAYS.length - 1)];
    this.retryIndex += 1;
    this.emit('log', this.t('log.retrying', { seconds: Math.round(delay / 1000) }));
    this.timer = setTimeout(() => {
      // #connect() beklenmedik bir hatayla reddedilse bile dongu olmesin:
      // hatayi logla ve bir sonraki denemeyi planla.
      Promise.resolve(this.#connect()).catch((err) => {
        this.emit('log', this.t('log.tiktokError', { message: describeError(err) }));
        this.#scheduleReconnect();
      });
    }, delay);
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      status: this.status,
      username: this.username,
      viewerCount: this.viewerCount,
      roomTitle: readRoomTitle(this.roomInfo),
      connectedMs: this.startedAt ? Date.now() - this.startedAt : 0
    };
  }

  /**
   * Mevcut baglantiyi kapatir. Once dinleyiciler kaldirilir (kapali socket
   * hayalet olay uretmesin: cift "Yayin bitti", tekrar teslim edilen eski
   * yorum paketi), sonra baglanti kesilir.
   *
   * disconnect() BILEREK beklenmez: olu/yarim-acik socket'te kapanma
   * el sikismasi hic cozulmeyebilir. Await edilirse yeniden deneme dongusu
   * kilitlenir ve uygulama yayin acildiginda sessiz kalir.
   */
  #closeConnection() {
    const conn = this.connection;
    this.connection = null;
    if (!conn) return;
    try { conn.removeAllListeners?.(); } catch { /* yoksay */ }
    try {
      Promise.resolve(conn.disconnect?.()).catch(() => {});
    } catch { /* yoksay */ }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.#resetViewerState();
    this.#closeConnection();
    this.#setStatus('kapali');
  }
}

export default TikTokSource;