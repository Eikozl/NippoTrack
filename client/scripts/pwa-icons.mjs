// Generates brand icons: hanko-orange tile with the white brush mark.
// Run: npm --prefix client run icons (writes client/public/icons/*.png +
// client/public/favicon.png). Source of truth stays the logo assets;
// generated files are committed so offline/Capacitor builds never depend
// on this script at build time. Manifest sizes/names are frozen (see
// public/manifest.webmanifest + pwa.test.mjs).
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const markSource = join(root, 'src', 'assets', 'logo-mark-light.png');
const outDir = join(root, 'public', 'icons');
const ORANGE = '#B64B00';

const roundedTile = (size, radius) => Buffer.from(
  `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${ORANGE}"/></svg>`
);
const flatTile = (size) => Buffer.from(
  `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${ORANGE}"/></svg>`
);

async function generate() {
  await stat(markSource);
  await mkdir(outDir, { recursive: true });
  const stamp = async (canvas, markPx) => {
    const mark = await sharp(markSource).resize(markPx, markPx, { fit: 'contain' }).toBuffer();
    return sharp(canvas).composite([{ input: mark, gravity: 'center' }]).png().toBuffer();
  };
  // Standard installable icons: full-bleed orange, white mark.
  const tile512 = await stamp(flatTile(512), 400);
  await sharp(tile512).toFile(join(outDir, 'icon-512.png'));
  await sharp(tile512).resize(192, 192).toFile(join(outDir, 'icon-192.png'));
  // Maskable: artwork inside the ~70% safe circle on solid orange.
  const maskable = await stamp(flatTile(512), 358);
  await sharp(maskable).toFile(join(outDir, 'icon-maskable-512.png'));
  const maskable192 = await stamp(flatTile(192), 134);
  await sharp(maskable192).toFile(join(outDir, 'icon-maskable-192.png'));
  // iOS home-screen icon (plain PNG, referenced from index.html).
  await sharp(tile512).resize(180, 180).toFile(join(outDir, 'apple-touch-icon.png'));
  // Favicon: rounded orange tile with the white mark (tab-grade).
  const favicon = await stamp(roundedTile(180, 40), 132);
  await sharp(favicon).toFile(join(root, 'public', 'favicon.png'));
  console.log('Brand icons written to client/public/icons/ + favicon.png');
}

generate().catch((error) => { console.error(error.message); process.exitCode = 1; });
