'use strict';
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const helmet = require('helmet');

const db = require('./db');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// view helper: current session user
app.use((req, res, next) => {
  if (req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
    res.locals.currentUser = u || null;
    if (!u) req.session.userId = null;
  } else {
    res.locals.currentUser = null;
  }
  next();
});

// ---- AUTH ROUTES ----
const x = require('../lib/x');
const discord = require('../lib/discord');

app.get('/auth/x/login', (req, res) => res.redirect(x.buildAuthorizeUrl()));
app.get('/auth/x/callback', async (req, res) => {
  try {
    const info = await x.exchangeCode(req.query.code, req.query.state);
    let u = db.prepare('SELECT * FROM users WHERE x_user_id=?').get(info.x_user_id);
    if (u) {
      db.prepare('UPDATE users SET x_username=?, x_access_token=? WHERE id=?')
        .run(info.x_username, info.x_access_token, u.id);
    } else {
      const r = db.prepare('INSERT INTO users (x_user_id, x_username, x_access_token) VALUES (?,?,?)')
        .run(info.x_user_id, info.x_username, info.x_access_token);
      u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    }
    req.session.userId = u.id;
    res.redirect('/?connected=x');
  } catch (e) {
    res.status(500).send('X auth failed: ' + e.message);
  }
});
app.get('/auth/x/mock', async (req, res) => {
  const info = await x.exchangeCode('testcode', 'mockstate');
  let u = db.prepare('SELECT * FROM users WHERE x_user_id=?').get(info.x_user_id);
  if (u) {
    db.prepare('UPDATE users SET x_username=?, x_access_token=? WHERE id=?').run(info.x_username, info.x_access_token, u.id);
  } else {
    const r = db.prepare('INSERT INTO users (x_user_id, x_username, x_access_token) VALUES (?,?,?)').run(info.x_user_id, info.x_username, info.x_access_token);
    u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  }
  req.session.userId = u.id;
  res.redirect('/?connected=x');
});

app.get('/auth/dc/login', (req, res) => res.redirect(discord.buildAuthorizeUrl()));
app.get('/auth/dc/callback', async (req, res) => {
  try {
    const info = await discord.exchangeCode(req.query.code);
    if (!req.session.userId) {
      let u = db.prepare('SELECT * FROM users WHERE dc_user_id=?').get(info.dc_user_id);
      if (!u) { const r = db.prepare('INSERT INTO users (dc_user_id, dc_username, dc_access_token, dc_guilds) VALUES (?,?,?,?)').run(info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds)); u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid); }
      else db.prepare('UPDATE users SET dc_username=?, dc_access_token=?, dc_guilds=? WHERE id=?').run(info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds), u.id);
      req.session.userId = u.id;
    } else {
      db.prepare('UPDATE users SET dc_user_id=?, dc_username=?, dc_access_token=?, dc_guilds=? WHERE id=?')
        .run(info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds), req.session.userId);
    }
    res.redirect('/?connected=dc');
  } catch (e) { res.status(500).send('Discord auth failed: ' + e.message); }
});
app.get('/auth/dc/mock', async (req, res) => {
  const info = await discord.exchangeCode('testcode');
  if (!req.session.userId) {
    const r = db.prepare('INSERT INTO users (dc_user_id, dc_username, dc_access_token, dc_guilds) VALUES (?,?,?,?)').run(info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds));
    req.session.userId = r.lastInsertRowid;
  } else {
    db.prepare('UPDATE users SET dc_user_id=?, dc_username=?, dc_access_token=?, dc_guilds=? WHERE id=?').run(info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds), req.session.userId);
  }
  res.redirect('/?connected=dc');
});

app.get('/api/me', (req, res) => {
  const u = res.locals.currentUser;
  res.json(u ? {
    id: u.id,
    x_username: u.x_username,
    dc_username: u.dc_username,
    dc_guilds: JSON.parse(u.dc_guilds || '[]'),
  } : null);
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// ---- GIVEAWAY ROUTES ----
app.get('/api/giveaways', (req, res) => {
  const rows = db.prepare(`SELECT g.*, u.x_username AS host
    FROM giveaways g LEFT JOIN users u ON u.id=g.created_by
    ORDER BY g.created_at DESC`).all();
  res.json(rows.map(r => ({ ...r, entry_count: db.prepare('SELECT COUNT(*) c FROM entries WHERE giveaway_id=?').get(r.id).c })));
});

app.get('/api/giveaways/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const winnerRows = db.prepare(`SELECT w.*, u.x_username, u.dc_username FROM winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=?`).all(g.id);
  res.json({ ...g, winners: winnerRows });
});

// Create giveaway (any logged-in user can create → admin-ish for MVP)
app.post('/api/giveaways', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const { title, description, prize, winners_count, ends_at, require_x_follow, require_x_repost, require_dc_guild } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const r = db.prepare(`INSERT INTO giveaways
    (created_by,title,description,prize,winners_count,ends_at,require_x_follow,require_x_repost,require_dc_guild)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.session.userId, title, description||'', prize||'', parseInt(winners_count)||1, ends_at||null, require_x_follow||null, require_x_repost||null, require_dc_guild||null);
  res.json({ id: r.lastInsertRowid, ok: true });
});

// Enter a giveaway — verifies all tasks
app.post('/api/giveaways/:id/enter', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.status !== 'open') return res.status(400).json({ error: 'giveaway closed' });
  const u = res.locals.currentUser;

  let x_follow_ok = !g.require_x_follow;   // no req → auto pass
  let x_repost_ok = !g.require_x_repost;
  let dc_ok = !g.require_dc_guild;

  if (g.require_x_follow && u.x_access_token) {
    try { x_follow_ok = await x.checkFollow(u.x_access_token, g.require_x_follow); } catch (e) { x_follow_ok = false; }
  } else if (g.require_x_follow) { x_follow_ok = false; }

  if (g.require_dc_guild) dc_ok = discord.isMember(JSON.parse(u.dc_guilds || '[]'), g.require_dc_guild);

  const verified = (x_follow_ok && x_repost_ok && dc_ok) ? 1 : 0;
  db.prepare(`INSERT INTO entries (giveaway_id,user_id,x_follow_ok,x_repost_ok,dc_ok,verified)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(giveaway_id,user_id) DO UPDATE SET
               x_follow_ok=excluded.x_follow_ok,x_repost_ok=excluded.x_repost_ok,
               dc_ok=excluded.dc_ok,verified=excluded.verified`)
    .run(g.id, req.session.userId, x_follow_ok?1:0, x_repost_ok?1:0, dc_ok?1:0, verified);
  res.json({ entered: true, verified, x_follow_ok, x_repost_ok, dc_ok });
});

// Draw winners (only creator)
app.post('/api/giveaways/:id/draw', (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.created_by !== req.session.userId) return res.status(403).json({ error: 'not your giveaway' });
  const verified = db.prepare('SELECT user_id FROM entries WHERE giveaway_id=? AND verified=1').all(g.id).map(r => r.user_id);
  if (verified.length === 0) return res.status(400).json({ error: 'no verified entries' });
  const n = Math.min(g.winners_count, verified.length);
  // Fisher-Yates shuffle → cryptographically fair-ish
  const arr = [...verified];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const picked = arr.slice(0, n);
  const ins = db.prepare('INSERT OR IGNORE INTO winners (giveaway_id,user_id) VALUES (?,?)');
  for (const uid of picked) ins.run(g.id, uid);
  db.prepare("UPDATE giveaways SET status='drawn' WHERE id=?").run(g.id);
  res.json({ winners: picked });
});

// ---- SERVER ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[giveaway] listening on :${PORT} (auth=${x.cfg.mock ? 'MOCK' : 'X-API'}/${discord.cfg.mock ? 'MOCK' : 'DISCORD-API'})`));
module.exports = app;
