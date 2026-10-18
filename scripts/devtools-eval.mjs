#!/usr/bin/env node
/**
 * Uygulamayi Chrome DevTools protokolu ile surer (test/otomasyon).
 *
 *   node scripts/devtools-eval.mjs "document.querySelectorAll('.comment').length"
 *
 * Electron `--remote-debugging-port=9222` ile baslatilmalidir.
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const expression = process.argv.slice(2).join(' ');
if (!expression) {
  console.error('kullanim: node scripts/devtools-eval.mjs "<ifade>"');
  process.exit(1);
}

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
  ?? targets.find((t) => t.type === 'page');
if (!page) {
  console.error('sayfa hedefi bulunamadi:', JSON.stringify(targets, null, 2));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const send = (method, params) => new Promise((resolve) => {
  id += 1;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const result = await send('Runtime.evaluate', {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true
});

ws.close();
if (result.result?.exceptionDetails) {
  console.error('HATA:', JSON.stringify(result.result.exceptionDetails.exception ?? result.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2));