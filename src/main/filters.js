/**
 * Yorum metni normalizasyonu + Turkce duyarli kufur / spam filtreleri.
 *
 * Saf fonksiyonlar: Electron main surecinde ve Node testlerinde kullanilir.
 */
import { ENGLISH_WORDS } from './english-words.js';

/** Turkce karakter katlamasi: "SİK" -> "sik" gibi eslesmeleri yakalar. */
const FOLD_MAP = new Map(Object.entries({
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o',
  ş: 's', Ş: 's', ü: 'u', Ü: 'u', â: 'a', Â: 'a', î: 'i', Î: 'i', û: 'u', Û: 'u', é: 'e', É: 'e'
}));

/** Leet/ayrac donusumleri: kamufle yazimlari yakalamak icin. */
const LEET_MAP = new Map(Object.entries({
  '@': 'a', '4': 'a', '8': 'b', '(': 'c', '{': 'c', '[': 'c', '3': 'e', '6': 'g', '9': 'g',
  '#': 'h', '!': 'i', '|': 'i', '1': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '2': 'z'
}));

const URL_RE = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|co|link|shop|xyz|app|gg)\b\S*/gi;
const MENTION_RE = /@(\S+)/g;
const HASHTAG_RE = /#\S+/g;
/** Kose li parantez icerigi: "[rosiecute]", "[ ]" gibi. Ic ice destekler. */
const BRACKET_RE = /\[[^\][]*\]/g;
/** Kapanmamis parantezden kalan tekil isaretler (okunmamali). */
const STRAY_BRACKET_RE = /[\[\]]/g;
const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\u20e3\ufe0f])/gu;
const LETTER_RE = /[\p{L}\p{N}]/u;
const TURKISH_RE = /[çğıöşüÇĞİÖŞÜ]/i;

/**
 * Varsayilan kufur listesi. Bilerek temkinli: yanlis pozitiv (gunduz "iyi" gibi
 * kelimeler) masksiz, en az 5 harfli kelimelerde ek/sonek toleransi vardir.
 */
export const DEFAULT_PROFANITY_WORDS = [
  'amınakoyarım', 'amınakoyduk', 'amınakoymuş', 'amına koyarım', 'amına koydu',
  'amcık', 'amcık', 'amını', 'amına', 'anneni', 'babanı',
  'cerbeze', 'domur', 'gavur', 'kancık', 'kavat', 'manyak',
  'orospu', 'piç', 'puert', 'salak', 'sik', 'siken', 'sikim',
  'siktir', 'skiter', 'söbe', 'taşak', 'velet', 'yavşak', 'zıkkırık', 'zıkkı', 'zibidi',
  'asshole', 'bastard', 'bitch', 'bullshit', 'cunt', 'dick', 'dumbass',
  'fuck', 'motherfucker', 'nigger', 'nigga', 'pussy', 'retard', 'slut', 'wanker', 'whore'
];

const MAX_PHRASE_TOKENS = 3;

/**
 * Kose li parantez icerigini kaldirir: "[rosiecute] yazdi" -> "yazdi".
 * Kapanmamis tekil "[" ve "]" isaretleri de okunmamasi icin silinir.
 */
export function stripBrackets(text) {
  return String(text ?? '').replace(BRACKET_RE, ' ').replace(STRAY_BRACKET_RE, ' ');
}

/**
 * @ etiketlerini konusmaya cevirir.
 *   read  : "@Ahmet" -> "Ahmet"    (varsayilan; kullanici adi okunur)
 *   at    : "@Ahmet" -> "at Ahmet"
 *   strip : "@Ahmet" -> ""         (okunmaz, eski davranis)
 *   ignore: "@Ahmet" -> "@Ahmet"   (oldugu gibi birakilir)
 */
export function applyMentions(text, mode = 'read') {
  const src = String(text ?? '');
  if (mode === 'ignore') return src;
  if (mode === 'strip') return src.replace(MENTION_RE, ' ');
  const prefix = mode === 'at' ? 'at ' : '';
  return src.replace(MENTION_RE, (_m, name) => ` ${prefix}${name}`);
}

/** Konusma icin genisletilen bagimsiz kisaltmalar. */
export const DEFAULT_ABBREVIATIONS = {
  sa: 'selam aleyküm',
  slm: 'selam',
  gg: 'good game',
  nbr: 'naber',
  mrb: 'merhaba',
  tmm: 'tamam',
  as: 'aleyküm selam',
  eyv: 'eyvallah'
};
const ABBREVIATION_RE = /(?<![@\p{L}\p{N}_])(sa|slm|gg|nbr|mrb|tmm|as|eyv)(?![\p{L}\p{N}_])/giu;

/**
 * Bagimsiz kisaltmalari konusma metnine cevirir.
 * Mention, baglanti ve kelime ici kullanimlara dokunmaz.
 */
export function expandAbbreviations(text) {
  return String(text ?? '').replace(ABBREVIATION_RE, (match) => (
    DEFAULT_ABBREVIATIONS[match.toLowerCase()] ?? match
  ));
}

/** Kısaltmanın genişletilmiş metninin dili (motor seçimi için). */
const ABBREVIATION_LANG = {
  sa: 'tr', slm: 'tr', gg: 'en', nbr: 'tr',
  mrb: 'tr', tmm: 'tr', as: 'tr', eyv: 'tr'
};

/**
 * Ilk-kelime listesi: Turkceyle cakismayan, tek basina kesin Ingilizce sinyali.
 * NOT: game/stream/live/play bilerek YOK ("live yayın", "game'e gir" Turkce).
 */
const EN_FIRST_WORDS = new Set([
  'i', 'hello', 'hi', 'hey', 'guys', 'welcome', 'good', 'great', 'awesome',
  'morning', 'evening', 'night', 'thanks', 'thank', 'you', 'please', 'love',
  'nice', 'beautiful', 'amazing', 'lets', "let's", 'win', 'lose', 'winner',
  'happy', 'birthday', 'congratulations', 'sorry', 'yes', 'no', 'what', 'how',
  'are', 'the', 'my', 'your', 'we', 'they', 'this', 'that', 'very', 'so',
  'much', 'like', 'use', 'go', 'get', 'see', 'victory', 'lord', 'done'
]);

/** İlk kelime Türkçe ise emin olmak için ayırt edici kelimeler (varsayılan zaten tr). */
const TR_FIRST_WORDS = new Set([
  'merhaba', 'selam', 'abi', 'abla', 'kanka', 'kardeşim', 'kardeş', 'arkadaşlar',
  'günaydın', 'iyi', 'yayın', 'yayınlar', 'kolay', 'gelsin', 'hayırlı', 'usta',
  'teşekkür', 'teşekkürler', 'sağol', 'sağ', 'eyvallah', 'tamam', 'naber',
  'nasılsın', 'hoş', 'geldin', 'geldiniz', 'canlı', 'çok', 'güzel'
]);

/**
 * Cumle ici sayim kumesi: gunluk Ingilizce (~4200 kelime, english-words.js).
 * Turkce cakisanlar ve ciplak-kullanilan odunc kelimeler bilerek YOK;
 * bolum detaylari ve kilit test: test/filters.test.js (TR_COLLISIONS).
 */
const EN_COUNT_WORDS = new Set(ENGLISH_WORDS);

/** Bu sayiya ulasilirsa cumle Ingilizce sayilir (diger kurallardan once). */
const EN_COUNT_THRESHOLD = 2;

/**
 * Token'dan sayim/ilk-kelime adaylari: kenar ayikla + apostrof sonrasi kuyruk.
 * ("M'Lord" -> ["m'lord", "lord"], "n'aber" -> ["n'aber", "aber"] guvenli.)
 */
function tokenVariants(token) {
  const word = String(token).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
  if (!word) return [];
  const out = [word];
  const apos = word.lastIndexOf("'");
  if (apos > 0 && apos < word.length - 1) {
    const tail = word.slice(apos + 1);
    if (tail.length >= 2 && !out.includes(tail)) out.push(tail);
  }
  return out;
}

/** Temizlenmis metindeki Ingilizce kelime sayisi (kısaltmalar dilline gore). */
function countEnglishWords(out) {
  let count = 0;
  for (const token of String(out ?? '').split(/\s+/)) {
    if (!token || token.startsWith('@')) continue;
    for (const word of tokenVariants(token)) {
      if (!/[\p{L}]/u.test(word)) continue;
      if (word in ABBREVIATION_LANG) {
        if (ABBREVIATION_LANG[word] === 'en') count += 1;
        break;
      }
      if (EN_COUNT_WORDS.has(word)) { count += 1; break; }
    }
    if (count >= EN_COUNT_THRESHOLD) break;
  }
  return count;
}

/**
 * Yorumun hangi motorla okunacağına karar verir. ONCELIK SIRASI:
 *   1. Cumlede 2+ Ingilizce kelime varsa Ingilizce.
 *   2. Ilk icerik kelimesi (bastaki @etiketler adres sayilir, atlanir).
 *   3. Bilinmeyen kelime/ozel isim varsayilani Turkce.
 * @returns {'tr'|'en'}
 */
export function detectCommentLanguage(text, opts = {}) {
  const {
    stripLinks = true, stripHashtags = true, stripEmoji = true,
    stripBrackets: stripBracketsOpt = true
  } = opts;
  let out = String(text ?? '');
  if (stripLinks) out = out.replace(URL_RE, ' ');
  if (stripBracketsOpt) out = stripBrackets(out);
  if (stripHashtags) out = out.replace(HASHTAG_RE, ' ');
  if (stripEmoji) out = out.replace(EMOJI_RE, '');
  if (countEnglishWords(out) >= EN_COUNT_THRESHOLD) return 'en';
  for (const token of out.split(/\s+/)) {
    if (!token || token.startsWith('@')) continue;
    const variants = tokenVariants(token).filter((w) => /[\p{L}]/u.test(w));
    if (!variants.length) continue;
    if (variants[0] in ABBREVIATION_LANG) return ABBREVIATION_LANG[variants[0]];
    if (TURKISH_RE.test(token)) return 'tr';
    for (const word of variants) {
      if (EN_FIRST_WORDS.has(word)) return 'en';
      if (TR_FIRST_WORDS.has(word)) return 'tr';
    }
    return 'tr';
  }
  return 'tr';
}

/** Konusma metni: baglanti, mention, hashtag, emoji temizligi. */
export function toSpeakable(text, opts = {}) {
  const {
    stripLinks = true, mentionMode = 'read', stripHashtags = true, stripEmoji = true,
    stripBrackets: stripBracketsOpt = true, expandAbbreviations: expandAbbreviationsOpt = true
  } = opts;
  let out = String(text ?? '');
  if (stripLinks) out = out.replace(URL_RE, ' ');
  if (stripBracketsOpt) out = stripBrackets(out);
  if (stripHashtags) out = out.replace(HASHTAG_RE, ' ');
  if (stripEmoji) out = out.replace(EMOJI_RE, '');
  if (expandAbbreviationsOpt) out = expandAbbreviations(out);
  out = applyMentions(out, mentionMode);
  return out.replace(/\s+/g, ' ').trim();
}

/** Esleme icin normalize: kucuk harf + Turkce katlama + leet + ayrac silme. */
export function normalizeToken(token) {
  let out = String(token ?? '').toLowerCase();
  out = [...out].map((ch) => FOLD_MAP.get(ch) ?? ch).join('');
  out = [...out].map((ch) => LEET_MAP.get(ch) ?? ch).join('');
  return out.replace(/[^a-z0-9]/g, '');
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const SEPARATOR_CHAR_RE = /[\s\p{P}\p{S}]/u;

/**
 * Metni "kelimelere" boler; ayraçlar icinde tutulur (kamuflase yazim icin),
 * bosluklar ise kelime siniri sayilir. Her kelime icin orijinal konum doner.
 */
export function analyzeWords(text) {
  const str = String(text ?? '');
  const words = [];
  let chars = [];
  let positions = [];

  const flush = () => {
    if (!chars.length) return;
    words.push({
      raw: str.slice(positions[0], positions[positions.length - 1] + 1),
      norm: normalizeToken(chars.join('')),
      start: positions[0],
      end: positions[positions.length - 1] + 1
    });
    chars = [];
    positions = [];
  };

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flush();
      continue;
    }
    if (WORD_CHAR_RE.test(ch) || LEET_MAP.has(ch) || SEPARATOR_CHAR_RE.test(ch)) {
      chars.push(ch);
      positions.push(i);
      continue;
    }
    flush(); // emoji vb. kelimeyi keser
  }
  flush();
  return words;
}

/** Uyumluluk: yalnizca normalize kelimeleri dondurur. */
export function tokenize(text) {
  return analyzeWords(text).map((w) => ({ raw: w.raw, start: w.start, end: w.end, norm: w.norm }));
}

/** Kufur listesini tekil/phrase girdilerine boler. */
function buildWordIndex(words) {
  const single = new Set();
  const phrases = [];
  for (const raw of words) {
    const w = String(raw ?? '').trim();
    if (!w) continue;
    const parts = w.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      const norm = normalizeToken(parts[0]);
      if (norm) single.add(norm);
    } else if (parts.length <= MAX_PHRASE_TOKENS) {
      const norms = parts.map(normalizeToken).filter(Boolean);
      if (norms.length === parts.length) phrases.push({ norms, len: norms.length });
    }
  }
  return { single, phrases };
}

/**
 * Kufur denetimi.
 * @returns {{hit:boolean, matched:string[], spans:Array<[number,number]>, action:string|null}}
 */
export function detectProfanity(text, settings = {}) {
  const words = settings.profanityWords?.length ? settings.profanityWords : DEFAULT_PROFANITY_WORDS;
  const { single, phrases } = buildWordIndex(words);
  const tokens = analyzeWords(text);
  const matched = [];
  const spans = [];
  const seen = new Set();

  const add = (start, end, label) => {
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push([start, end]);
    matched.push(label);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.norm) continue;

    // phrase (2-3 kelime)
    let phraseHit = false;
    for (const phrase of phrases) {
      if (i + phrase.len > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < phrase.len; k += 1) {
        if (tokens[i + k].norm !== phrase.norms[k]) { ok = false; break; }
      }
      if (ok) {
        add(tokens[i].start, tokens[i + phrase.len - 1].end, String(text).slice(tokens[i].start, tokens[i + phrase.len - 1].end));
        i += phrase.len - 1;
        phraseHit = true;
        break;
      }
    }
    if (phraseHit) continue;

    // tam eslesme
    if (single.has(t.norm)) {
      add(t.start, t.end, t.raw);
      continue;
    }
    // ek/sonek toleransi: yalnizca 5+ harfli kelimelerde ("sikler", "orospular")
    if (t.norm.length >= 5) {
      for (const w of single) {
        if (w.length >= 5 && t.norm.startsWith(w)) {
          add(t.start, t.end, t.raw);
          break;
        }
      }
    }
  }

  for (const rule of settings.regexRules || []) {
    if (!rule) continue;
    try {
      const re = new RegExp(rule, 'i');
      const m = re.exec(String(text));
      if (m && m[0]) add(m.index, m.index + m[0].length, m[0]);
    } catch {
      /* gecersiz regex yok sayilir */
    }
  }

  const hit = matched.length > 0;
  return { hit, matched, spans: spans.sort((a, b) => a[0] - b[0]), action: hit ? (settings.profanityAction || 'mask') : null };
}

/**
 * Kufur eylemini uygular.
 *  mask  : kelime silinir (dogal bosluk kalir)
 *  stars : "***" ile degistirilir
 *  beep  : metin aynen okunur, ciktiya beep karistirilir
 *  skip  : yorum okunmaz
 */
export function applyProfanity(text, detection, settings = {}) {
  if (!detection?.hit) return { text, beep: false, masked: false };
  const action = settings.profanityAction || 'mask';
  if (action === 'skip') return { text: '', beep: false, masked: false, skipped: true };
  if (action === 'beep') return { text, beep: true, masked: false };

  const replacement = action === 'stars' ? (settings.maskToken || '***') : '';
  const str = String(text);
  let out = '';
  let cursor = 0;
  for (const [start, end] of detection.spans) {
    if (start < cursor) continue;
    out += str.slice(cursor, start) + replacement;
    cursor = end;
  }
  out += str.slice(cursor);
  return { text: out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim(), beep: false, masked: true };
}

/** Kisa / anlamsiz yorumlari ele; gecersizse neden doner. */
export function isTrivial(text, settings = {}) {
  const t = String(text ?? '').trim();
  if (!t) return 'bos';
  if (!LETTER_RE.test(t)) return 'sadece-emoji';
  if (t.length < (settings.minLength ?? 2)) return 'cok-kisa';
  if (settings.maxLength && t.length > settings.maxLength) return 'cok-uzun';
  const letters = t.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < (settings.minLetters ?? 1)) return 'cok-kisa';
  if (settings.onlyTurkish && !TURKISH_RE.test(t)) return 'turkce-degil';
  return null;
}

/**
 * Tam yorum denetimi.
 * @param {{text:string, userId:string, at?:number}} comment
 * @param {object} settings
 * @param {{lastText?:Map, cooldown?:Map}} state
 */
export function evaluateComment(comment, settings = {}, state = {}) {
  const raw = String(comment?.text ?? '');
  const user = String(comment?.userId ?? '').toLowerCase();
  const now = comment?.at ?? Date.now();
  const lastText = state.lastText ?? (state.lastText = new Map());
  const cooldown = state.cooldown ?? (state.cooldown = new Map());

  const deny = (reason, profanity = null) => ({ speak: false, reason, spokenText: '', beep: false, profanity });

  const blocked = (settings.blockedUsers || []).map((u) => String(u).toLowerCase());
  if (user && blocked.includes(user)) return deny('engelli-kullanici');

  const allowed = (settings.allowedUsers || []).map((u) => String(u).toLowerCase());
  if (settings.whitelistOnly && allowed.length && user && !allowed.includes(user)) return deny('beyaz-liste-disi');

  if (settings.ignoreOwn && settings.ownUserId && user === String(settings.ownUserId).toLowerCase()) {
    return deny('kendi-yorumum');
  }

  const trivial = isTrivial(raw, settings);
  if (trivial) return deny(trivial);

  const seen = lastText.get(user);
  if (seen && seen.text === raw.trim().toLowerCase() && now - seen.at < (settings.duplicateWindowSec ?? 20) * 1000) {
    return deny('tekrar-yorum');
  }
  if ((cooldown.get(user) ?? 0) > now) return deny('kullanici-bekleme');

  const spoken0 = toSpeakable(raw, settings.cleanup || {});
  if (!spoken0) return deny('temizleme-sonrasi-bos');

  // Kufur filtresi tamamen kapatilabilir (varsayilan: acik)
  const filterOn = settings.profanityFilterEnabled !== false;
  const detection = filterOn
    ? detectProfanity(spoken0, settings)
    : { hit: false, matched: [], spans: [], action: null };

  if (detection.hit && settings.blockProfanityUsers && user) {
    const list = new Set(blocked);
    list.add(user);
    settings.blockedUsers = [...list];
    return { ...deny('kufurlu-kullanici-engellendi', detection), mutatedSettings: settings };
  }

  const applied = applyProfanity(spoken0, detection, settings);
  if (applied.skipped || !applied.text) return deny('kufur-sansur', detection);
  if (applied.text.length < (settings.minLength ?? 2)) return deny('kufur-sonrasi-cok-kisa', detection);

  // durumu guncelle
  lastText.set(user, { text: raw.trim().toLowerCase(), at: now });
  cooldown.set(user, now + (settings.userCooldownSec ?? 0) * 1000);

  return {
    speak: true,
    reason: null,
    spokenText: applied.text,
    beep: applied.beep,
    profanity: detection.hit ? detection : null
  };
}

export default {
  toSpeakable, normalizeToken, tokenize, detectProfanity, applyProfanity, isTrivial,
  evaluateComment, detectCommentLanguage, DEFAULT_PROFANITY_WORDS, DEFAULT_ABBREVIATIONS
};
