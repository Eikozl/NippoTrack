// Step 1 of KanjiVG vendoring: parse KANJIDIC2 grades -> joyo hex list.
// Step 2 (powershell): Expand-Archive the KanjiVG zip, copy listed SVGs.
// Step 3 here: verify files, write allowlist module + attribution.
//
// Provenance:
// - KanjiVG r20250816 `kanjivg-20250816-main.zip` (CC BY-SA 3.0,
//   https://github.com/KanjiVG/kanjivg/releases/tag/r20250816).
// - KANJIDIC2 `kanjidic2.xml.gz` (EDRDG): grade 1-6 kyōiku + grade 8
//   remaining jōyō => jōyō set; grades 9-10 (jinmeiyō) excluded.
'use strict';
const { createGunzip } = require('node:zlib');
const { createReadStream, promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');

const vendorDir = join(tmpdir(), 'kanjivg-vendor');
const repoRoot = join(__dirname, '..');
const EXPECTED = 2136;

(async () => {
  const chunks = [];
  await pipeline(
    createReadStream(join(vendorDir, 'kanjidic2.xml.gz')),
    createGunzip(),
    async function* (source) { for await (const c of source) chunks.push(c); }
  );
  const xml = Buffer.concat(chunks).toString('utf8');
  const joyo = new Set();
  for (const block of xml.match(/<character>[\s\S]*?<\/character>/g) || []) {
    const lit = block.match(/<literal>([^<]*)<\/literal>/);
    const g = block.match(/<grade>(\d+)<\/grade>/);
    if (lit && g && +g[1] >= 1 && +g[1] <= 8) joyo.add(lit[1].codePointAt(0));
  }
  console.log('JOYO COUNT', joyo.size);
  if (joyo.size !== EXPECTED) throw new Error('unexpected joyo count — abort');
  const hexes = [...joyo].map((cp) => cp.toString(16).padStart(5, '0')).sort();
  await fs.writeFile(join(vendorDir, 'joyo-hex.txt'), hexes.join('\n'));
  // Ranges for the compact allowlist module.
  const cps = [...joyo].sort((a, b) => a - b);
  const ranges = [];
  let s = cps[0], p = cps[0];
  for (const cp of cps.slice(1)) {
    if (cp === p + 1) { p = cp; continue; }
    ranges.push([s, p]); s = cp; p = cp;
  }
  ranges.push([s, p]);
  console.log('RANGES', ranges.length);
  await fs.writeFile(join(vendorDir, 'joyo-ranges.json'), JSON.stringify(ranges));
  console.log('wrote joyo-hex.txt + joyo-ranges.json');
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
