// JMdict reference operator (CA-B1). Privileged admin connection only — never the
// runtime pool. Subcommands: import | verify | activate | rollback | prune |
// audit | status. See docs/jmdict-import.md for the full workflow.
//
// Usage:
//   node scripts/import-jmdict-reference.js status
//   node scripts/import-jmdict-reference.js import --file <path> [--expected-sha256 <hex>] [--activate] [--batch-size 500]
//   node scripts/import-jmdict-reference.js import --url <https-url> [--expected-sha256 <hex>] [--activate]
//   node scripts/import-jmdict-reference.js verify --source <id>
//   node scripts/import-jmdict-reference.js activate --source <id>
//   node scripts/import-jmdict-reference.js rollback
//   node scripts/import-jmdict-reference.js prune --source <id>
//   node scripts/import-jmdict-reference.js audit --source <id>
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const pool = require('../src/config/postgres');
const { assertExpectedDbTarget } = require('../../scripts/production-guard');
const {
  IMPORT_BATCH_SIZE,
  JmdictImportError,
  normalizeJmdictWord,
  allocateSnapshot,
  setSnapshotStatus,
  insertNormalizedBatch,
  verifySnapshot,
  auditSnapshot,
  activateSnapshot,
  rollbackSnapshot,
  pruneSnapshot,
  snapshotStatus,
  sha256Hex
} = require('../src/services/jmdictReference');

const CACHE_DIRECTORY = path.join(__dirname, '..', '.cache-jmdict');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new JmdictImportError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'activate') { options.activate = true; continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new JmdictImportError(`missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function downloadToFile(url, destination, hops = 0) {
  if (hops > 5) return Promise.reject(new JmdictImportError('too many redirects while downloading artifact'));
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(downloadToFile(response.headers.location, destination, hops + 1));
        return;
      }
      if (response.statusCode !== 200) {
        reject(new JmdictImportError(`artifact download failed with HTTP ${response.statusCode}`));
        return;
      }
      const writer = require('node:fs').createWriteStream(destination);
      response.pipe(writer);
      writer.on('finish', () => resolve(destination));
      writer.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveArtifactFile(options) {
  if (options.file) return path.resolve(options.file);
  if (options.url) {
    await fs.mkdir(CACHE_DIRECTORY, { recursive: true });
    const fileName = String(options.url.split('?')[0].split('/').pop() || 'jmdict-artifact.json');
    if (!fileName.endsWith('.json') && !fileName.endsWith('.tgz') && !fileName.endsWith('.gz')) {
      throw new JmdictImportError('only .json / .tgz artifacts are supported');
    }
    const destination = path.join(CACHE_DIRECTORY, fileName);
    console.error(`downloading artifact to ${destination}`);
    await downloadToFile(options.url, destination);
    if (destination.endsWith('.json')) return destination;
    throw new JmdictImportError('downloaded archives must be extracted first; re-run with --file pointing at the extracted .json');
  }
  throw new JmdictImportError('import requires --file <path> or --url <https-url>');
}

function readSourceDocument(rawText, filePath) {
  let document;
  try {
    document = JSON.parse(rawText);
  } catch {
    throw new JmdictImportError(`artifact is not valid JSON: ${filePath}`);
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.words)) {
    throw new JmdictImportError('artifact must be a jmdict-simplified document with a words array');
  }
  const converterVersion = typeof document.version === 'string' ? document.version : null;
  const fileDate = typeof document.dictDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(document.dictDate) ? document.dictDate : null;
  if (!converterVersion) throw new JmdictImportError('artifact is missing converter version; refusing untraceable snapshot');
  if (!fileDate) throw new JmdictImportError('artifact is missing a valid dictDate; refusing untraceable snapshot');
  return {
    converterVersion,
    fileDate,
    dictRevisions: Array.isArray(document.dictRevisions) ? document.dictRevisions.filter((value) => typeof value === 'string') : [],
    words: document.words
  };
}

async function importCommand(options) {
  const batchSize = options['batch-size'] ? Number(options['batch-size']) : IMPORT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new JmdictImportError('--batch-size must be an integer between 1 and 5000');
  }
  const artifactFile = await resolveArtifactFile(options);
  const artifactBytes = await fs.readFile(artifactFile);
  const sha256 = sha256Hex(artifactBytes);
  if (options['expected-sha256'] && options['expected-sha256'].toLowerCase() !== sha256) {
    throw new JmdictImportError(`checksum mismatch: expected ${options['expected-sha256']} but artifact hashes to ${sha256}`);
  }
  const source = readSourceDocument(artifactBytes.toString('utf8'), artifactFile);
  const client = await pool.connect();
  try {
    const { sourceId, reused } = await allocateSnapshot(client, {
      fileDate: source.fileDate,
      converterVersion: source.converterVersion,
      dictRevisions: source.dictRevisions,
      entCount: source.words.length,
      sha256,
      sha256Verified: Boolean(options['expected-sha256'])
    });
    if (reused) {
      console.error(`identical ready snapshot already exists; reusing source_id=${sourceId}`);
      if (options.activate) await activateSnapshot(client, sourceId);
      return { sourceId, reused: true, activated: Boolean(options.activate) };
    }
    console.error(`importing ${source.words.length} entries as source_id=${sourceId} (converter ${source.converterVersion}, dictDate ${source.fileDate})`);
    try {
      for (let offset = 0; offset < source.words.length; offset += batchSize) {
        const slice = source.words.slice(offset, offset + batchSize);
        const records = slice.map((word) => normalizeJmdictWord(word));
        await client.query('BEGIN');
        try {
          await insertNormalizedBatch(client, sourceId, records);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        if ((offset / batchSize) % 20 === 0) console.error(`progress: ${Math.min(offset + batchSize, source.words.length)}/${source.words.length} entries`);
      }
      await setSnapshotStatus(client, sourceId, 'validating', { entCount: source.words.length });
      const checks = await verifySnapshot(client, sourceId);
      const audit = await auditSnapshot(client, sourceId);
      await setSnapshotStatus(client, sourceId, 'ready', { entCount: source.words.length });
      if (options.activate) await activateSnapshot(client, sourceId);
      return { sourceId, reused: false, entries: source.words.length, checks, audit, activated: Boolean(options.activate) };
    } catch (error) {
      await setSnapshotStatus(client, sourceId, 'failed').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

async function main() {
  assertExpectedDbTarget({ host: process.env.POSTGRES_HOST, user: process.env.POSTGRES_USER, source: process.env.POSTGRES_ENV_FILE || '.env.postgres' });
  const { command, options } = parseArgs(process.argv.slice(2));
  const client = await pool.connect();
  try {
    switch (command) {
      case 'import': {
        client.release();
        console.log(JSON.stringify(await importCommand(options)));
        return;
      }
      case 'verify': {
        const sourceId = Number(options.source);
        if (!Number.isInteger(sourceId)) throw new JmdictImportError('verify requires --source <id>');
        console.log(JSON.stringify({ sourceId, checks: await verifySnapshot(client, sourceId) }));
        return;
      }
      case 'activate': {
        const sourceId = Number(options.source);
        if (!Number.isInteger(sourceId)) throw new JmdictImportError('activate requires --source <id>');
        await activateSnapshot(client, sourceId);
        console.log(JSON.stringify({ activated: sourceId }));
        return;
      }
      case 'rollback': {
        console.log(JSON.stringify(await rollbackSnapshot(client)));
        return;
      }
      case 'prune': {
        const sourceId = Number(options.source);
        if (!Number.isInteger(sourceId)) throw new JmdictImportError('prune requires --source <id>');
        await pruneSnapshot(client, sourceId);
        console.log(JSON.stringify({ pruned: sourceId }));
        return;
      }
      case 'audit': {
        const sourceId = Number(options.source);
        if (!Number.isInteger(sourceId)) throw new JmdictImportError('audit requires --source <id>');
        console.log(JSON.stringify(await auditSnapshot(client, sourceId), null, 2));
        return;
      }
      case 'status': {
        console.log(JSON.stringify(await snapshotStatus(client), null, 2));
        return;
      }
      default:
        throw new JmdictImportError(`unknown command: ${command || '(none)'}; expected import|verify|activate|rollback|prune|audit|status`);
    }
  } finally {
    if (command !== 'import') client.release();
  }
}

main()
  .catch((error) => {
    console.error('JMdict reference operation failed.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
