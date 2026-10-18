/**
 * Ayarlar: varsayilanlar, yukleme/kaydetme (atomik), sema turlari.
 * Electron main surecinde kullanilir (userData klasorunde saklanir).
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROFANITY_WORDS } from './filters.js';

export const DEFAULTS = {
  // TikTok
  username: '',
  ownUserId: '',
  autoStart: true,
  autoReconnect: true,
  readGifts: false,
  giftWords: ['Role geldi', 'hediye geldi', 'abone oldu'],

  // Kuyruk / tempo
  queueMax: 200,
  maxPerMinute: 12,
  queueAll: true, // dakikada-limit kapali: hepsi siraya girer, tempo minGapMs ile
  minGapMs: 2000,
  enabled: false,

  // Ses / TTS
  volumePercent: 100,
  lengthScale: 1.0,
  noiseScale: 0.4,
  noiseWScale: 0.3,
  speakUsername: false,
  gapSilenceMs: 120,
  voiceId: '',        // bos = motor.json'daki varsayilan (paketle gelen) ses
  speakerId: 0,
  englishRouting: true, // Ingilizce baslayan yorum Ingilizce motorla okunur
  englishVoiceId: '',   // bos = kurulu ilk Ingilizce ses
  englishSpeakerId: 0,
  keepBothEngines: true, // kapaliysa Ingilizce motor 5 dk bos kalinca bellekten atilir

  // Yorum gecmisi (kalici saklama; userData/comments/history.jsonl)
  historyEnabled: true,
  historyMaxEntries: 100_000,

  // Filtreler
  profanityFilterEnabled: true,
  profanityAction: 'mask', // mask | stars | beep | skip
  maskToken: '***',
  profanityWords: DEFAULT_PROFANITY_WORDS,
  regexRules: [],
  blockProfanityUsers: false,
  blockedUsers: [],
  allowedUsers: [],
  whitelistOnly: false,
  ignoreOwn: true,
  readShortComments: false,
  minLength: 2,
  minLetters: 1,
  maxLength: 300,
  onlyTurkish: false,
  userCooldownSec: 5,
  duplicateWindowSec: 20,
  cleanup: {
  stripLinks: true,
  mentionMode: 'read',
  stripHashtags: true,
  stripEmoji: true,
  stripBrackets: true
},

  // Arayuz
  uiLanguage: 'tr', // tr | en | system
  theme: 'dark',
  logLevel: 'info'
};

const NUMERIC = {
  volumePercent: [0, 300],
  lengthScale: [0.5, 2],
  speakerId: [0, 999],
  englishSpeakerId: [0, 999],
  noiseScale: [0, 1.5],
  noiseWScale: [0, 1.5],
  queueMax: [1, 500],
  maxPerMinute: [1, 120],
  minGapMs: [1000, 30_000],
  minLength: [0, 100],
  minLetters: [0, 50],
  maxLength: [10, 2000],
  userCooldownSec: [0, 3600],
  duplicateWindowSec: [0, 3600],
  gapSilenceMs: [0, 2000],
  historyMaxEntries: [1000, 1_000_000]
};
const BOOLEANS = [
  'autoReconnect', 'readGifts', 'enabled', 'speakUsername', 'blockProfanityUsers',
  'whitelistOnly', 'ignoreOwn', 'readShortComments', 'onlyTurkish', 'profanityFilterEnabled',
  'autoStart', 'queueAll', 'englishRouting', 'keepBothEngines', 'historyEnabled'
];
const ARRAYS = ['profanityWords', 'regexRules', 'blockedUsers', 'allowedUsers', 'giftWords'];
const ENUMS = {
  profanityAction: ['mask', 'stars', 'beep', 'skip'],
  theme: ['dark', 'light'],
  uiLanguage: ['tr', 'en', 'system']
};
/** cleanup.mentionMode icin gecerli degerler. */
const MENTION_MODES = ['read', 'at', 'strip', 'ignore'];

function clamp(value, [min, max]) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Bozuk/eksik ayarlari varsayilana cekerek birlestirir. */
export function normalizeSettings(raw) {
  const out = structuredClone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) continue;
    if (NUMERIC[key]) {
      const v = clamp(value, NUMERIC[key]);
      if (v !== undefined) out[key] = v;
    } else if (BOOLEANS.includes(key)) {
      if (typeof value === 'boolean') out[key] = value;
    } else if (ARRAYS.includes(key)) {
      if (Array.isArray(value)) out[key] = value.map((v) => String(v)).filter((s) => s.trim().length);
    } else if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value;
    } else if (typeof value === typeof DEFAULTS[key]) {
      out[key] = value;
    } else if (key === 'cleanup' && value && typeof value === 'object') {
      const merged = { ...DEFAULTS.cleanup };
      for (const [k, v] of Object.entries(value)) {
        if (k === 'mentionMode') {
          if (MENTION_MODES.includes(v)) merged.mentionMode = v;
        } else if (k in DEFAULTS.cleanup && typeof v === 'boolean') {
          merged[k] = v;
        }
      }
      out.cleanup = merged;
    }
  }
  return out;
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings() {
  const file = settingsFile();
  try {
    if (existsSync(file)) return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    console.warn('[settings] okunamadi, varsayilanlar kullanilacak:', err.message);
  }
  return structuredClone(DEFAULTS);
}

export function saveSettings(settings) {
  const file = settingsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, file); // atomik
  return file;
}