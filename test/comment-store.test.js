import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommentStore } from '../src/main/comment-store.js';

function tempStore(maxEntries = 100_000, enabled = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'comment-store-'));
  const store = new CommentStore({ dir, maxEntries, enabled });
  return { dir, store };
}

function readAll(store) {
  if (!existsSync(store.filePath)) return [];
  return readFileSync(store.filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('append + flush: kayitlar dosyaya duzgun duser', () => {
  const { dir, store } = tempStore();
  store.append({ id: 'c1', userId: 'u1', userName: 'Ali', text: 'merhaba', spokenText: 'merhaba', status: 'spoken', at: 1000 });
  store.append({ id: 'c2', userId: 'u2', userName: 'Veli', text: 'naber', spokenText: '', status: 'skipped', reason: 'tekrar-yorum', at: 2000 });
  const written = store.flush();
  assert.equal(written, 2);
  const rows = readAll(store);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].userName, 'Ali');
  assert.equal(rows[0].status, 'spoken');
  assert.equal(rows[1].reason, 'tekrar-yorum');
  assert.equal(rows[1].at, 2000);
  rmSync(dir, { recursive: true, force: true });
});

test('append tamponludur: flush edilmeden dosya olusmaz', () => {
  const { dir, store } = tempStore();
  store.append({ id: 'c1', userId: 'u', userName: 'n', text: 'x', at: 1 });
  assert.equal(existsSync(store.filePath), false, 'flush oncesi dosya yazilmamali');
  store.flush();
  assert.equal(existsSync(store.filePath), true);
  rmSync(dir, { recursive: true, force: true });
});

test('kapaliyken append yazmaz, tampon da bosalir', () => {
  const { dir, store } = tempStore(100_000, false);
  assert.equal(store.append({ id: 'c1', text: 'x' }), false);
  store.flush();
  assert.equal(existsSync(store.filePath), false);
  // sonradan acilirsa yazmaya devam eder
  store.setEnabled(true);
  store.append({ id: 'c2', text: 'y' });
  store.flush();
  assert.equal(readAll(store).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('search: buyuk-kucuk duyarsiz, toplam sayar, en yeni limit tanesi doner', async () => {
  const { dir, store } = tempStore();
  for (let i = 0; i < 5; i += 1) {
    store.append({ id: `a${i}`, userName: 'Ali', text: `guzel sarki ${i}`, spokenText: '', status: 'spoken', at: i });
  }
  for (let i = 0; i < 3; i += 1) {
    store.append({ id: `b${i}`, userName: 'Veli', text: `BASKA konu ${i}`, spokenText: '', status: 'skipped', at: 100 + i });
  }
  store.flush();
  const r1 = await store.search('GÜZEL');
  assert.equal(r1.total, 5);
  assert.equal(r1.entries.length, 5);
  assert.equal(r1.entries[0].id, 'a4', 'en yeni once');
  const r2 = await store.search('baska', { limit: 2 });
  assert.equal(r2.total, 3);
  assert.equal(r2.entries.length, 2);
  assert.equal(r2.entries[0].id, 'b2', 'limit kesildiginde de en yeni once');
  const r3 = await store.search('yokboyle');
  assert.equal(r3.total, 0);
  assert.deepEqual(r3.entries, []);
  const r4 = await store.search('   ');
  assert.equal(r4.total, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('search: bozuk satirlari atlar, digerlerini okur', async () => {
  const { dir, store } = tempStore();
  store.append({ id: 'c1', userName: 'Ali', text: 'temiz kayit', status: 'spoken', at: 1 });
  store.flush();
  // dosyaya bilerek bozuk bir satir ekle
  const { appendFileSync } = await import('node:fs');
  appendFileSync(store.filePath, '{bozuk json satiri\n', 'utf8');
  store.append({ id: 'c2', userName: 'Ali', text: 'sonraki kayit', status: 'spoken', at: 2 });
  store.flush();
  const r = await store.search('kayit');
  assert.equal(r.total, 2);
  assert.equal(r.entries.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('trim: tavan asilirsa en yeni maxEntries kayit kalir', async () => {
  const { dir, store } = tempStore(10);
  for (let i = 0; i < 30; i += 1) {
    store.append({ id: `c${String(i).padStart(2, '0')}`, userName: 'u', text: `yorum ${i}`, status: 'spoken', at: i });
  }
  store.flush();
  const removed = await store.trim();
  assert.equal(removed, 20);
  const rows = readAll(store);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].id, 'c20', 'en eski 20 atilmis olmali');
  assert.equal(rows[9].id, 'c29');
  const removedAgain = await store.trim();
  assert.equal(removedAgain, 0, 'tavan icinde tekrar trim bir seye dokunmaz');
  rmSync(dir, { recursive: true, force: true });
});

test('clear: dosyayi ve tamponu tamamen siler', async () => {
  const { dir, store } = tempStore();
  store.append({ id: 'c1', userName: 'u', text: 'kaydedilecek', status: 'spoken', at: 1 });
  store.flush();
  assert.equal(existsSync(store.filePath), true);
  const result = store.clear();
  assert.equal(result.ok, true);
  assert.ok(result.removedBytes > 0);
  assert.equal(existsSync(store.filePath), false);
  const r = await store.search('kaydedilecek');
  assert.equal(r.total, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('arama kullanici adindan da bulur', async () => {
  const { dir, store } = tempStore();
  store.append({ id: 'c1', userName: 'Kamuran', text: 'selam', status: 'spoken', at: 1 });
  store.flush();
  const r = await store.search('kamuran');
  assert.equal(r.total, 1);
  assert.equal(r.entries[0].text, 'selam');
  rmSync(dir, { recursive: true, force: true });
});

test('arama turkce diakritik duyarsiz: sarki = şarkı, I = i', async () => {
  const { dir, store } = tempStore();
  store.append({ id: 'c1', userName: 'u', text: 'bu şarkıyı çok sevdim', status: 'spoken', at: 1 });
  store.append({ id: 'c2', userName: 'u', text: 'İstanbul güzel', status: 'spoken', at: 2 });
  store.flush();
  assert.equal((await store.search('sarki')).total, 1);
  assert.equal((await store.search('ŞARKI')).total, 1);
  assert.equal((await store.search('istanbul')).total, 1);
  assert.equal((await store.search('guzel')).total, 1);
  rmSync(dir, { recursive: true, force: true });
});
