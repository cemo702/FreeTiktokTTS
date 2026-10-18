/**
 * Konusma kuyrugu.
 *
 * - oncelik: yuksek puanli ogeler basa
 * - ayni kullanici ardisik okunmaz (katli kuyruk olusumunu onler)
 * - saniyede en fazla N yorum (yogun yayinda kuyruk sismesin)
 * - kuyruk tavani: dolunca en dusuk oncelikli/en eski ogeler dusurulur
 *
 * Saf JS, test edilebilir (zaman fonksiyonu disaridan verilir).
 */

export class SpeechQueue {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 40;
    this.maxPerMinute = options.maxPerMinute ?? 12;
    this.queueAll = options.queueAll ?? false;
    this.minGapMs = options.minGapMs ?? 250;
    this.sameUserPenalty = options.sameUserPenalty ?? 5000; // ayni kullaniciya yakin ogeleri geriye at
    this.items = [];
    this.nextId = 1;
    this.timestamps = []; // kabul edilen konusma zamanlari (hiz limiti icin)
    this.spoken = []; // son okunan ogeler (ayni kullanici arka arkaya okunmasin)
    this.dropped = 0;
  }

  get length() {
    return this.items.length;
  }

  /** Kuyruğa ekler; kapasite dolduysa dusurur. */
  push(item) {
    const entry = {
      id: this.nextId++,
      text: item.text,
      lang: item.lang ?? 'tr',
      userId: item.userId ?? '',
      userName: item.userName ?? '',
      priority: item.priority ?? 0,
      beep: item.beep ?? false,
      enqueuedAt: item.enqueuedAt ?? Date.now(),
      meta: item.meta ?? null
    };
    this.items.push(entry);
    if (this.items.length > this.maxSize) this.trim();
    return entry;
  }

  /**
   * Kapasite asiminda en dusuk oncelikli ogeleri atar; esit oncelikte EN YENI
   * duser (en eski bekleyen korunur, sira bozulmaz).
   */
  trim() {
    while (this.items.length > this.maxSize) {
      let worstIndex = 0;
      for (let i = 1; i < this.items.length; i += 1) {
        const a = this.items[i];
        const b = this.items[worstIndex];
        if (a.priority < b.priority
          || (a.priority === b.priority && (a.enqueuedAt > b.enqueuedAt
            || (a.enqueuedAt === b.enqueuedAt && a.id > b.id)))) {
          worstIndex = i;
        }
      }
      this.items.splice(worstIndex, 1);
      this.dropped += 1;
    }
  }

  /** Siradaki ogeyi secer (ondelikli: oncelik, ayni kullanici cezasi, sirayla). */
  peek(now = Date.now()) {
    if (!this.items.length) return null;
    if (this.canSpeakAt(now) > now) return null;

    // Kuyrukta ayni kullanicidan birden fazla mesaj varsa ceza uygula
    // (biri kullaniciyi monopolize edip donmesin).
    const counts = new Map();
    for (const item of this.items) {
      if (!item.userId) continue;
      counts.set(item.userId, (counts.get(item.userId) ?? 0) + 1);
    }
    const spokenUsers = this.spokenUsers();

    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i];
      let score = item.priority * 1_000_000;
      score -= i * 100; // eskiye oncelik (sira korunur)
      const count = counts.get(item.userId) ?? 0;
      if (count > 1) score -= this.sameUserPenalty * (count - 1);
      if (spokenUsers.has(item.userId)) score -= this.sameUserPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return this.items[bestIndex];
  }

  /** Siradaki ogeyi cikarip isaretler (konusuldu). */
  take(now = Date.now()) {
    const item = this.peek(now);
    if (!item) return null;
    this.items.splice(this.items.indexOf(item), 1);
    this.timestamps.push(now);
    this.spoken.push({ userId: item.userId, at: now });
    if (this.spoken.length > 20) this.spoken.shift();
    this.pruneTimestamps(now);
    return item;
  }

  /**
   * Konusmanin gercek bitis zamanini bildirir.
   * Boylece "yorumlar arasi bosluk" bir yorumun BASINDAN degil, BITISINDEN
   * itibaren sayilir (uzun yorumlar arkasindan hemen yeni yorum okunmaz).
   */
  noteEnd(at) {
    if (!this.timestamps.length) return;
    const last = this.timestamps[this.timestamps.length - 1];
    this.timestamps[this.timestamps.length - 1] = Math.max(last, at);
  }

  remove(id) {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  /**
   * Bir ogeyi hemen okunacak sekilde one alir:
   * en basa tasinir ve hiz limiti sifirlanir (kullanici "simdi oku" dedi).
   */
  promote(id) {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return false;
    const [item] = this.items.splice(index, 1);
    item.priority = Math.max(item.priority, 1_000);
    item.enqueuedAt = Date.now();
    this.items.unshift(item);
    this.timestamps = [];
    return true;
  }

  clear() {
    const removed = this.items.length;
    this.items = [];
    return removed;
  }

  /** Son okunan kullanicilar (ayni kullaniciyi arka arkaya okumamak icin). */
  spokenUsers(limit = 4) {
    const users = [];
    for (let i = this.spoken.length - 1; i >= 0 && users.length < limit; i -= 1) {
      const id = this.spoken[i].userId;
      if (id && !users.includes(id)) users.push(id);
    }
    return new Set(users);
  }

  pruneTimestamps(now) {
    const windowStart = now - 60_000;
    while (this.timestamps.length && this.timestamps[0] < windowStart) this.timestamps.shift();
  }

  /** Hiz limiti + konusma araligi nedeniyle siradaki konusmanin en erken zamani. */
  canSpeakAt(now = Date.now()) {
    this.pruneTimestamps(now);
    // queueAll: dakikada-limit kapali, tempo yalnizca minGapMs ile tutulur.
    if (!this.queueAll && this.timestamps.length >= this.maxPerMinute) {
      return this.timestamps[this.timestamps.length - this.maxPerMinute] + 60_000;
    }
    const last = this.timestamps[this.timestamps.length - 1];
    return last ? Math.max(last + this.minGapMs, now) : now;
  }

  /** Kuyrukta bekleyen en eski ogenin yasi (ms). */
  oldestAge(now = Date.now()) {
    if (!this.items.length) return 0;
    return now - Math.min(...this.items.map((i) => i.enqueuedAt));
  }

  list() {
    return this.items.map(({ id, userId, userName, text, lang, priority, enqueuedAt }) => ({ id, userId, userName, text, lang, priority, enqueuedAt }));
  }
}

export default SpeechQueue;
