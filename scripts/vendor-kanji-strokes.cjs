// KanjiVG vendoring audit for the r20250816 canonical, non-variant release.
//
// Source archive:
// https://github.com/KanjiVG/kanjivg/releases/download/r20250816/kanjivg-20250816-main.zip
//
// Extract the archive, copy only `kanji/<five lowercase hex digits>.svg` into
// client/public/stroke/kanji, then run this script and
// scripts/generate-stroke-asset-index.cjs. Filename variants are deliberately
// out of scope: this app supports only the release's canonical filename set.
'use strict';

const { readdir } = require('node:fs/promises');
const { join } = require('node:path');

const assetDirectory = join(__dirname, '..', 'client', 'public', 'stroke', 'kanji');
const canonicalFilename = /^[0-9a-f]{5}\.svg$/;
const EXPECTED_CANONICAL_ASSET_COUNT = 6702;

async function main() {
  const files = await readdir(assetDirectory);
  const canonical = files.filter((filename) => canonicalFilename.test(filename));
  const malformed = files.filter((filename) => filename.endsWith('.svg') && !canonicalFilename.test(filename));

  if (canonical.length !== EXPECTED_CANONICAL_ASSET_COUNT || malformed.length) {
    throw new Error(`Expected ${EXPECTED_CANONICAL_ASSET_COUNT} canonical SVGs and no variants; found ${canonical.length} canonical and ${malformed.length} malformed.`);
  }

  console.log(`Verified ${canonical.length} canonical KanjiVG r20250816 SVGs.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
