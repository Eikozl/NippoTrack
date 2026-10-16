// Generates PWA icons from client/src/assets/logo-mark.png (brand brush mark).
// Run: npm --prefix client run icons (writes client/public/icons/*.png).
// Source of truth stays the logo asset; generated files are committed so
// offline/Capacitor builds never depend on this script at build time.
// Artwork flattens onto the washi paper tone to match the manifest
// background; the mark itself stays pure ink.
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'assets', 'logo-mark.png');
const outDir = join(root, 'public', 'icons');
const PAPER = '#F5F0E8';

async function generate() {
  await stat(source);
  await mkdir(outDir, { recursive: true });
  const base = sharp(source).flatten({ background: PAPER });
  // Standard installable icons.
  await base.clone().resize(192, 192, { fit: 'contain', background: PAPER }).png().toFile(join(outDir, 'icon-192.png'));
  await base.clone().resize(512, 512, { fit: 'contain', background: PAPER }).png().toFile(join(outDir, 'icon-512.png'));
  // Maskable: artwork inside the ~70% safe circle on a solid background.
  const inner = await sharp(source).resize(358, 358, { fit: 'contain' }).toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: PAPER } })
    .composite([{ input: inner, gravity: 'center' }])
    .png().toFile(join(outDir, 'icon-maskable-512.png'));
  const inner192 = await sharp(source).resize(134, 134, { fit: 'contain' }).toBuffer();
  await sharp({ create: { width: 192, height: 192, channels: 4, background: PAPER } })
    .composite([{ input: inner192, gravity: 'center' }])
    .png().toFile(join(outDir, 'icon-maskable-192.png'));
  // iOS home-screen icon (plain PNG, referenced from index.html).
  await base.clone().resize(180, 180, { fit: 'contain', background: PAPER }).png().toFile(join(outDir, 'apple-touch-icon.png'));
  console.log('PWA icons written to client/public/icons/');
}

generate().catch((error) => { console.error(error.message); process.exitCode = 1; });
