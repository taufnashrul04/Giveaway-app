'use strict';
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const helmet = require('helmet');

const db = require('./db');
const x = require('../lib/x');
const xscrape = require('../lib/xscrape');
const discord = require('../lib/discord');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'givefuel-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// X verify provider: honor (default) | scrape | xapi
const X_VERIFY = process.env.X_VERIFY_MODE || 'honor';

async function currentUser(req) {
  if (req.session.userId) {
    const u = await db.get('SELECT * FROM users WHERE id=?', [req.session.userId]);
    if (u) return u;
    req.session.userId = null;
  }
  return null;
}

async function verifyXFollow(user, targetHandle) {
  if (X_VERIFY === 'honor') return !!(user && user.x_username);
  if (X_VERIFY === 'scrape') return xscrape.checkFollow(targetHandle, user.x_username);
  if (X_VERIFY === 'xapi' && user.x_access_token) {
    try { return await x.checkFollow(user.x_access_token, targetHandle); } catch (e) { return false; }
  }
  return false;
}

// ---------- AUTH ----------
app.get('/auth/x/login', (req, res) => res.redirect(x.buildAuthorizeUrl()));
app.get('/auth/x/callback', async (req, res) => {
  try {
    const info = await x.exchangeCode(req.query.code, req.query.state);
    let u = await db.get('SELECT * FROM users WHERE x_user_id=?', [info.x_user_id]);
    if (u) {
      await db.run('UPDATE users SET x_username=?, x_access_token=? WHERE id=?', [info.x_username, info.x_access_token, u.id]);
    } else {
      const r = await db.run('INSERT INTO users (x_user_id, x_username, x_access_token) VALUES (?,?,?)', [info.x_user_id, info.x_username, info.x_access_token]);
      u = { id: r.lastInsertRowid };
    }
    req.session.userId = u.id;
    res.redirect('/?connected=x');
  } catch (e) { res.status(500).send('X auth failed: ' + e.message); }
});
app.get('/auth/x/mock', async (req, res) => {
  const info = await x.exchangeCode('testcode', 'mockstate');
  let u = await db.get('SELECT * FROM users WHERE x_user_id=?', [info.x_user_id]);
  if (u) await db.run('UPDATE users SET x_username=?, x_access_token=? WHERE id=?', [info.x_username, info.x_access_token, u.id]);
  else {
    const r = await db.run('INSERT INTO users (x_user_id, x_username, x_access_token) VALUES (?,?,?)', [info.x_user_id, info.x_username, info.x_access_token]);
    u = { id: r.lastInsertRowid };
  }
  req.session.userId = u.id;
  res.redirect('/?connected=x');
});

app.get('/auth/dc/login', (req, res) => res.redirect(discord.buildAuthorizeUrl()));
app.get('/auth/dc/callback', async (req, res) => {
  try {
    const info = await discord.exchangeCode(req.query.code);
    if (!req.session.userId) {
      let u = await db.get('SELECT * FROM users WHERE dc_user_id=?', [info.dc_user_id]);
      if (!u) {
        const r = await db.run('INSERT INTO users (dc_user_id, dc_username, dc_access_token, dc_guilds) VALUES (?,?,?,?)', [info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds)]);
        req.session.userId = r.lastInsertRowid;
      } else {
        await db.run('UPDATE users SET dc_username=?, dc_access_token=?, dc_guilds=? WHERE id=?', [info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds), u.id]);
        req.session.userId = u.id;
      }
    } else {
      await db.run('UPDATE users SET dc_user_id=?, dc_username=?, dc_access_token=?, dc_guilds=? WHERE id=?', [info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds), req.session.userId]);
    }
    res.redirect('/?connected=dc');
  } catch (e) { res.status(500).send('Discord auth failed: ' + e.message); }
});
app.get('/auth/dc/mock', async (req, res) => {
  const info = await discord.exchangeCode('testcode');
  if (!req.session.userId) {
    const r = await db.run('INSERT INTO users (dc_user_id, dc_username, dc_access_token, dc_guilds) VALUES (?,?,?,?)', [info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds)]);
    req.session.userId = r.lastInsertRowid;
  } else {
    await db.run('UPDATE users SET dc_user_id=?, dc_username=?, dc_access_token=?, dc_guilds=? WHERE id=?', [info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds), req.session.userId]);
  }
  res.redirect('/?connected=dc');
});

// ---------- API ----------
app.get('/api/me', async (req, res) => {
  const u = await currentUser(req);
  res.json(u ? {
    id: u.id, x_username: u.x_username, dc_username: u.dc_username,
    dc_user_id: u.dc_user_id, dc_guilds: JSON.parse(u.dc_guilds || '[]'), wallet: u.wallet || '',
  } : null);
});

app.post('/api/me/wallet', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const wallet = (req.body.wallet || '').trim();
  await db.run('UPDATE users SET wallet=? WHERE id=?', [wallet, req.session.userId]);
  res.json({ ok: true, wallet });
});

app.get('/api/dashboard', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const mine = await db.all(`SELECT g.*, (SELECT COUNT(*) FROM entries e WHERE e.giveaway_id=g.id) AS entry_count,
      (SELECT COUNT(*) FROM winners w WHERE w.giveaway_id=g.id) AS winner_count
      FROM giveaways g WHERE g.created_by=? ORDER BY g.created_at DESC`, [req.session.userId]);
  const entered = await db.all(`SELECT g.*, e.verified, e.created_at AS entered_at,
      (SELECT COUNT(*) FROM entries e2 WHERE e2.giveaway_id=g.id) AS entry_count
      FROM entries e JOIN giveaways g ON g.id=e.giveaway_id
      WHERE e.user_id=? ORDER BY e.created_at DESC`, [req.session.userId]);
  res.json({ mine, entered });
});

app.get('/api/giveaways', async (req, res) => {
  const rows = await db.all(`SELECT g.*, u.x_username AS host
    FROM giveaways g LEFT JOIN users u ON u.id=g.created_by ORDER BY g.created_at DESC`);
  const result = [];
  for (const r of rows) {
    const c = await db.get('SELECT COUNT(*) c FROM entries WHERE giveaway_id=?', [r.id]);
    result.push({ ...r, entry_count: Number(c.c) });
  }
  res.json(result);
});

app.get('/api/giveaways/:id', async (req, res) => {
  const g = await db.get('SELECT * FROM giveaways WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'not found' });
  const winnerRows = await db.all(`SELECT w.*, u.x_username, u.dc_username FROM winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=?`, [g.id]);
  res.json({ ...g, winners: winnerRows });
});

app.post('/api/giveaways', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const { title, description, prize, winners_count, ends_at, require_x_follow, require_x_repost, require_dc_guild } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const r = await db.run(`INSERT INTO giveaways
    (created_by,title,description,prize,winners_count,ends_at,require_x_follow,require_x_repost,require_dc_guild)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.session.userId, title, description || '', prize || '', parseInt(winners_count) || 1, ends_at || null, require_x_follow || null, require_x_repost || null, require_dc_guild || null]);
  res.json({ id: r.lastInsertRowid, ok: true });
});

app.post('/api/giveaways/:id/enter', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const g = await db.get('SELECT * FROM giveaways WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.status !== 'open') return res.status(400).json({ error: 'giveaway closed' });
  const u = await currentUser(req);

  let x_follow_ok = !g.require_x_follow;
  let x_repost_ok = !g.require_x_repost;
  let dc_ok = !g.require_dc_guild;

  if (g.require_x_follow && (u.x_username || X_VERIFY === 'xapi')) {
    x_follow_ok = await verifyXFollow(u, g.require_x_follow);
  } else if (g.require_x_follow) { x_follow_ok = false; }

  if (g.require_dc_guild) dc_ok = discord.isMember(JSON.parse(u.dc_guilds || '[]'), g.require_dc_guild);

  const verified = (x_follow_ok && x_repost_ok && dc_ok) ? 1 : 0;
  await db.run(`INSERT INTO entries (giveaway_id,user_id,x_follow_ok,x_repost_ok,dc_ok,verified)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(giveaway_id,user_id) DO UPDATE SET
               x_follow_ok=excluded.x_follow_ok,x_repost_ok=excluded.x_repost_ok,
               dc_ok=excluded.dc_ok,verified=excluded.verified`,
    [g.id, req.session.userId, x_follow_ok ? 1 : 0, x_repost_ok ? 1 : 0, dc_ok ? 1 : 0, verified]);
  res.json({ entered: true, verified, x_follow_ok, x_repost_ok, dc_ok });
});

app.post('/api/giveaways/:id/draw', async (req, res) => {
  const g = await db.get('SELECT * FROM giveaways WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.created_by !== req.session.userId) return res.status(403).json({ error: 'not your giveaway' });
  const rows = await db.all('SELECT user_id FROM entries WHERE giveaway_id=? AND verified=1', [g.id]);
  const verified = rows.map(r => r.user_id);
  if (verified.length === 0) return res.status(400).json({ error: 'no verified entries' });
  const n = Math.min(g.winners_count, verified.length);
  const arr = [...verified];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const picked = arr.slice(0, n);
  const ins = 'INSERT OR IGNORE INTO winners (giveaway_id,user_id) VALUES (?,?)';
  for (const uid of picked) await db.run(ins, [g.id, uid]);
  await db.run("UPDATE giveaways SET status='drawn' WHERE id=?", [g.id]);
  res.json({ winners: picked });
});

app.get('/api/giveaways/:id/export', async (req, res) => {
  const g = await db.get('SELECT * FROM giveaways WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.created_by !== req.session.userId) return res.status(403).json({ error: 'not your giveaway' });
  const rows = await db.all(`SELECT u.x_username, u.dc_user_id, u.dc_username, u.wallet
    FROM winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=?`, [g.id]);
  const esc = s => { const x = s == null ? '' : String(s); return (/[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x); };
  const header = 'wallet,dc_user_id,dc_username,x_username';
  const lines = rows.map(r => [esc(r.wallet), esc(r.dc_user_id), esc(r.dc_username), esc(r.x_username)].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="winners_${g.id}.csv"`);
  res.send([header, ...lines].join('\n'));
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- EXPORTS ----------
// For Vercel: export the express app as the serverless handler
function handler(req, res) {
  return app(req, res);
}

// Only listen when run directly (node src/server.js), not when imported by Vercel
const isDirect = require.main === module;
if (isDirect) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`[GiveFuel] listening on :${PORT} (auth=${x.cfg.mock ? 'MOCK' : 'X-API'}/${discord.cfg.mock ? 'MOCK' : 'DISCORD-API'}, db=${db._mode})`));
}

module.exports = app;
module.exports.default = app;
