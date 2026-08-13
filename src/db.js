'use strict';
// DB layer — dual mode:
//   TURSO_URL + TURSO_AUTH_TOKEN set → Turso (libSQL, cloud, for Vercel/production)
//   otherwise → local SQLite (better-sqlite3, for dev)
//
// Uniform async API: db.all(sql, params), db.get(sql, params), db.run(sql, params)
// (better-sqlite3 is sync, wrapped in Promise; libSQL is async natively)

const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

let db;

if (TURSO_URL && TURSO_AUTH_TOKEN) {
  // ---- Turso (cloud) — use the WEB build (pure JS, works on Vercel/edge — no native binary) ----
  const { createClient } = require('@libsql/client/web');
  db = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
  // libSQL client has .execute({sql, args}) — wrap into all/get/run
  db._mode = 'turso';
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
} else {
  // ---- Local SQLite (dev) ----
  const path = require('path');
  const fs = require('fs');
  const DB_DIR = path.join(__dirname, '..', 'db');
  const DB_FILE = path.join(DB_DIR, 'giveaway.db');
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const Database = require('better-sqlite3');
  const local = new Database(DB_FILE);
  local.pragma('journal_mode = WAL');
  local.pragma('foreign_keys = ON');
  db = local;
  db._mode = 'sqlite';
  db.all = async (sql, params = []) => local.prepare(sql).all(...params);
  db.get = async (sql, params = []) => local.prepare(sql).get(...params);
  db.run = async (sql, params = []) => {
    const r = local.prepare(sql).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
  };
  db.exec = async (sql) => { local.exec(sql); };
}

// ---------- SCHEMA ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
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
);
CREATE TABLE IF NOT EXISTS giveaways (
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
);
CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id  INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  x_follow_ok  INTEGER NOT NULL DEFAULT 0,
  x_repost_ok  INTEGER NOT NULL DEFAULT 0,
  dc_ok        INTEGER NOT NULL DEFAULT 0,
  verified     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(giveaway_id, user_id)
);
CREATE TABLE IF NOT EXISTS winners (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id  INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drawn_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(giveaway_id, user_id)
);
`;

async function initSchema() {
  if (db._mode === 'turso') {
    // libSQL execute() doesn't allow multi-statement — run one statement at a time
    for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
      try { await db.execute({ sql: stmt }); } catch (e) { /* ignore already-exists */ }
    }
  } else {
    await db.exec(SCHEMA);
  }
  // migration: wallet column
  try {
    const cols = await db.all('PRAGMA table_info(users)');
    if (!cols.some(c => c.name === 'wallet')) {
      await db.exec('ALTER TABLE users ADD COLUMN wallet TEXT');
    }
  } catch (e) { /* ignore */ }
}

initSchema().catch(e => console.error('[db] schema init failed:', e.message));

module.exports = db;
