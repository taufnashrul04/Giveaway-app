'use strict';
// DB layer — Turso via raw HTTP REST API (hrana /v2 pipeline). 
// NO native modules, NO @libsql/client, NO build scripts → builds clean on Vercel.
// Requires TURSO_URL (libsql://<name>.<region>.turso.io) + TURSO_AUTH_TOKEN.
//
// Uniform async API: db.all(sql, params), db.get(sql, params), db.run(sql, params)

const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.error('[db] FATAL: TURSO_URL and TURSO_AUTH_TOKEN must be set (GiveFuel uses Turso cloud DB).');
  process.exit(1);
}

// convert libsql://host → https://host
const host = TURSO_URL.replace(/^libsql:\/\//, '').replace(/\/.*$/, '');
const HTTP_URL = `https://${host}`;

// Encode a JS value into a Turso HRANA value
function encodeVal(v, isExpr = false) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return { type: 'integer', value: String(Math.trunc(v)) };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number' && !Number.isInteger(v)) return { type: 'float', value: v };
  if (typeof v === 'boolean') return { type: isExpr ? (v ? 'true' : 'false') : 'integer', value: isExpr ? undefined : (v ? '1' : '0') };
  return { type: 'text', value: String(v) };
}

// Bind ? args into the statement
function bindParams(sql, params) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return String(sql).replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
  });
}

async function execPipeline(requests) {
  const res = await fetch(`${HTTP_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Turso HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return (await res.json()).results || [];
}

function parseRow(cols, row) {
  const obj = {};
  (cols || []).forEach((c, i) => {
    const v = (row || [])[i];
    obj[c.name] = v ? v.value : null;
  });
  return obj;
}

function parseExecuteResult(resp) {
  const cols = resp.cols || [];
  const rows = (resp.rows || []).map(r => parseRow(cols, r));
  return {
    rows,
    lastInsertRowid: resp.last_insert_rowid != null ? Number(resp.last_insert_rowid) : 0,
    affectedRowCount: resp.affected_row_count || 0,
  };
}

let _baton = null;

async function execute({ sql, args = [] }) {
  const finalSql = bindParams(sql, args);
  const results = await execPipeline([
    { type: 'execute', stmt: { sql: finalSql }, step: 0 },
    { type: 'close' },
  ]);
  const r = results[0];
  if (r.type !== 'ok') throw new Error('Turso execute failed: ' + JSON.stringify(r));
  return parseExecuteResult(r.response.result);
}

const db = {
  _mode: 'turso',
  execute,
  async all(sql, params = []) {
    const r = await execute({ sql, args: params });
    return r.rows;
  },
  async get(sql, params = []) {
    const r = await execute({ sql, args: params });
    return r.rows[0] || null;
  },
  async run(sql, params = []) {
    const r = await execute({ sql, args: params });
    return { lastInsertRowid: r.lastInsertRowid, changes: r.affectedRowCount };
  },
  async exec(sql) {
    await execute({ sql });
  },
};

// ---------- SCHEMA ----------
const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  x_user_id     TEXT,
  x_username    TEXT,
  x_access_token TEXT,
  dc_user_id    TEXT,
  dc_username   TEXT,
  dc_access_token TEXT,
  dc_guilds     TEXT,
  wallet        TEXT,
  UNIQUE(x_user_id), UNIQUE(dc_user_id)
)`,
`CREATE TABLE IF NOT EXISTS giveaways (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  description   TEXT,
  prize         TEXT,
  winners_count INTEGER NOT NULL DEFAULT 1,
  ends_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  require_x_follow TEXT,
  require_x_repost TEXT,
  require_dc_guild TEXT,
  tasks         TEXT
)`,
`CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id  INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  x_follow_ok  INTEGER NOT NULL DEFAULT 0,
  x_repost_ok  INTEGER NOT NULL DEFAULT 0,
  dc_ok        INTEGER NOT NULL DEFAULT 0,
  verified     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(giveaway_id, user_id)
)`,
`CREATE TABLE IF NOT EXISTS winners (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id  INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drawn_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(giveaway_id, user_id)
)`,
`CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  slug          TEXT,
  description   TEXT,
  type          TEXT NOT NULL DEFAULT 'nft',   -- dao | nft | community
  website       TEXT,
  twitter       TEXT,
  discord       TEXT,
  logo          TEXT,
  UNIQUE(name)
)`,
`CREATE TABLE IF NOT EXISTS project_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, user_id)
)`,
];

async function initSchema() {
  for (const stmt of SCHEMA) {
    try { await execute({ sql: stmt }); } catch (e) { /* ignore already-exists */ }
  }
  // migration: wallet column
  try {
    const cols = await db.all('PRAGMA table_info(users)');
    if (!cols.some(c => c.name === 'wallet')) {
      await execute({ sql: 'ALTER TABLE users ADD COLUMN wallet TEXT' });
    }
  } catch (e) { /* ignore */ }
  // migration: giveaways.project_id
  try {
    const gcols = await db.all('PRAGMA table_info(giveaways)');
    if (!gcols.some(c => c.name === 'project_id')) {
      await execute({ sql: 'ALTER TABLE giveaways ADD COLUMN project_id INTEGER' });
    }
  } catch (e) { /* ignore */ }
  // migration: giveaways.tasks (JSON)
  try {
    const gcols2 = await db.all('PRAGMA table_info(giveaways)');
    if (!gcols2.some(c => c.name === 'tasks')) {
      await execute({ sql: 'ALTER TABLE giveaways ADD COLUMN tasks TEXT' });
    }
  } catch (e) { /* ignore */ }
}

initSchema().catch(e => console.error('[db] schema init failed:', e.message));

module.exports = db;
