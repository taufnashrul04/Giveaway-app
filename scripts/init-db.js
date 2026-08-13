'use strict';
// init-db — verify Turso connection + schema. Requires TURSO_URL + TURSO_AUTH_TOKEN.
const db = require('../src/db');
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  console.log('GiveFuel DB (Turso) — tables:', tables.map(t => t.name).join(', '));
})().catch(e => { console.error('init-db failed:', e.message); process.exit(1); });
