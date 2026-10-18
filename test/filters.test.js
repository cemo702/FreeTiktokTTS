import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toSpeakable, applyMentions, stripBrackets, expandAbbreviations, detectCommentLanguage, normalizeToken, detectProfanity, applyProfanity, isTrivial, evaluateComment, DEFAULT_PROFANITY_WORDS
} from '../src/main/filters.js';
import { ENGLISH_WORDS } from '../src/main/english-words.js';

const base = { profanityWords: DEFAULT_PROFANITY_WORDS, profanityAction: 'mask', minLength: 2, minLetters: 1 };

/** Turkcede tek basina anlamli kelimeler — asla sayim kumesinde olmamali. */
export const TR_COLLISIONS = [
  'a', 'o', 'on', 'an', 'is', 'it', 'at', 'el', 'son', 'us', 'am', 'can', 'cam',
  'her', 'art', 'men', 'ten', 'top', 'test', 'lan', 'mal', 'sus', 'var', 'ev',
  'bar', 'far', 'gen', 'ham', 'don', 'din', 'fan', 'gel', 'ben', 'sen', 'biz',
  'bir', 've', 'de', 'da', 'mi', 'ne', 'ya', 'mor', 'koy', 'kar', 'dal', 'dar',
  'ara', 'yar', 'para', 'rol', 'spor', 'ses', 'ters', 'tel', 'ter', 'tur',
  'tut', 'uc', 'ver', 'yaz', 'yem', 'yer', 'yol', 'yok', 'zam', 'zar', 'zil',
  'fon', 'tam', 'tarz', 'tek', 'bin', 'es', 'den', 'tar', 'bat', 'er', 'bay',
  'ram', 'tan', 'ton', 'van', 'yap', 'oy', 'siz', 'kim'
];

/** Turkce sohbette ciplak kullanilan odunc kelimeler — sayim kumesinde olmamali. */
const TR_LOANWORDS = [
  'video', 'story', 'star', 'mood', 'level', 'map', 'mod', 'ban', 'mute',
  'admin', 'sub', 'vote', 'clip', 'raid', 'hype', 'spam', 'troll', 'bot',
  'patch', 'meta', 'skin', 'loot', 'spawn', 'camp', 'tank', 'support',
  'jungle', 'adc', 'op', 'nerf', 'buff', 'phone', 'movie', 'player', 'match',
  'cool', 'bank', 'form', 'park', 'plan', 'normal', 'chat', 'cancel', 'camera',
  'cinema', 'trend', 'ticket', 'update', 'version', 'user'
];

test('ENGLISH_WORDS: format, tekrar ve adet dogru', () => {
  assert.ok(ENGLISH_WORDS.length >= 1500, `kelime sayisi az: ${ENGLISH_WORDS.length}`);
  assert.equal(new Set(ENGLISH_WORDS).size, ENGLISH_WORDS.length, 'tekrar eden kelime var');
  for (const word of ENGLISH_WORDS) {
    assert.match(word, /^[a-z']+$/, `bozuk format: ${word}`);
    assert.ok(word.length >= 2 || word === 'i', `tek harf: ${word}`);
  }
});

test('ENGLISH_WORDS: Turkce cakisan ve ciplak odunc kelimeler yok', () => {
  const set = new Set(ENGLISH_WORDS);
  const collisions = TR_COLLISIONS.filter((w) => set.has(w));
  const loans = TR_LOANWORDS.filter((w) => set.has(w));
  assert.deepEqual(collisions, [], 'Turkce cakisan kelimeler sızdı');
  assert.deepEqual(loans, [], 'ciplak odunc kelimeler sızdı');
});

test('toSpeakable: link, mention, hashtag ve emoji temizlenir', () => {
  const out = toSpeakable('süper video! @ahmet #tiktok https://tiktok.com/@x/y 😍🔥');
  assert.equal(out, 'süper video! ahmet');
});

test('toSpeakable: yorum basindaki @etiketi kullanici adiyla okunur', () => {
  assert.equal(toSpeakable('@Ahmet Durak onda çıkmaz'), 'Ahmet Durak onda çıkmaz');
  assert.equal(toSpeakable('@ahmet_selim merhaba'), 'ahmet_selim merhaba');
});

test('applyMentions: moda gore etiket okunur', () => {
  assert.equal(applyMentions('@Ahmet Durak', 'read'), ' Ahmet Durak');
  assert.equal(applyMentions('@Ahmet', 'at'), ' at Ahmet');
  assert.equal(applyMentions('@Ahmet', 'strip'), ' ');
  assert.equal(applyMentions('@Ahmet', 'ignore'), '@Ahmet');
});

test('toSpeakable: mentionMode=strip eski davranisi verir', () => {
  assert.equal(toSpeakable('@Ahmet Durak', { mentionMode: 'strip' }), 'Durak');
});

test('expandAbbreviations: secili kisaltmalar konusma metnine donusur', () => {
  assert.equal(expandAbbreviations('sa'), 'selam aleyküm');
  assert.equal(expandAbbreviations('slm'), 'selam');
  assert.equal(expandAbbreviations('gg'), 'good game');
  assert.equal(expandAbbreviations('nbr'), 'naber');
  assert.equal(expandAbbreviations('mrb'), 'merhaba');
  assert.equal(expandAbbreviations('tmm'), 'tamam');
  assert.equal(expandAbbreviations('as'), 'aleyküm selam');
  assert.equal(expandAbbreviations('eyv'), 'eyvallah');
});

test('toSpeakable: kisaltmalar buyuk-kucuk harf ve noktalamada genisler', () => {
  assert.equal(toSpeakable('SA herkese'), 'selam aleyküm herkese');
  assert.equal(toSpeakable('slm!'), 'selam!');
  assert.equal(toSpeakable('(nbr) nasilsin?'), '(naber) nasilsin?');
  assert.equal(toSpeakable('gg, mrb?'), 'good game, merhaba?');
});

test('toSpeakable: kelime ici, mention ve baglanti kisaltmalari korunur', () => {
  assert.equal(toSpeakable('masa guzel'), 'masa guzel');
  assert.equal(toSpeakable('slm123 yazdi'), 'slm123 yazdi');
  assert.equal(toSpeakable('@sa selam'), 'sa selam');
  assert.equal(toSpeakable('siteye bak https://ornek/slm'), 'siteye bak');
  assert.equal(toSpeakable('sa', { expandAbbreviations: false }), 'sa');
});

test('evaluateComment: yorum govdesindeki kisaltma konusma metnine yansir', () => {
  const res = evaluateComment({ text: 'slm', userId: 'u1' }, base);
  assert.equal(res.speak, true);
  assert.equal(res.spokenText, 'selam');
});

test('detectCommentLanguage: Ingilizce baslayan yorum en', () => {
  assert.equal(detectCommentLanguage('hello guys welcome'), 'en');
  assert.equal(detectCommentLanguage('Hello, how are you?'), 'en');
  assert.equal(detectCommentLanguage('gg guys well played'), 'en');
  assert.equal(detectCommentLanguage('good game everyone'), 'en');
  assert.equal(detectCommentLanguage('i love you guys'), 'en');
  assert.equal(detectCommentLanguage('I am happy today'), 'en');
  assert.equal(detectCommentLanguage('i, hello everyone'), 'en');
});

test('detectCommentLanguage: Turkce baslayan (tek Ingilizce kelimeyle) tr', () => {
  assert.equal(detectCommentLanguage('sa abi naber'), 'tr');
  assert.equal(detectCommentLanguage('merhaba welcome arkadaslar'), 'tr');
  assert.equal(detectCommentLanguage('abi hello yazdi'), 'tr');
  assert.equal(detectCommentLanguage('masa guzel olmus'), 'tr');
  assert.equal(detectCommentLanguage('Ahmet geldi'), 'tr');
  assert.equal(detectCommentLanguage('iyi akşamlar herkese'), 'tr');
  assert.equal(detectCommentLanguage('ıslandım yağmurda'), 'tr');
});

test('detectCommentLanguage: cumlede 2+ Ingilizce kelime varsa en (oncelikli)', () => {
  assert.equal(detectCommentLanguage('abi hello guys hosgeldin'), 'en');
  assert.equal(detectCommentLanguage('ya i love this sarki'), 'en');
  assert.equal(detectCommentLanguage('ok thanks bro'), 'en');
  assert.equal(detectCommentLanguage('im happy today'), 'en');
  assert.equal(detectCommentLanguage('kanka good game well played'), 'en');
  assert.equal(detectCommentLanguage('use the spearmen on the front ans swordmen on the flanks'), 'en');
  assert.equal(detectCommentLanguage('to be or not to be'), 'en');
  assert.equal(detectCommentLanguage('be abi naber'), 'tr');
});

test('detectCommentLanguage: tek Ingilizce kelime yetmez, ilk kelime karar verir', () => {
  assert.equal(detectCommentLanguage('merhaba hello arkadaslar'), 'tr');
  assert.equal(detectCommentLanguage('ok abi tamam'), 'tr');
});

test('detectCommentLanguage: Turkceyle cakisan kisa kelimeler sayilmaz', () => {
  assert.equal(detectCommentLanguage('o geldi buraya'), 'tr');
  assert.equal(detectCommentLanguage('on kisi geldi yayina'), 'tr');
  assert.equal(detectCommentLanguage('son sarki guzeldi'), 'tr');
  assert.equal(detectCommentLanguage('at gibi kostu cocuk'), 'tr');
  assert.equal(detectCommentLanguage('is kokusu geldi'), 'tr');
  assert.equal(detectCommentLanguage('a harfini yazdi'), 'tr');
  assert.equal(detectCommentLanguage('am ne demek'), 'tr');
});

test('detectCommentLanguage: ciplak odunc kelimeler cumleyi Ingilizceye cevirmez', () => {
  assert.equal(detectCommentLanguage('video story attim'), 'tr');
  assert.equal(detectCommentLanguage('star gibi parliyor'), 'tr');
  assert.equal(detectCommentLanguage('mood dustu bugun'), 'tr');
  assert.equal(detectCommentLanguage('level atladim oyunda'), 'tr');
  assert.equal(detectCommentLanguage('map ac bakayim'), 'tr');
  assert.equal(detectCommentLanguage('vote attin mi'), 'tr');
  assert.equal(detectCommentLanguage('ban yedim ya'), 'tr');
  assert.equal(detectCommentLanguage('mod yap beni'), 'tr');
  assert.equal(detectCommentLanguage('bank kartimi kaybettim'), 'tr');
  assert.equal(detectCommentLanguage('form doldurdum'), 'tr');
});

test('detectCommentLanguage: live/game ilk kelime olarak Turkce kalir', () => {
  assert.equal(detectCommentLanguage('live yayin ne zaman'), 'tr');
  assert.equal(detectCommentLanguage('game giriyor muyuz'), 'tr');
});

test('detectCommentLanguage: odunc kelime + baglac kombinasyonu yine en', () => {
  assert.equal(detectCommentLanguage('vote now guys'), 'en');
  assert.equal(detectCommentLanguage('going live now'), 'en');
});

test('detectCommentLanguage: apostrof kuyrugu M-Prince tarzi tokenlari yakalar', () => {
  assert.equal(detectCommentLanguage("You've done it M'Lord!"), 'en');
  assert.equal(detectCommentLanguage('Victory my lord'), 'en');
  assert.equal(detectCommentLanguage("n'aber kanka"), 'tr');
});

test('detectCommentLanguage: bastaki etiket adres sayilir, karara katilmaz', () => {
  assert.equal(detectCommentLanguage('@Ahmet hello guys'), 'en');
  assert.equal(detectCommentLanguage('@user merhaba abi'), 'tr');
  assert.equal(detectCommentLanguage('[rosiecute] hello'), 'en');
  assert.equal(detectCommentLanguage('https://ornek/x hello'), 'en');
  assert.equal(detectCommentLanguage(''), 'tr');
  assert.equal(detectCommentLanguage(null), 'tr');
});

test('toSpeakable: kose li parantez icerigi atlanir', () => {
  assert.equal(toSpeakable('[rosiecute] çok güzel'), 'çok güzel');
  assert.equal(toSpeakable('güzel [rosiecute]'), 'güzel');
  assert.equal(toSpeakable('[a] merhaba [b] dünya'), 'merhaba dünya');
  assert.equal(toSpeakable('[ ] boş'), 'boş');
  assert.equal(toSpeakable('başında [acik kalmadi]'), 'başında');
});

test('toSpeakable: kapanmamis parantez isareti okunmaz', () => {
  assert.equal(toSpeakable('acik [parantez'), 'acik parantez');
  assert.equal(toSpeakable('kapanmadi] burada'), 'kapanmadi burada');
});

test('toSpeakable: stripBrackets kapatilirsa icerik okunur', () => {
  assert.equal(toSpeakable('[rosiecute] yazdı', { stripBrackets: false }), '[rosiecute] yazdı');
});

test('stripBrackets: metin olmayan girdi guvenli', () => {
  assert.equal(stripBrackets(null), '');
  assert.equal(stripBrackets(undefined), '');
});

test('toSpeakable: metin olmayan girdi guvenli', () => {
  assert.equal(toSpeakable(null), '');
  assert.equal(toSpeakable(undefined), '');
});

test('normalizeToken: turkce katlama ve leet', () => {
  assert.equal(normalizeToken('ŞİK'), 'sik');
  assert.equal(normalizeToken('Amına'), 'amina');
  assert.equal(normalizeToken('s.i.k.e.n'), 'siken');
  assert.equal(normalizeToken('b0g'), 'bog');
});

test('detectProfanity: duz kelime yakalanir, duz olmayan yakalanmaz', () => {
  const hit = detectProfanity('bu adam çok siktir be', base);
  assert.equal(hit.hit, true);
  assert.ok(hit.matched.some((m) => m.includes('siktir')));

  const clean = detectProfanity('iyi günler arkadaşlar', base);
  assert.equal(clean.hit, false, 'gunduz kelimeler yanlis pozitif uretmemeli');
});

test('detectProfanity: kamufle yazim (ayracli ve leet)', () => {
  assert.equal(detectProfanity('s.i.k.e.n birader', base).hit, true);
  assert.equal(detectProfanity('p!y@nt ver', base).hit, false, 'kisa kelimeler icin leet eslesmesi kapali olmali');
});

test('detectProfanity: ek/sonek toleransi (5+ harf)', () => {
  assert.equal(detectProfanity('orospular ciddi', base).hit, true);
  assert.equal(detectProfanity('amiral yazdı', base).hit, false, 'kisa kelime icinde eslesmemeli');
});

test('detectProfanity: cok kelimeli ifade', () => {
  const res = detectProfanity('seninle dönüp konuşacağız, amına koyarım', base);
  assert.equal(res.hit, true);
  assert.ok(res.matched.some((m) => m.toLowerCase().includes('amına')));
});

test('applyProfanity: mask siler, yalnizca bosluk kalir', () => {
  const d = detectProfanity('sen bi siktir', base);
  const r = applyProfanity('sen bi siktir', d, base);
  assert.equal(r.text, 'sen bi');
  assert.equal(r.masked, true);
});

test('applyProfanity: stars modu *** kullanir', () => {
  const d = detectProfanity('sen bi siktir', { ...base, profanityAction: 'stars' });
  const r = applyProfanity('sen bi siktir', d, { ...base, profanityAction: 'stars' });
  assert.equal(r.text, 'sen bi ***');
});

test('applyProfanity: beep modu metni degistirmez', () => {
  const d = detectProfanity('sen bi siktir', { ...base, profanityAction: 'beep' });
  const r = applyProfanity('sen bi siktir', d, { ...base, profanityAction: 'beep' });
  assert.equal(r.text, 'sen bi siktir');
  assert.equal(r.beep, true);
});

test('applyProfanity: skip modu bos metin doner', () => {
  const d = detectProfanity('sen bi siktir', { ...base, profanityAction: 'skip' });
  const r = applyProfanity('sen bi siktir', d, { ...base, profanityAction: 'skip' });
  assert.equal(r.text, '');
  assert.equal(r.skipped, true);
});

test('isTrivial: kisa / emoji / uzun', () => {
  assert.equal(isTrivial('', base), 'bos');
  assert.equal(isTrivial('😀😀', base), 'sadece-emoji');
  assert.equal(isTrivial('a', base), 'cok-kisa');
  assert.equal(isTrivial('iyi bir video', { ...base, maxLength: 5 }), 'cok-uzun');
  assert.equal(isTrivial('iyi bir video', base), null);
});

test('evaluateComment: kufur maskelenerek okunur', () => {
  const res = evaluateComment({ text: 'sen bi siktir', userId: 'u1' }, base);
  assert.equal(res.speak, true);
  assert.equal(res.spokenText, 'sen bi');
  assert.ok(res.profanity);
});

test('evaluateComment: sansur yorumu okunmaz', () => {
  const res = evaluateComment({ text: 'sen bi siktir', userId: 'u1' }, { ...base, profanityAction: 'skip' });
  assert.equal(res.speak, false);
  assert.equal(res.reason, 'kufur-sansur');
});

test('evaluateComment: tekrar yorum reddedilir', () => {
  const settings = { ...base, duplicateWindowSec: 30 };
  const state = {};
  const t0 = 1_000_000;
  assert.equal(evaluateComment({ text: 'merhaba', userId: 'u1', at: t0 }, settings, state).speak, true);
  const second = evaluateComment({ text: 'merhaba', userId: 'u1', at: t0 + 2000 }, settings, state);
  assert.equal(second.speak, false);
  assert.equal(second.reason, 'tekrar-yorum');
});

test('evaluateComment: kullanici sogutmasi', () => {
  const settings = { ...base, userCooldownSec: 10 };
  const state = {};
  const t0 = 2_000_000;
  assert.equal(evaluateComment({ text: 'ilk yorum', userId: 'u1', at: t0 }, settings, state).speak, true);
  const second = evaluateComment({ text: 'ikinci yorum', userId: 'u1', at: t0 + 1000 }, settings, state);
  assert.equal(second.speak, false);
  assert.equal(second.reason, 'kullanici-bekleme');
});

test('evaluateComment: kara liste ve beyaz liste', () => {
  const s1 = { ...base, blockedUsers: ['spam'] };
  assert.equal(evaluateComment({ text: 'iyi yorum', userId: 'spam' }, s1).reason, 'engelli-kullanici');

  const s2 = { ...base, whitelistOnly: true, allowedUsers: ['vip'] };
  assert.equal(evaluateComment({ text: 'iyi yorum', userId: 'random' }, s2).reason, 'beyaz-liste-disi');
  assert.equal(evaluateComment({ text: 'iyi yorum', userId: 'vip' }, s2).speak, true);
});

test('evaluateComment: kufurlu kullanici otomatik engellenir', () => {
  const settings = { ...base, blockProfanityUsers: true };
  const res = evaluateComment({ text: 'sen bi siktir', userId: 'kufurcu' }, settings);
  assert.equal(res.speak, false);
  assert.equal(res.reason, 'kufurlu-kullanici-engellendi');
  assert.ok(settings.blockedUsers.includes('kufurcu'));
});

test('detectProfanity: gunduz kelimelerle karismaz', () => {
  assert.equal(detectProfanity('biraz sıkıntı var', base).hit, false);
  assert.equal(detectProfanity('amiral gibi bir adam', base).hit, false);
  assert.equal(detectProfanity('komşular çok sinirli', base).hit, false);
  assert.equal(detectProfanity('saygılar', base).hit, false);
});

test('evaluateComment: regex kurallari', () => {
  const settings = { ...base, regexRules: ['\\b(?:dolar|euro)\\b'] };
  const res = evaluateComment({ text: '100 dolar kazandım', userId: 'u1' }, settings);
  assert.equal(res.speak, true);
  assert.equal(res.spokenText, '100 kazandım');
  assert.ok(res.profanity);
});

test('evaluateComment: tek basina etiket, kullanici adi olarak okunur', () => {
  const res = evaluateComment({ text: '@user', userId: 'u1' }, base);
  assert.equal(res.speak, true);
  assert.equal(res.spokenText, 'user');
});

test('evaluateComment: etiket okunmaz secilince temizlemeden sonra bos kalan yorum reddedilir', () => {
  const res = evaluateComment({ text: '@user', userId: 'u1' }, { ...base, cleanup: { mentionMode: 'strip' } });
  assert.equal(res.speak, false);
  assert.equal(res.reason, 'temizleme-sonrasi-bos');
});

test('evaluateComment: kufur filtresi kapatilabilir', () => {
  const kapali = { ...base, profanityFilterEnabled: false };
  const res = evaluateComment({ text: 'sen bi siktir be', userId: 'u1' }, kapali);
  assert.equal(res.speak, true);
  assert.equal(res.spokenText, 'sen bi siktir be');
  assert.equal(res.profanity, null);

  const acik = { ...base, profanityFilterEnabled: true };
  assert.equal(evaluateComment({ text: 'sen bi siktir be', userId: 'u2' }, acik).spokenText, 'sen bi be');
});

test('evaluateComment: filtre kapaliyken kullaniyi otomatik engellemez', () => {
  const settings = { ...base, blockedUsers: [], profanityFilterEnabled: false, blockProfanityUsers: true };
  const res = evaluateComment({ text: 'sen bi siktir', userId: 'kufurcu' }, settings);
  assert.equal(res.speak, true);
  assert.deepEqual(settings.blockedUsers, []);
});