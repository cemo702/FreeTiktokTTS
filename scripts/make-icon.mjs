/**
 * Uygulama ikonunu uretir: build/icon.svg -> build/icon.png (512x512).
 * Ikonun KAYNAGI icon.svg'dir; gorsel degisiklik orada yapilip bu betik
 * yeniden kosturulur. electron-builder .png'den .ico'yi otomatik turetir.
 *
 * Kullanim: node scripts/make-icon.mjs  (npm install sonrasi)
 */
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const svg = path.resolve(__dirname, '..', 'build', 'icon.svg');
const out = path.resolve(__dirname, '..', 'build', 'icon.png');

await sharp(svg).png().toFile(out);
console.log('ikon uretildi:', out);
