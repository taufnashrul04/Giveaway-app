'use strict';
// DB layer — SQLite via better-sqlite3
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'db');
const DB_FILE = path.join(DB_DIR, 'giveaway.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- SCHEMA ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  x_user_id     TEXT,              -- X (Twitter) OAuth user id
  x_username    TEXT,              -- @handle
  x_access_token TEXT,             -- OAuth2 token (hashed-ish, plaintext for MVP)
  dc_user_id    TEXT,              -- Discord user id
  dc_username   TEXT,              -- discord username
  dc_access_token TEXT,
  dc_guilds     TEXT,              -- JSON array of {id,name,member}
  wallet        TEXT,              -- user-pasted EVM/Tron/Solana address (for winner export)
  UNIQUE(x_user_id), UNIQUE(dc_user_id)
);
CREATE TABLE IF NOT EXISTS giveaways (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  description   TEXT,
  prize         TEXT,              -- e.g. "1 NFT whitelist"
  winners_count INTEGER NOT NULL DEFAULT 1,
  ends_at       TEXT,              -- UTC ISO; NULL = manual close
  status        TEXT NOT NULL DEFAULT 'open',  -- open|closed|drawn
  require_x_follow TEXT,           -- @handle users must follow
  require_x_repost TEXT,           -- post id to repost (optional)
  require_dc_guild TEXT            -- discord guild id to join (optional)
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
`);

// Migration: add wallet column if missing (existing DBs)
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('wallet')) {
  db.exec("ALTER TABLE users ADD COLUMN wallet TEXT");
}

module.exports = db;
