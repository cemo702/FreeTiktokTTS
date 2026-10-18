#!/usr/bin/env node
/**
 * TikTok baglanti tanisi (Electron olmadan).
 *
 *   node scripts/check-tiktok.mjs            # canli bir kanal bulur ve 25 sn dinler
 *   node scripts/check-tiktok.mjs kullanici  # belirtilen hesabi 25 sn dinler
 *
 * Yorumlari filtrelemeden once dogrudan gosterir (boru hatti testi).
 */
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

const SECONDS = Number(process.env.SECONDS || 25);
const log = (...a) => console.log('[tiktok]', ...a);

async function findLiveChannel() {
  const res = await fetch('https://api.tik.tools/api/live/top-channels');
  if (!res.ok) throw new Error(`top-channels HTTP ${res.status}`);
  const json = await res.json();
  const channel = (json.channels ?? [])[0];
  return channel?.uniqueId ?? null;
}

const username = process.argv[2]?.replace(/^@/, '') || (await findLiveChannel());
if (!username) {
  console.error('[tiktok] canli kanal bulunamadi ve kullanici adi verilmedi');
  process.exit(1);
}

log(`baglaniliyor: @${username}`);
const conn = new TikTokLiveConnection(username, { retryCount: 0 });

let comments = 0;
let gifts = 0;

conn.on(WebcastEvent.CHAT, (data) => {
  comments += 1;
  if (comments <= 10) {
    log(`[yorum] @${data.user?.displayId ?? "?"}: ${data.content ?? ""}`);
  }
});
conn.on(WebcastEvent.GIFT, (data) => {
  gifts += 1;
  if (gifts <= 5) log(`[hediye] ${data.gift?.name ?? data.gift?.describe ?? "?"} x${data.repeatCount}`);
});
conn.on(ControlEvent.CONNECTED, () => log('websocket baglantisi kuruldu'));
conn.on(ControlEvent.ERROR, (err) => log(`HATA: ${err?.message ?? err}`));

try {
  await conn.connect();
  log(`baglanildi! izleyici: ${conn.roomInfo?.data?.user_count ?? "?"} | oda: ${conn.roomInfo?.data?.title ?? "?"}`);
  const viewers = setInterval(() => log(`izleyici: ${conn.roomInfo?.data?.user_count ?? '?'}`), 10_000);
  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  clearInterval(viewers);
  log(`SONUC: ${comments} yorum, ${gifts} hediye alindi`);
  await conn.disconnect();
  process.exit(comments > 0 ? 0 : 3);
} catch (err) {
  log(`baglanilamadi: ${err?.message ?? err}`);
  process.exit(1);
}