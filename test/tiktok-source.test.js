import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebcastEvent } from 'tiktok-live-connector';
import { normalizeViewerCount, TikTokSource } from '../src/main/tiktok-source.js';

test('normalizeViewerCount: sayi ve sayisal metin kabul edilir', () => {
  assert.equal(normalizeViewerCount(129), 129);
  assert.equal(normalizeViewerCount('129'), 129);
  assert.equal(normalizeViewerCount(' 129 '), 129);
  assert.equal(normalizeViewerCount(129.7), 129);
  assert.equal(normalizeViewerCount({ high: 0, low: 5 }), 5);
});

test('normalizeViewerCount: gecersiz degerler bilinmiyor sayilir', () => {
  for (const value of [null, undefined, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY, -1, '-5', {}, { popularity: '999' }]) {
    assert.equal(normalizeViewerCount(value), null);
  }
});

class FakeTikTokConnection extends EventEmitter {
  constructor(roomInfo) {
    super();
    this.roomInfo = roomInfo;
  }

  async connect() {}

  async disconnect() {}

  async fetchRoomInfo() {
    return this.roomInfo;
  }
}

test('TikTokSource: ROOM_USER olayindaki total sayaci durumu gunceller', async () => {
  const connection = new FakeTikTokConnection({ data: { user_count: '12' } });
  const source = new TikTokSource({ createConnection: () => connection });
  const statuses = [];
  source.on('status', (status) => statuses.push(status));

  await source.start('kanal');
  assert.equal(source.getStatus().viewerCount, 12);

  connection.emit(WebcastEvent.ROOM_USER, { total: '15', totalUser: '330' });
  assert.equal(source.getStatus().viewerCount, 15);

  const emitted = statuses.length;
  connection.emit(WebcastEvent.ROOM_USER, { total: '15', totalUser: '331' });
  assert.equal(statuses.length, emitted);

  await source.stop();
  assert.equal(source.getStatus().status, 'kapali');
  assert.equal(source.getStatus().viewerCount, null);
});

test('TikTokSource: kumule totalUser alani anlik izleyici olarak kullanilmaz', async () => {
  const connection = new FakeTikTokConnection({ data: { user_count: '6' } });
  const source = new TikTokSource({ createConnection: () => connection });

  await source.start('kanal');
  connection.emit(WebcastEvent.ROOM_USER, { total: '6', totalUser: '330' });
  assert.equal(source.getStatus().viewerCount, 6);

  await source.stop();
});
