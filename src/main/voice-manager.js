/**
 * Piper ses yönetimi: katalog (Hugging Face), indirme, yerel .onnx yükleme, silme.
 *
 * Depolama iki kökten gelir:
 *   - bundled : kurulumla gelen sesler (salt okunur, silinemez)  -> engine.json "bundled"
 *   - user    : indirilen / yüklenen sesler                        -> <app>/voices
 *               (Program Files gibi salt-okunur kurulumda userData'ya düşer)
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync,
  readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const CATALOG_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json';
const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* saf yardimcilar (test edilebilir)                                    */
/* ------------------------------------------------------------------ */

/** Klasor adi olarak guvenli id uretir (path traversal engeli). */
export function sanitizeId(value) {
  const base = String(value ?? '')
    .replace(/\.onnx(\.json)?$/i, '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96);
  if (!base || base === '.' || base === '..') return null;
  return base;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Piper config icin zorunlu alanlar; gecersizse neden doner. */
export function validatePiperConfig(config) {
  if (!config || typeof config !== 'object') return { ok: false, error: 'config okunamadi' };
  if (typeof config.audio?.sample_rate !== 'number') return { ok: false, error: 'audio.sample_rate yok' };
  if (typeof config.num_symbols !== 'number') return { ok: false, error: 'num_symbols yok (Piper/VITS modeli degil)' };
  const phonemeType = String(config.phoneme_type ?? 'text');
  const hasEspeak = phonemeType === 'espeak' || Boolean(config.espeak?.voice);
  if (!hasEspeak) return { ok: false, error: 'espeak yapilandirmasi yok (espeak tabanli Piper modeli bekleniyor)' };
  const speakers = Object.entries(config.speaker_id_map ?? {}).map(([id, name]) => ({ id: Number(id), name: String(name) }))
    .sort((a, b) => a.id - b.id);
  return {
    ok: true,
    sampleRate: config.audio.sample_rate,
    phonemeType,
    espeakVoice: config.espeak?.voice ?? 'en-us',
    numSpeakers: config.num_speakers ?? speakers.length ?? 1,
    speakers,
    inference: config.inference ?? null
  };
}

/** voices.json -> uygulama icin duz katalog girisi. */
export function normalizeCatalog(raw) {
  const entries = [];
  for (const [id, value] of Object.entries(raw ?? {})) {
    const onnxPath = Object.keys(value?.files ?? {}).find((p) => p.endsWith('.onnx'));
    const configPath = Object.keys(value?.files ?? {}).find((p) => p.endsWith('.onnx.json'));
    if (!onnxPath || !configPath) continue;
    const language = value.language ?? {};
    entries.push({
      id,
      name: value.name ?? id.split('-')[1] ?? id,
      language: {
        code: language.code ?? '',
        family: language.family ?? '',
        region: language.region ?? '',
        native: language.name_native ?? language.code ?? id,
        english: language.name_english ?? language.code ?? id,
        country: language.country_english ?? ''
      },
      quality: value.quality ?? 'medium',
      numSpeakers: value.num_speakers ?? 1,
      speakerNames: Object.values(value.speaker_id_map ?? {}).map(String),
      sizeBytes: value.files[onnxPath].size_bytes ?? null,
      md5: value.files[onnxPath].md5_digest ?? null,
      configSizeBytes: value.files[configPath].size_bytes ?? null,
      onnxUrl: `${HF_BASE}/${onnxPath}`,
      configUrl: `${HF_BASE}/${configPath}`
    });
  }
  entries.sort((a, b) => a.language.english.localeCompare(b.language.english) || a.name.localeCompare(b.name));
  return entries;
}

/** Bir klasordeki Piper sesini bulur (herhangi bir adi olan .onnx + .onnx.json). */
export function findVoiceInDir(dir) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const onnx = files.find((f) => f.toLowerCase().endsWith('.onnx'));
  if (!onnx) return null;
  const base = onnx.slice(0, -'.onnx'.length);
  const config = files.find((f) => ['.onnx.json', '.json'].some((ext) => f.toLowerCase().endsWith(ext)) && f.toLowerCase().startsWith(base.toLowerCase()));
  if (!config) return null;
  return { modelPath: path.join(dir, onnx), configPath: path.join(dir, config), modelFile: onnx, configFile: config };
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  try { walk(dir); } catch { /* yok */ }
  return total;
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** espeak ses kodunu okunur dil adina cevirir (es: 'tr' -> 'Türkçe'). */
const ESPEAK_LANGUAGES = {
  tr: { native: 'Türkçe', english: 'Turkish' },
  'tr-tr': { native: 'Türkçe', english: 'Turkish' },
  de: { native: 'Deutsch', english: 'German' },
  'de-de': { native: 'Deutsch', english: 'German' },
  'en-us': { native: 'English (US)', english: 'English (US)' },
  'en-gb': { native: 'English (UK)', english: 'English (UK)' },
  'en-gb-x-rp': { native: 'English (UK)', english: 'English (UK)' },
  es: { native: 'Español', english: 'Spanish' },
  fr: { native: 'Français', english: 'French' },
  it: { native: 'Italiano', english: 'Italian' },
  nl: { native: 'Nederlands', english: 'Dutch' },
  pt: { native: 'Português', english: 'Portuguese' },
  'pt-br': { native: 'Português (BR)', english: 'Portuguese (BR)' },
  ru: { native: 'Русский', english: 'Russian' },
  pl: { native: 'Polski', english: 'Polish' },
  cs: { native: 'Čeština', english: 'Czech' },
  sv: { native: 'Svenska', english: 'Swedish' },
  da: { native: 'Dansk', english: 'Danish' },
  fi: { native: 'Suomi', english: 'Finnish' },
  nb: { native: 'Norsk bokmål', english: 'Norwegian' },
  el: { native: 'Ελληνικά', english: 'Greek' },
  ar: { native: 'العربية', english: 'Arabic' },
  he: { native: 'עברית', english: 'Hebrew' },
  hi: { native: 'हिन्दी', english: 'Hindi' },
  ja: { native: '日本語', english: 'Japanese' },
  ko: { native: '한국어', english: 'Korean' },
  zh: { native: '中文', english: 'Chinese' },
  uk: { native: 'Українська', english: 'Ukrainian' },
  hu: { native: 'Magyar', english: 'Hungarian' },
  ro: { native: 'Română', english: 'Romanian' },
  vi: { native: 'Tiếng Việt', english: 'Vietnamese' },
  id: { native: 'Indonesia', english: 'Indonesian' },
  ms: { native: 'Melayu', english: 'Malay' },
  bg: { native: 'Български', english: 'Bulgarian' },
  hr: { native: 'Hrvatski', english: 'Croatian' },
  sr: { native: 'Српски', english: 'Serbian' },
  sk: { native: 'Slovenčina', english: 'Slovak' },
  sl: { native: 'Slovenščina', english: 'Slovenian' },
  lt: { native: 'Lietuvių', english: 'Lithuanian' },
  lv: { native: 'Latviešu', english: 'Latvian' },
  et: { native: 'Eesti', english: 'Estonian' },
  ca: { native: 'Català', english: 'Catalan' },
  eu: { native: 'Euskara', english: 'Basque' },
  hy: { native: 'Հայերեն', english: 'Armenian' },
  ka: { native: 'ქართული', english: 'Georgian' },
  kk: { native: 'Қазақша', english: 'Kazakh' },
  ku: { native: 'Kurdî', english: 'Kurdish' },
  sw: { native: 'Kiswahili', english: 'Swahili' },
  te: { native: 'తెలుగు', english: 'Telugu' },
  ml: { native: 'മലയാളം', english: 'Malayalam' },
  mr: { native: 'मराठी', english: 'Marathi' },
  ne: { native: 'नेपाली', english: 'Nepali' },
  th: { native: 'ไทย', english: 'Thai' },
  ur: { native: 'اردو', english: 'Urdu' }
};

function espeakLanguage(code) {
  const key = String(code ?? '').toLowerCase();
  return ESPEAK_LANGUAGES[key] ?? { native: `espeak: ${code}`, english: `espeak: ${code}` };
}

export class VoiceManager extends EventEmitter {
  /**
   * @param {{bundledDirs:string[], userRoot:string, fallbackRoot?:string, readOnlyRoots?:string[], cacheDir:string}} options
   */
  constructor(options) {
    super();
    this.bundledDirs = options.bundledDirs ?? [];
    this.userRoot = options.userRoot;
    this.fallbackRoot = options.fallbackRoot ?? null;
    // Sadece okunacak kokler (eski surumlerde indirilmis seslerin olabildigi
    // kurulum klasoru): yazma hedefi OLMAZ ama listeleme ve silme kapsamindadir.
    this.readOnlyRoots = (options.readOnlyRoots ?? []).filter(Boolean);
    this.cacheDir = options.cacheDir;
    this.cacheFile = path.join(this.cacheDir, 'voices-catalog.json');
    this.catalog = null;
    this.activeUserRoot = null; // gercek yazma kokune karar verilir
    this.aborts = new Map();
  }

  /** Yazilabilir kullani kokunu belirler (salt-okunur kurulumda userData'ya duser). */
  resolveUserRoot() {
    if (this.activeUserRoot) return this.activeUserRoot;
    for (const candidate of [this.userRoot, this.fallbackRoot].filter(Boolean)) {
      try {
        mkdirSync(candidate, { recursive: true });
        const probe = path.join(candidate, '.write-test');
        writeFileSync(probe, 'ok');
        rmSync(probe, { force: true });
        this.activeUserRoot = candidate;
        if (candidate !== this.userRoot) {
          this.emit('notice', `Uygulama klasörüne yazılamadı, sesler şuraya kaydediliyor: ${candidate}`);
        }
        return candidate;
      } catch { /* sonraki dene */ }
    }
    throw new Error('Sesler için yazılabilir bir klasör bulunamadı');
  }

  /**
   * Kullani seslerinin aranacagi kokler: cozumlenmis yazma koku + bilinen
   * kokler + salt-okunur kokler (eski kurulum konumu). Yazma hedefi
   * resolveUserRoot() ile sabitlenir; readOnlyRoots yalnizca okuma/silme icindir.
   */
  #userRoots() {
    const roots = [];
    try {
      roots.push(this.resolveUserRoot());
    } catch { /* yazilabilir kok yok */ }
    for (const candidate of [this.userRoot, this.fallbackRoot, ...this.readOnlyRoots]) {
      if (candidate && !roots.includes(candidate)) roots.push(candidate);
    }
    return roots;
  }

  /** Kurulu tüm sesler (paketle gelenler + kullanıcının). */
  getInstalled() {
    const out = [];
    for (const dir of this.bundledDirs) {
      const entry = this.#readVoice(dir, 'bundled');
      if (entry) out.push(entry);
    }
    const seenIds = new Set();
    for (const root of this.#userRoots()) {
      let names;
      try {
        if (!existsSync(root)) continue;
        names = readdirSync(root);
      } catch { continue; }
      for (const name of names) {
        const full = path.join(root, name);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch { continue; }
        if (this.bundledDirs.includes(full)) continue;
        const entry = this.#readVoice(full, 'user');
        if (!entry || seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        out.push(entry);
      }
    }
    return out;
  }

  #readVoice(dir, origin) {
    const found = findVoiceInDir(dir);
    if (!found) return null;
    let config = null;
    try { config = JSON.parse(readFileSync(found.configPath, 'utf8')); } catch { /* okunamadi */ }
    const info = config ? validatePiperConfig(config) : { ok: false, error: 'config okunamadi' };
    let meta = null;
    const metaFile = path.join(dir, 'voice.json');
    if (existsSync(metaFile)) {
      try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* yoksay */ }
    }
    return {
      id: meta?.id ?? path.basename(dir),
      dir,
      modelPath: found.modelPath,
      configPath: found.configPath,
      origin, // 'bundled' | 'user'
      valid: info.ok,
      error: info.ok ? null : info.error,
      label: meta?.label ?? null,
      language: meta?.language ?? null,
      quality: meta?.quality ?? null,
      sizeBytes: dirSize(dir),
      sampleRate: info.ok ? info.sampleRate : null,
      espeakVoice: info.ok ? info.espeakVoice : null,
      numSpeakers: info.ok ? info.numSpeakers : null,
      speakers: info.ok ? info.speakers : [],
      catalogId: meta?.catalogId ?? null
    };
  }

  resolve(id) {
    const voice = this.getInstalled().find((v) => v.id === id);
    if (!voice) throw new Error(`Ses bulunamadı: ${id}`);
    if (!voice.valid) throw new Error(`Ses geçersiz: ${voice.error}`);
    return voice;
  }

  /* ---------------- katalog ---------------- */

  async getCatalog({ refresh = false } = {}) {
    if (!refresh && this.catalog) return this.catalog;
    if (!refresh) {
      try {
        const cached = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
        if (Date.now() - cached.updatedAt < CATALOG_TTL_MS && Array.isArray(cached.entries)) {
          this.catalog = cached;
          return cached;
        }
      } catch { /* yeniden indir */ }
    }
    const res = await fetch(CATALOG_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Katalog indirilemedi (HTTP ${res.status})`);
    const raw = await res.json();
    const entries = normalizeCatalog(raw);
    this.catalog = { updatedAt: Date.now(), count: entries.length, entries };
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.catalog), 'utf8');
    } catch { /* onbellek yazilamadi */ }
    return this.catalog;
  }

  catalogEntry(id) {
    const entry = this.catalog?.entries?.find((e) => e.id === id);
    if (!entry) throw new Error(`Katalogda yok: ${id}`);
    return entry;
  }

  /* ---------------- indirme ---------------- */

  async install(id, { onProgress } = {}) {
    if (this.aborts.has(id)) throw new Error('Bu ses zaten indiriliyor');
    const entry = this.catalogEntry(id);
    const root = this.resolveUserRoot();
    const dir = path.join(root, sanitizeId(entry.id));
    mkdirSync(dir, { recursive: true });

    const controller = new AbortController();
    this.aborts.set(id, controller);
    const emit = (payload) => {
      this.emit('progress', { id, ...payload });
      onProgress?.({ id, ...payload });
    };

    try {
      emit({ phase: 'start', received: 0, total: entry.sizeBytes ?? 0, percent: 0 });
      const modelName = `${sanitizeId(entry.id)}.onnx`;
      const configName = `${sanitizeId(entry.id)}.onnx.json`;
      await this.#download(`${entry.onnxUrl}?download=true`, path.join(dir, modelName), entry.sizeBytes, entry.md5, controller, (received, total) => {
        emit({ phase: 'model', received, total, percent: total ? (received / total) * 100 : 0 });
      });
      emit({ phase: 'model-done', percent: 100 });
      await this.#download(`${entry.configUrl}?download=true`, path.join(dir, configName), entry.configSizeBytes ?? null, null, controller, (received, total) => {
        emit({ phase: 'config', received, total, percent: total ? (received / total) * 100 : 0 });
      });

      const voice = this.#readVoice(dir, 'user');
      if (!voice || !voice.valid) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`İndirilen model geçersiz: ${voice?.error ?? 'bilinmiyor'}`);
      }

      writeFileSync(path.join(dir, 'voice.json'), `${JSON.stringify({
        id: voice.id,
        catalogId: entry.id,
        label: `${entry.language.native} · ${entry.name}`,
        language: entry.language,
        quality: entry.quality,
        source: 'huggingface',
        installedAt: new Date().toISOString()
      }, null, 2)}\n`, 'utf8');
      emit({ phase: 'done', percent: 100 });
      return this.#readVoice(dir, 'user');
    } catch (err) {
      if (err?.name === 'AbortError') {
        rmSync(dir, { recursive: true, force: true });
        emit({ phase: 'cancelled' });
        throw err;
      }
      throw err;
    } finally {
      this.aborts.delete(id);
    }
  }

  cancel(id) {
    const controller = this.aborts.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async #download(url, dest, expectedBytes, md5, controller, onTick) {
    const tmp = `${dest}.part`;
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} — ${path.basename(dest)}`);
    const total = Number(res.headers.get('content-length')) || expectedBytes || 0;
    let received = 0;
    let lastTick = Date.now();
    let lastBytes = 0;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 200) {
        const bps = ((received - lastBytes) * 1000) / (now - lastTick);
        onTick?.(received, total, bps);
        lastTick = now;
        lastBytes = received;
      }
    });
    await pipeline(source, createWriteStream(tmp));
    onTick?.(received, total, 0);
    const size = statSync(tmp).size;
    if (expectedBytes && Math.abs(size - expectedBytes) > 1024) {
      rmSync(tmp, { force: true });
      throw new Error(`Boyut uyuşmadı (beklenen ${expectedBytes}, gelen ${size})`);
    }
    if (md5) {
      const hash = await md5File(tmp);
      if (hash.toLowerCase() !== md5.toLowerCase()) {
        rmSync(tmp, { force: true });
        throw new Error('md5 doğrulaması başarısız (dosya bozuk olabilir)');
      }
    }
    renameSync(tmp, dest);
  }

  /* ---------------- yerel dosya yükleme ---------------- */

  /**
   * Yerel .onnx + .onnx.json çiftini kopyalar.
   * @param {string} modelPath
   * @param {string|null} configPath
   */
  importLocal(modelPath, configPath = null) {
    if (!existsSync(modelPath)) throw new Error('Dosya bulunamadı');
    if (!modelPath.toLowerCase().endsWith('.onnx')) throw new Error('Sadece .onnx dosyası seçilebilir');

    const base = path.basename(modelPath).replace(/\.onnx$/i, '');
    let config = configPath;
    if (!config) {
      const dir = path.dirname(modelPath);
      const guess = ['.onnx.json', '.json']
        .map((ext) => path.join(dir, `${base}${ext}`))
        .find((p) => existsSync(p));
      config = guess ?? null;
    }
    if (!config || !existsSync(config)) {
      throw new Error('Piper modeli iki dosyadır: .onnx ve .onnx.json. Config dosyasını da seçmelisiniz.');
    }

    let parsed = null;
    try { parsed = JSON.parse(readFileSync(config, 'utf8')); } catch { throw new Error('Config dosyası okunamadı (geçerli JSON değil)'); }
    const info = validatePiperConfig(parsed);
    if (!info.ok) throw new Error(`Geçersiz Piper modeli: ${info.error}`);

    const id = sanitizeId(base);
    if (!id) throw new Error('Dosya adı geçersiz');
    const root = this.resolveUserRoot();
    let dir = path.join(root, id);
    let index = 2;
    while (existsSync(dir)) dir = path.join(root, `${id}-${index++}`);
    mkdirSync(dir, { recursive: true });

    copyFileSync(modelPath, path.join(dir, `${path.basename(dir)}.onnx`));
    copyFileSync(config, path.join(dir, `${path.basename(dir)}.onnx.json`));

    const voice = this.#readVoice(dir, 'user');
    const lang = espeakLanguage(info.espeakVoice);
    writeFileSync(path.join(dir, 'voice.json'), `${JSON.stringify({
      id: voice.id,
      label: `${lang.native} · ${base}`,
      language: { code: info.espeakVoice, family: null, native: lang.native, english: lang.english },
      quality: parsed.audio?.quality ?? 'bilinmiyor',
      source: 'local',
      installedAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    return this.#readVoice(dir, 'user');
  }

  /** Kullanıcı sesini siler (paketle gelenler silinmez). */
  remove(id) {
    const voice = this.getInstalled().find((v) => v.id === id);
    if (!voice) return { ok: false, error: 'Ses bulunamadı' };
    if (voice.origin === 'bundled') return { ok: false, error: 'Paketle gelen ses silinemez' };
    const roots = [this.activeUserRoot, this.userRoot, this.fallbackRoot, ...this.readOnlyRoots]
      .filter(Boolean).map((r) => path.resolve(r));
    if (!roots.includes(path.resolve(path.dirname(voice.dir)))) return { ok: false, error: 'Güvenlik: beklenmeyen klasör' };
    rmSync(voice.dir, { recursive: true, force: true });
    return { ok: true };
  }
}

export default VoiceManager;