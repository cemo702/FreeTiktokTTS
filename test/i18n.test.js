import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES, LANGUAGES, createTranslator, detectSystemLanguage, resolveLanguage, hasKey } from '../src/shared/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

test('iki sozlukte anahtar sayisi ve kumesi birebir ayni', () => {
  const tr = Object.keys(MESSAGES.tr).sort();
  const en = Object.keys(MESSAGES.en).sort();
  assert.equal(tr.length, en.length, `anahtar sayisi farkli (tr=${tr.length}, en=${en.length})`);
  const missingInEn = tr.filter((k) => !hasKey('en', k));
  const missingInTr = en.filter((k) => !hasKey('tr', k));
  assert.deepEqual(missingInEn, [], 'en sozlugunde eksik anahtarlar');
  assert.deepEqual(missingInTr, [], 'tr sozlugunde eksik anahtarlar');
});

test('hicbir deger bos degil', () => {
  for (const lang of Object.keys(MESSAGES)) {
    for (const [key, value] of Object.entries(MESSAGES[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} metin degil`);
      assert.ok(value.trim().length > 0, `${lang}.${key} bos`);
    }
  }
});

test('degisken tutarliligi: ayni deger ayni {degiskenleri kullanir', () => {
  const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(MESSAGES.tr)) {
    assert.deepEqual(vars(MESSAGES.tr[key]), vars(MESSAGES.en[key]), `degisken farki: ${key}`);
  }
});

test('index.html icindeki her data-i18n anahtari sozlukte var', () => {
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 40, `data-i18n niteligi bulunamadi (${keys.length})`);
  const missing = [...new Set(keys)].filter((k) => !hasKey('tr', k));
  assert.deepEqual(missing, [], 'index.html kullanan ama sozlukte olmayan anahtarlar');
});

test('t(): ceviri, degisken ve yedek davranisi', () => {
  const tr = createTranslator('tr');
  const en = createTranslator('en');
  assert.equal(tr('btn.start'), 'Başlat');
  assert.equal(en('btn.start'), 'Start');
  assert.equal(en('log.liveConnected', { user: 'abc', viewers: 12 }), 'Connected to @abc live stream (12 viewers).');
  assert.equal(en('metrics.yok.boyle.bir.anahtar'), 'metrics.yok.boyle.bir.anahtar', 'eksik anahtar anahtar olarak doner');
  assert.equal(createTranslator('de').lang, 'tr', 'bilinmeyen dil Turkceye duser');
});

test('TR ve EN arasinda ayni kalan anahtarlar sadece bilerek ortak olanlar', () => {
  // Markalar/teknik terimler/ikonlar iki dilde de ayni kalmasi dogru olan anahtarlar:
  const intentionallySame = [
    'tab.settings',            // sekme adi istendigi gibi "Settings"
    'metric.synth',            // TTS (teknik)
    'badge.beep',              // "beep"
    'profanity.actionBeep',    // "Beep"
    'volume.limiter',          // LIMITER (teknik rozet)
    'label.regexPlaceholder',  // regex ornegi
    'action.speakLine',        // ikon + {text}
    'footer.speaking',         // ikon + {text}
    'footer.done',             // ikon + {text}
    'settings.language.tr',    // dil adi kendi dilinde ayni
    'settings.language.en',
    'app.title',              // urun adi iki dilde ayni: FreeTiktokTTS
    'btn.donateBmc'           // "Buy me a coffee" marka adi iki dilde ayni
  ];
  const same = Object.keys(MESSAGES.tr).filter((k) => MESSAGES.tr[k] === MESSAGES.en[k]);
  assert.deepEqual(same.sort(), [...intentionallySame].sort(), 'ceviri eksik olabilir');
});

test('dil cozumleme', () => {
  assert.equal(detectSystemLanguage('tr-TR'), 'tr');
  assert.equal(detectSystemLanguage('en-US'), 'en');
  assert.equal(detectSystemLanguage('de-DE'), 'tr', 'desteklenmeyen dil Turkceye duser');
  assert.equal(resolveLanguage('en'), 'en');
  assert.equal(resolveLanguage('system', 'en-GB'), 'en');
  assert.equal(resolveLanguage('xx'), 'tr');
  assert.equal(resolveLanguage(null, 'en'), 'en');
});

test('LANGUAGES listesi tr ve en iceriyor', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.code).sort(), ['en', 'tr']);
});