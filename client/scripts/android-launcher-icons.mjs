// Generates branded Android launcher icons from the PWA artwork so the
// installed APK never shows the default Capacitor robot. Run after
// client/scripts/pwa-icons.mjs changes the logo treatment:
//   node client/scripts/android-launcher-icons.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { join } = require('node:path');

const root = join(process.cwd(), 'client');
const maskable512 = join(root, 'public', 'icons', 'icon-maskable-512.png');
const out = (density) => join(root, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

async function generate() {
  for (const [density, size] of Object.entries(DENSITIES)) {
    const dir = out(density);
    // Full-bleed legacy icon + round variant.
    await sharp(maskable512).resize(size, size).png().toFile(join(dir, 'ic_launcher.png'));
    await sharp(maskable512).resize(size, size).png().toFile(join(dir, 'ic_launcher_round.png'));
    // Adaptive foreground: artwork inside the safe zone (same 70% treatment
    // as the maskable PWA icon, whose source already carries it).
    await sharp(maskable512).resize(size, size).png().toFile(join(dir, 'ic_launcher_foreground.png'));
  }
  console.log('Android launcher icons regenerated from the maskable artwork.');
}

generate().catch((error) => { console.error(error.message); process.exitCode = 1; });
