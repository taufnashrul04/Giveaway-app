'use strict';
// DB layer — Turso (cloud, SQLite-compatible) via @libsql/client/web (pure JS, no native binary).
// Requires TURSO_URL + TURSO_AUTH_TOKEN.
//
// Uniform async API: db.all(sql, params), db.get(sql, params), db.run(sql, params)
//
// NOTE: NO native modules (no better-sqlite3). This is intentional so the app
// builds cleanly on Vercel/edge runtimes. Local dev uses the same Turso DB.

const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.error('[db] FATAL: TURSO_URL and TURSO_AUTH_TOKEN must be set (GiveFuel uses Turso cloud DB).');
  process.exit(1);
}

const { createClient } = require('@libsql/client/web');
const db = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
db._mode = 'turso';

// libSQL client exposes .execute({sql, args}) — wrap into all/get/run
db.all = async (sql, params = []) => {
  const r = await db.execute({ sql, args: params });
  return r.rows;
};
db.get = async (sql, params = []) => {
  const r = await db.execute({ sql, args: params });
  return r.rows[0] || null;
};
db.run = async (sql, params = []) => {
  const r = await db.execute({ sql, args: params });
  return { lastInsertRowid: Number(r.lastInsertRowid || 0), changes: r.rowsAffected };
};
db.exec = async (sql) => { await db.execute({ sql }); };

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
  require_dc_guild TEXT
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
];

async function initSchema() {
  // libSQL execute() doesn't allow multi-statement — run one at a time
  for (const stmt of SCHEMA) {
    try { await db.execute({ sql: stmt }); } catch (e) { /* ignore already-exists */ }
  }
  // migration: wallet column
  try {
    const cols = await db.all('PRAGMA table_info(users)');
    if (!cols.some(c => c.name === 'wallet')) {
      await db.execute({ sql: 'ALTER TABLE users ADD COLUMN wallet TEXT' });
    }
  } catch (e) { /* ignore */ }
}

initSchema().catch(e => console.error('[db] schema init failed:', e.message));

module.exports = db;
