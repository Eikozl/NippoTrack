const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'jlt_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'test-only';
process.env.DB_NAME = process.env.DB_NAME || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');

test.after(async () => {
  await pool.end();
});

async function startServer() {
  const server = app.listen(0);

  await new Promise((resolve) => {
    server.once('listening', resolve);
  });

  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withPoolStubs(stubs, callback) {
  const originals = {};

  for (const [method, replacement] of Object.entries(stubs)) {
    originals[method] = pool[method];
    pool[method] = replacement;
  }

  try {
    await callback();
  } finally {
    for (const [method, original] of Object.entries(originals)) {
      pool[method] = original;
    }
  }
}

async function postJson(server, path, payload, method = 'POST') {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

test('GET /api/health returns a valid JSON response', async () => {
  await withPoolStubs({
    query: async () => [[{ database_name: 'jlt' }]]
  }, async () => {
    const server = await startServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
      const data = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(data, { ok: true, status: 'healthy', database: 'jlt' });
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/study-sessions validates required fields', async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/study-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_minutes: 30 })
    });

    const data = await response.json();

    assert.equal(response.status, 400);
    assert.match(data.error, /session_date|category/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('GET /api/study-sessions/999 returns 404 when the record does not exist', async () => {
  await withPoolStubs({
    execute: async () => [[]]
  }, async () => {
    const server = await startServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/study-sessions/999999`);
      const data = await response.json();

      assert.equal(response.status, 404);
      assert.equal(data.error, 'study session not found');
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/vocabulary rejects invalid status values', async () => {
  const server = await startServer();
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/vocabulary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: 'テスト', meaning: 'test', status: 'Invalid' })
    });

    const data = await response.json();

    assert.equal(response.status, 400);
    assert.match(data.error, /status/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('POST /api/study-sessions strictly validates relationship arrays before opening a transaction', async () => {
  let connectionRequested = false;

  await withPoolStubs({
    getConnection: async () => {
      connectionRequested = true;
      throw new Error('A connection must not be requested for invalid input');
    }
  }, async () => {
    const server = await startServer();

    try {
      const response = await postJson(server, '/api/study-sessions', {
        session_date: '2026-08-29',
        duration_minutes: 30,
        category: 'Vocabulary',
        vocabulary_ids: [1, 0, '2']
      });
      const data = await response.json();

      assert.equal(response.status, 400);
      assert.match(data.error, /vocabulary_ids.*positive integer/i);
      assert.equal(connectionRequested, false);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/study-sessions writes all N:M relationships atomically and de-duplicates IDs', async () => {
  const statements = [];
  let committed = false;
  let rolledBack = false;
  let released = false;

  const connection = {
    async beginTransaction() {
      statements.push({ sql: 'BEGIN', params: [] });
    },
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('INSERT INTO study_sessions')) {
        return [{ insertId: 41 }];
      }
      return [{ affectedRows: 1 }];
    },
    async commit() {
      committed = true;
    },
    async rollback() {
      rolledBack = true;
    },
    release() {
      released = true;
    }
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql, params) => {
      assert.match(sql, /FROM study_sessions WHERE id_session = \?/);
      assert.deepEqual(params, [41]);
      return [[{
        id_session: 41,
        session_date: '2026-08-29',
        duration_minutes: 45,
        category: 'Mixed',
        resource: null,
        notes: null
      }]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const response = await postJson(server, '/api/study-sessions', {
        session_date: '2026-08-29',
        duration_minutes: 45,
        category: 'Mixed',
        vocabulary_ids: [3, 3, 4],
        kanji_ids: [5],
        grammar_ids: [6]
      });

      assert.equal(response.status, 201);
      assert.equal(committed, true);
      assert.equal(rolledBack, false);
      assert.equal(released, true);

      const vocabularyWrites = statements.filter(({ sql }) => sql.startsWith('INSERT INTO session_vocabulary'));
      const kanjiWrites = statements.filter(({ sql }) => sql.startsWith('INSERT INTO session_kanji'));
      const grammarWrites = statements.filter(({ sql }) => sql.startsWith('INSERT INTO session_grammar'));

      assert.deepEqual(vocabularyWrites.map(({ params }) => params), [[41, 3], [41, 4]]);
      assert.deepEqual(kanjiWrites.map(({ params }) => params), [[41, 5]]);
      assert.deepEqual(grammarWrites.map(({ params }) => params), [[41, 6]]);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/study-sessions rolls back the parent insert when a relationship insert fails', async () => {
  let committed = false;
  let rolledBack = false;
  let released = false;
  let postCommitRead = false;

  const connection = {
    async beginTransaction() {},
    async execute(sql) {
      if (sql.startsWith('INSERT INTO study_sessions')) {
        return [{ insertId: 42 }];
      }

      const error = new Error('Raw foreign-key details must not be returned');
      error.code = 'ER_NO_REFERENCED_ROW_2';
      throw error;
    },
    async commit() {
      committed = true;
    },
    async rollback() {
      rolledBack = true;
    },
    release() {
      released = true;
    }
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => {
      postCommitRead = true;
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const response = await postJson(server, '/api/study-sessions', {
        session_date: '2026-08-29',
        duration_minutes: 20,
        category: 'Kanji',
        kanji_ids: [999999]
      });

      assert.equal(response.status, 400);
      const data = await response.json();
      assert.equal(committed, false);
      assert.equal(rolledBack, true);
      assert.equal(released, true);
      assert.equal(postCommitRead, false);
      assert.equal(data.error, 'One or more related records do not exist.');
      assert.doesNotMatch(data.error, /foreign-key|raw/i);
    } finally {
      await stopServer(server);
    }
  });
});

test('duplicate kanji and grammar writes return safe 409 conflicts', async () => {
  const duplicateError = new Error('Duplicate entry exposes a constraint name');
  duplicateError.code = 'ER_DUP_ENTRY';

  await withPoolStubs({
    execute: async () => {
      throw duplicateError;
    }
  }, async () => {
    const server = await startServer();

    try {
      const kanjiResponse = await postJson(server, '/api/kanji', {
        character_kanji: '日',
        meaning: 'day'
      });
      const kanjiData = await kanjiResponse.json();
      assert.equal(kanjiResponse.status, 409);
      assert.equal(kanjiData.error, 'Kanji already exists.');

      const grammarResponse = await postJson(server, '/api/grammar', {
        grammar_point: '〜ている',
        meaning: 'ongoing action'
      });
      const grammarData = await grammarResponse.json();
      assert.equal(grammarResponse.status, 409);
      assert.equal(grammarData.error, 'Grammar point already exists.');
    } finally {
      await stopServer(server);
    }
  });
});

test('unknown database errors are logged but never returned to clients', async () => {
  const privateMessage = 'connect ECONNREFUSED db.internal.local as root';
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);

  try {
    await withPoolStubs({
      execute: async () => {
        throw new Error(privateMessage);
      }
    }, async () => {
      const server = await startServer();

      try {
        const response = await postJson(server, '/api/vocabulary', {
          word: '安全',
          meaning: 'safety'
        });
        const data = await response.json();

        assert.equal(response.status, 500);
        assert.equal(data.error, 'Unable to create vocabulary entry.');
        assert.doesNotMatch(JSON.stringify(data), /ECONNREFUSED|root|internal/i);
        assert.equal(logged.some((args) => args.some((value) => String(value).includes(privateMessage))), true);
      } finally {
        await stopServer(server);
      }
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('Helmet CSP permits the external frontend script without unsafe inline JavaScript', async () => {
  const server = await startServer();

  try {
    const pageResponse = await fetch(`http://127.0.0.1:${server.address().port}/api`);
    const html = fs.readFileSync(path.join(__dirname, '../../client/index.html'), 'utf8');
    const csp = pageResponse.headers.get('content-security-policy');
    const scriptDirective = csp
      ?.split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));

    assert.equal(pageResponse.status, 200);
    assert.match(html, /<script type="module" src="\/src\/main\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>(?![\s\S]*<\/script>)/);
    assert.match(scriptDirective || '', /'self'/);
    assert.doesNotMatch(scriptDirective || '', /'unsafe-inline'/);
  } finally {
    await stopServer(server);
  }
});

test('GET /api/sessions/:id includes optional structured writing with existing V1 relationships', async () => {
  await withPoolStubs({
    execute: async (sql) => {
      if (sql.includes('FROM study_sessions')) {
        return [[{
          id_session: 21,
          session_date: '2026-08-30',
          duration_minutes: 30,
          category: 'Writing',
          resource: 'Notebook',
          notes: null
        }]];
      }
      if (sql.includes('FROM session_writings')) {
        return [[{ id_session_writing: 4, title: 'Practice', content: '日本語を書きます。', notes: null }]];
      }
      return [[]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/21`);
      const data = await response.json();

      assert.equal(response.status, 200);
      assert.equal(data.writing.id_session_writing, 4);
      assert.equal(data.writing.content, '日本語を書きます。');
      assert.deepEqual(data.vocabulary, []);
      assert.deepEqual(data.kanji, []);
      assert.deepEqual(data.grammar, []);
    } finally {
      await stopServer(server);
    }
  });
});
