/**
 * Yorum gecmisi deposu: JSONL (her satir bir yorum kaydi).
 *
 * Tasarim hedefleri:
 *  - Ucuz yazma: append-only, tamponlanmis toplu flush (syscall azaltir)
 *  - Kapanista kayip yok: shutdown'da senkron flush
 *  - RAM etkisi ~sifir: arama dosyayi satir satir akitar (tamami yuklenmez)
 *  - Bozulmaya dayanikli: bir satir bozuksa digerleri okunmaya devam eder
 *
 * Kayit semasi (satir basina):
 *  { id, userId, userName, text, spokenText, status, reason, at }
 *  status: queued | spoken | skipped | dropped
 */
import {
  appendFileSync, createReadStream, createWriteStream, existsSync,
  mkdirSync, renameSync, rmSync, statSync
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BUFFER_MAX = 200;

/** Turkce saygili arama katlamasi: 'sarki' == 'şarkı', 'guzel' == 'güzel', 'I' == 'i'. */
const FOLD_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
function fold(text) {
  return String(text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (ch) => FOLD_MAP[ch] ?? ch);
}

export class CommentStore {
  /** @param {{dir:string, maxEntries?:number, enabled?:boolean}} options */
  constructor({ dir, maxEntries = 100_000, enabled = true }) {
    this.dir = dir;
    this.file = path.join(dir, 'history.jsonl');
    this.maxEntries = Math.max(1, Number(maxEntries) || 100_000);
    this.enabled = enabled !== false;
    this.buffer = [];
    this.timer = null;
  }

  get filePath() { return this.file; }

  /** Ayar degisince acilis/kapanis davranisi. Kapaliyken tampon da bosaltilir. */
  setEnabled(value) {
    this.enabled = Boolean(value);
    if (!this.enabled) this.buffer = [];
  }

  /** Bir yorum kaydi ekler (tamponlanir; flush periyodik veya elle yapilir). */
  append(record) {
    if (!this.enabled) return false;
    const safe = {
      id: String(record?.id ?? ''),
      userId: String(record?.userId ?? ''),
      userName: String(record?.userName ?? ''),
      text: String(record?.text ?? ''),
      spokenText: String(record?.spokenText ?? ''),
      status: String(record?.status ?? 'queued'),
      reason: record?.reason ?? null,
      at: Number(record?.at) || Date.now()
    };
    this.buffer.push(JSON.stringify(safe));
    if (this.buffer.length >= FLUSH_BUFFER_MAX) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
    return true;
  }

  /** Tamponu diske yazar (senkron). Kapanista cagrilir, kayip olmaz. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buffer.length) return 0;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, `${this.buffer.join('\n')}\n`, 'utf8');
    const count = this.buffer.length;
    this.buffer = [];
    return count;
  }

  /**
   * Gecmiste arar: dosyayi satir satir akitar (taminin RAM'e yuklenmez).
   * @returns {Promise<{total:number, entries:object[]}>} en yeni `limit` kayit, yeniden eskiye
   */
  async search(query, { limit = 100 } = {}) {
    this.flush();
    const needle = fold(query).trim();
    if (!needle || !existsSync(this.file)) return { total: 0, entries: [] };
    const capped = Math.max(1, Number(limit) || 100);
    const rl = createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    const matches = [];
    let total = 0;
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // bozuk satir: atla
      const hay = fold(`${rec.userName ?? ''} ${rec.text ?? ''} ${rec.spokenText ?? ''}`);
      if (!hay.includes(needle)) continue;
      total += 1;
      matches.push(rec);
      if (matches.length > capped) matches.shift(); // en yeni `limit` kadar tut
    }
    return { total, entries: matches.reverse() };
  }

  /** Dosya tavani astiysa en yeni maxEntries kaydi tutar. Acilista bir kez cagrilir. */
  async trim() {
    this.flush();
    if (!existsSync(this.file)) return 0;
    let count = 0;
    {
      const rl = createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) { if (line) count += 1; }
    }
    if (count <= this.maxEntries) return 0;
    const skip = count - this.maxEntries;
    const tmp = `${this.file}.tmp`;
    const out = createWriteStream(tmp, { encoding: 'utf8' });
    let index = 0;
    const rl = createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      index += 1;
      if (index <= skip) continue;
      out.write(`${line}\n`);
    }
    out.end();
    await finished(out);
    renameSync(tmp, this.file);
    return skip;
  }

  /** Gecmisi tamamen siler (Settings -> temizle). */
  clear() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.buffer = [];
    let bytes = 0;
    if (existsSync(this.file)) {
      try { bytes = statSync(this.file).size; } catch { /* boyut onemsiz */ }
      rmSync(this.file, { force: true });
    }
    return { ok: true, removedBytes: bytes };
  }
}

export default CommentStore;
