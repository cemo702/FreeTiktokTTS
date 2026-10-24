import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGELOG } from '../src/shared/changelog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('changelog: en yeni girdi package.json surumuyle eslesir', () => {
  assert.ok(CHANGELOG.length > 0, 'changelog bos olamaz');
  assert.equal(
    CHANGELOG[0].version,
    pkg.version,
    'surumu artirdiysan src/shared/changelog.js dosyasina da girdi eklemelisin'
  );
});

test('changelog: her girdi gecerli surum/tarih ve dolu tr+en listeleri icerir', () => {
  for (const entry of CHANGELOG) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, `surum bicimi bozuk: ${entry.version}`);
    assert.match(String(entry.date), /^\d{4}-\d{2}-\d{2}$/, `tarih ISO olmali: ${entry.date}`);
    assert.ok(Array.isArray(entry.tr) && entry.tr.length > 0, `${entry.version}: tr listesi bos`);
    assert.ok(Array.isArray(entry.en) && entry.en.length > 0, `${entry.version}: en listesi bos`);
    for (const line of [...entry.tr, ...entry.en]) {
      assert.equal(typeof line, 'string', `${entry.version}: maddeler metin olmali`);
      assert.ok(line.trim().length > 0, `${entry.version}: bos madde var`);
    }
  }
});
