import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  VoiceManager, sanitizeId, formatBytes, validatePiperConfig, normalizeCatalog, findVoiceInDir
} from '../src/main/voice-manager.js';

const VALID_CONFIG = {
  audio: { sample_rate: 22050, quality: 'medium' },
  espeak: { voice: 'tr' },
  phoneme_type: 'espeak',
  num_symbols: 256,
  num_speakers: 1,
  inference: { noise_scale: 0.4, length_scale: 1.2, noise_w: 0.3 }
};
const MULTI_CONFIG = {
  ...VALID_CONFIG,
  audio: { sample_rate: 22050 },
  num_speakers: 3,
  speaker_id_map: { 0: 'Anna', 1: 'Bernd', 2: 'Cem' }
};

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'tts-voices-'));
}

function makeVoice(dir, name, config = VALID_CONFIG) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.onnx`), 'fake-onnx-bytes');
  writeFileSync(path.join(dir, `${name}.onnx.json`), JSON.stringify(config));
  return dir;
}

const EN_CONFIG = {
  ...VALID_CONFIG,
  espeak: { voice: 'en-us' }
};

/* ----------------------------- saf fonksiyonlar ----------------------------- */

test('sanitizeId: guvenli id, path traversal engelli', () => {
  assert.equal(sanitizeId('tr_TR-dfki-medium'), 'tr_TR-dfki-medium');
  assert.equal(sanitizeId('tr_TR-fahrettin-medium.onnx'), 'tr_TR-fahrettin-medium');
  assert.equal(sanitizeId('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeId('C:\\Windows\\System32\\evil'), 'C_Windows_System32_evil');
  assert.equal(sanitizeId('a b/c*d'), 'a_b_c_d');
  assert.equal(sanitizeId(''), null);
  assert.equal(sanitizeId('..'), null);
  assert.equal(sanitizeId('...'), null);
  assert.equal(sanitizeId('   '), null);
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(63 * 1024 * 1024), '63.0 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');
});

test('validatePiperConfig: gecerli modeli kabul eder', () => {
  const info = validatePiperConfig(VALID_CONFIG);
  assert.equal(info.ok, true);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.espeakVoice, 'tr');
  assert.equal(info.numSpeakers, 1);
  assert.deepEqual(info.speakers, []);
});

test('validatePiperConfig: cok konusmacili modelde konusmaci listesi', () => {
  const info = validatePiperConfig(MULTI_CONFIG);
  assert.equal(info.numSpeakers, 3);
  assert.deepEqual(info.speakers.map((s) => s.name), ['Anna', 'Bernd', 'Cem']);
});

test('validatePiperConfig: gecersiz modelleri reddeder', () => {
  assert.equal(validatePiperConfig(null).ok, false);
  assert.equal(validatePiperConfig({}).ok, false);
  assert.equal(validatePiperConfig({ audio: {}, num_symbols: 256, espeak: { voice: 'tr' } }).ok, false);
  assert.equal(validatePiperConfig({ audio: { sample_rate: 22050 } }).ok, false, 'num_symbols yoksa reddet');
  const noEspeak = validatePiperConfig({ audio: { sample_rate: 22050 }, num_symbols: 256, phoneme_type: 'phoneme' });
  assert.equal(noEspeak.ok, false);
});

test('normalizeCatalog: voices.json -> uygulama girisi', () => {
  const entries = normalizeCatalog({
    'tr_TR-dfki-medium': {
      name: 'dfki',
      language: { code: 'tr_TR', family: 'tr', region: 'TR', name_native: 'Türkçe', name_english: 'Turkish', country_english: 'Turkey' },
      quality: 'medium',
      num_speakers: 1,
      files: {
        'tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx': { size_bytes: 63201294, md5_digest: 'abc' },
        'tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx.json': { size_bytes: 4960, md5_digest: 'def' }
      }
    },
    'bozuk-kayit': { files: {} } // onnx yoksa atlanmali
  });
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.id, 'tr_TR-dfki-medium');
  assert.equal(e.language.native, 'Türkçe');
  assert.equal(e.language.english, 'Turkish');
  assert.equal(e.sizeBytes, 63201294);
  assert.equal(e.md5, 'abc');
  assert.ok(e.onnxUrl.includes('tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx'));
});

test('findVoiceInDir: adi ne olursa olsun .onnx + .onnx.json bulur', () => {
  const root = tempRoot();
  const dir = makeVoice(path.join(root, 'v1'), 'model');
  const found = findVoiceInDir(dir);
  assert.equal(path.basename(found.modelPath), 'model.onnx');
  assert.equal(path.basename(found.configPath), 'model.onnx.json');

  const dir2 = makeVoice(path.join(root, 'v2'), 'de_DE-kerstin-medium');
  const found2 = findVoiceInDir(dir2);
  assert.equal(path.basename(found2.modelPath), 'de_DE-kerstin-medium.onnx');
  rmSync(root, { recursive: true, force: true });
});

test('findVoiceInDir: config yoksa null', () => {
  const root = tempRoot();
  const dir = path.join(root, 'v3');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'x.onnx'), 'x');
  assert.equal(findVoiceInDir(dir), null);
  rmSync(root, { recursive: true, force: true });
});

/* ----------------------------- VoiceManager ----------------------------- */

test('getInstalled: paketle gelen + kullanici seslerini birlestirir', () => {
  const root = tempRoot();
  const bundled = makeVoice(path.join(root, 'bundled', 'turkish'), 'model');
  const userRoot = path.join(root, 'voices');
  makeVoice(path.join(userRoot, 'de_DE-test-medium'), 'de_DE-test-medium');

  const vm = new VoiceManager({ bundledDirs: [bundled], userRoot, cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();
  const installed = vm.getInstalled();
  const ids = installed.map((v) => v.id).sort();
  assert.deepEqual(ids, ['de_DE-test-medium', 'turkish']);
  assert.equal(installed.find((v) => v.id === 'turkish').origin, 'bundled');
  assert.equal(installed.find((v) => v.id === 'de_DE-test-medium').origin, 'user');
  assert.equal(installed.find((v) => v.id === 'de_DE-test-medium').valid, true);
  assert.equal(installed.find((v) => v.id === 'de_DE-test-medium').sampleRate, 22050);
  rmSync(root, { recursive: true, force: true });
});

test('getInstalled: iki kokteki sesler birlesir, ayni id bir kez sayilir', () => {
  const root = tempRoot();
  const userRoot = path.join(root, 'voices');
  const fallback = path.join(root, 'data', 'voices');
  makeVoice(path.join(userRoot, 'de_DE-test-medium'), 'de_DE-test-medium');
  makeVoice(path.join(fallback, 'en_US-test-medium'), 'en_US-test-medium', EN_CONFIG);
  // Ayni ses iki kokte de varsa cozumlenen kokteki gecerli olur.
  makeVoice(path.join(fallback, 'de_DE-test-medium'), 'de_DE-test-medium');

  const vm = new VoiceManager({ bundledDirs: [], userRoot, fallbackRoot: fallback, cacheDir: path.join(root, 'cache') });
  const installed = vm.getInstalled();
  const ids = installed.map((v) => v.id).sort();
  assert.deepEqual(ids, ['de_DE-test-medium', 'en_US-test-medium']);
  assert.equal(installed.find((v) => v.id === 'de_DE-test-medium').dir, path.join(userRoot, 'de_DE-test-medium'));
  rmSync(root, { recursive: true, force: true });
});

test('getInstalled: userRoot yazilamazsa yedek kokteki sesler gorunur', () => {
  const root = tempRoot();
  // Dosya oldugu icin mkdir basarisiz olur (salt-okunur kurulum taklidi).
  const blocker = path.join(root, 'blocker');
  writeFileSync(blocker, 'x');
  const fallback = path.join(root, 'data', 'voices');
  makeVoice(path.join(fallback, 'en_US-test-medium'), 'en_US-test-medium', EN_CONFIG);

  const vm = new VoiceManager({ bundledDirs: [], userRoot: blocker, fallbackRoot: fallback, cacheDir: path.join(root, 'cache') });
  const installed = vm.getInstalled();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].id, 'en_US-test-medium');
  assert.equal(installed[0].origin, 'user');
  assert.equal(installed[0].valid, true);
  assert.equal(installed[0].espeakVoice, 'en-us');
  rmSync(root, { recursive: true, force: true });
});

test('remove: paketle gelen ses silinemez, kullanici silinir', () => {
  const root = tempRoot();
  const bundled = makeVoice(path.join(root, 'bundled', 'turkish'), 'model');
  const userRoot = path.join(root, 'voices');
  makeVoice(path.join(userRoot, 'fr_FR-x-medium'), 'fr_FR-x-medium');
  const vm = new VoiceManager({ bundledDirs: [bundled], userRoot, cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();

  const blocked = vm.remove('turkish');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /paketle gelen/i);

  const removed = vm.remove('fr_FR-x-medium');
  assert.equal(removed.ok, true);
  assert.equal(vm.getInstalled().find((v) => v.id === 'fr_FR-x-medium'), undefined);
  rmSync(root, { recursive: true, force: true });
});

test('remove: dis yolda silmeyi reddeder', () => {
  const root = tempRoot();
  const userRoot = path.join(root, 'voices');
  mkdirSync(userRoot, { recursive: true });
  const outside = makeVoice(path.join(root, 'disarida'), 'x');
  const vm = new VoiceManager({ bundledDirs: [], userRoot, cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();
  // disaridaki ses listede olmadigi icin zaten "bulunamadi" doner
  assert.equal(vm.remove('x').ok, false);
  assert.ok(statSync(path.join(outside, 'x.onnx')));
  rmSync(root, { recursive: true, force: true });
});

test('importLocal: onnx + json ciftini kopyalar ve listeye ekler', () => {
  const root = tempRoot();
  const userRoot = path.join(root, 'voices');
  const source = makeVoice(path.join(root, 'kaynak'), 'ozel-ses', MULTI_CONFIG);
  const vm = new VoiceManager({ bundledDirs: [], userRoot, cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();

  const voice = vm.importLocal(path.join(source, 'ozel-ses.onnx'));
  assert.equal(voice.origin, 'user');
  assert.equal(voice.valid, true);
  assert.equal(voice.numSpeakers, 3);
  assert.equal(voice.speakers.length, 3);
  assert.equal(voice.espeakVoice, 'tr');
  assert.ok(vm.getInstalled().some((v) => v.id === 'ozel-ses'));
  rmSync(root, { recursive: true, force: true });
});

test('importLocal: config dosyasi yoksa net hata verir', () => {
  const root = tempRoot();
  const userRoot = path.join(root, 'voices');
  const lonely = path.join(root, 'yalniz');
  mkdirSync(lonely, { recursive: true });
  writeFileSync(path.join(lonely, 'ses.onnx'), 'x');
  const vm = new VoiceManager({ bundledDirs: [], userRoot, cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();

  assert.throws(() => vm.importLocal(path.join(lonely, 'ses.onnx')), /iki dosyadır/i);

  // .onnx uzantili olmayan dosya reddedilir
  writeFileSync(path.join(lonely, 'notlar.txt'), 'x');
  assert.throws(() => vm.importLocal(path.join(lonely, 'notlar.txt')), /\.onnx/);
  rmSync(root, { recursive: true, force: true });
});

test('importLocal: gecersiz model reddedilir', () => {
  const root = tempRoot();
  const userRoot = path.join(root, 'voices');
  const source = path.join(root, 'kaynak');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'bozuk.onnx'), 'x');
  writeFileSync(path.join(source, 'bozuk.onnx.json'), JSON.stringify({ hello: 'world' }));
  const vm = new VoiceManager({ bundledDirs: [], userRoot, cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();
  assert.throws(() => vm.importLocal(path.join(source, 'bozuk.onnx')), /Geçersiz Piper modeli/);
  rmSync(root, { recursive: true, force: true });
});

test('resolveUserRoot: yazilabilir degilse yedek koke duser', () => {
  const root = tempRoot();
  const blocked = path.join(root, 'salt-okunur');
  mkdirSync(blocked, { recursive: true });
  // yazma denemesi basarisiz olsun diye yolun uzerine dosya koyuyoruz
  writeFileSync(path.join(root, 'dosya'), 'x');
  const fallback = path.join(root, 'yedek');
  const vm = new VoiceManager({
    bundledDirs: [],
    userRoot: path.join(root, 'dosya', 'voices'),
    fallbackRoot: fallback,
    cacheDir: path.join(root, 'cache')
  });
  const chosen = vm.resolveUserRoot();
  assert.equal(chosen, fallback);
  rmSync(root, { recursive: true, force: true });
});

test('cancel: indirme yoksa false doner', () => {
  const root = tempRoot();
  const vm = new VoiceManager({ bundledDirs: [], userRoot: path.join(root, 'voices'), cacheDir: path.join(root, 'cache') });
  vm.resolveUserRoot();
  assert.equal(vm.cancel('yok-boyle-bir-ses'), false);
  rmSync(root, { recursive: true, force: true });
});

test('readOnlyRoots: eski konum okunur ve silinebilir, yazma hedefi olmaz', () => {
  const root = tempRoot();
  const userRoot = path.join(root, 'voices');
  const legacy = path.join(root, 'kurulum', 'voices');
  mkdirSync(userRoot, { recursive: true });
  makeVoice(path.join(legacy, 'en_US-eski-medium'), 'en_US-eski-medium', EN_CONFIG);
  const vm = new VoiceManager({
    bundledDirs: [],
    userRoot,
    fallbackRoot: userRoot,
    readOnlyRoots: [legacy],
    cacheDir: path.join(root, 'cache')
  });

  // Yazma hedefi her zaman userRoot: readOnlyRoots asla secilmez
  assert.equal(vm.resolveUserRoot(), userRoot);

  // Eski konumdaki ses yine listelenir (okuma kapsami)
  const voice = vm.getInstalled().find((v) => v.dir.startsWith(legacy));
  assert.ok(voice, 'eski konumdaki ses listede olmali');
  assert.equal(voice.id, 'en_US-eski-medium');

  // ...ve silinebilir (guvenlik listesi readOnlyRoots'u icerir)
  assert.equal(vm.remove('en_US-eski-medium').ok, true);
  assert.equal(vm.getInstalled().find((v) => v.id === 'en_US-eski-medium'), undefined);
  rmSync(root, { recursive: true, force: true });
});