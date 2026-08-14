'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');

const db = require('./db');
const x = require('../lib/x');
const xscrape = require('../lib/xscrape');
const discord = require('../lib/discord');

const SESSION_SECRET = process.env.SESSION_SECRET || 'givefuel-dev-secret';
const SESSION_COOKIE = 'gf_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

// ---------- Stateless signed-cookie session (serverless-safe) ----------
// No server-side session store — user id is HMAC-signed in the cookie itself,
// so it survives across Vercel lambda instances / cold starts.
function signSession(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + SESSION_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Date.now()) return null;
    return data.uid;
  } catch (e) { return null; }
}
function setSessionCookie(res, uid) {
  res.cookie(SESSION_COOKIE, signSession(uid), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    maxAge: SESSION_TTL, path: '/',
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// attach req.session (userId getter/setter backed by signed cookie)
app.use((req, res, next) => {
  let uid = verifySession(req.cookies[SESSION_COOKIE]);
  req.session = {
    get userId() { return uid; },
    set userId(v) {
      uid = v;           // update in-request value
      if (v) setSessionCookie(res, v);   // persist
    },
    destroy(cb) { uid = null; clearSessionCookie(res); if (cb) cb(); },
  };
  next();
});


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
// Merge user `fromId` into `toId`: reassign ownership of their giveaways,
// projects, entries, winners, then delete the orphaned user. Returns true on success.
async function mergeUsers(fromId, toId) {
  if (fromId === toId) return true;
  const tables = [
    ['giveaways', 'created_by'],
    ['projects', 'created_by'],
    ['entries', 'user_id'],
    ['winners', 'user_id'],
    ['project_members', 'user_id'],
  ];
  for (const [table, col] of tables) {
    await db.run(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`, [toId, fromId]);
  }
  // if fromId row still has dc/x data that toId lacks, carry it over
  const from = await db.get('SELECT * FROM users WHERE id=?', [fromId]);
  const to = await db.get('SELECT * FROM users WHERE id=?', [toId]);
  if (from && to) {
    const carry = {};
    if (!to.x_user_id && from.x_user_id) carry.x_user_id = from.x_user_id;
    if (!to.x_username && from.x_username) carry.x_username = from.x_username;
    if (!to.x_access_token && from.x_access_token) carry.x_access_token = from.x_access_token;
    if (!to.dc_user_id && from.dc_user_id) carry.dc_user_id = from.dc_user_id;
    if (!to.dc_username && from.dc_username) carry.dc_username = from.dc_username;
    if (!to.dc_access_token && from.dc_access_token) carry.dc_access_token = from.dc_access_token;
    if (!to.dc_guilds && from.dc_guilds) carry.dc_guilds = from.dc_guilds;
    if (!to.wallet && from.wallet) carry.wallet = from.wallet;
    // CRITICAL: null out the UNIQUE columns (x_user_id, dc_user_id) on fromId BEFORE
    // carrying them to toId, else we hit UNIQUE constraint (fromId still holds them).
    if (from.x_user_id) await db.run('UPDATE users SET x_user_id=NULL WHERE id=?', [fromId]);
    if (from.dc_user_id) await db.run('UPDATE users SET dc_user_id=NULL WHERE id=?', [fromId]);
    if (Object.keys(carry).length) {
      const sets = Object.keys(carry).map(k => `${k}=?`).join(',');
      await db.run(`UPDATE users SET ${sets} WHERE id=?`, [...Object.values(carry), toId]);
    }
  }
  await db.run('DELETE FROM users WHERE id=?', [fromId]);
  return true;
}

app.get('/auth/x/login', (req, res) => res.redirect(x.buildAuthorizeUrl(res)));
app.get('/auth/x/callback', async (req, res) => {
  try {
    const info = await x.exchangeCode(req.query.code, req.query.state, req, res);
    // If already logged in (e.g. via Discord), LINK this X account to that user
    // instead of switching/swapping the session identity.
    if (req.session.userId) {
      let existing = await db.get('SELECT * FROM users WHERE id=?', [req.session.userId]);
      if (existing) {
        // If this X id belongs to a DIFFERENT user, merge that user into current
        // (avoids UNIQUE constraint on users.x_user_id).
        const owner = await db.get('SELECT * FROM users WHERE x_user_id=? AND id<>?', [info.x_user_id, existing.id]);
        if (owner) await mergeUsers(owner.id, existing.id);
        await db.run('UPDATE users SET x_user_id=?, x_username=?, x_access_token=? WHERE id=?', [info.x_user_id, info.x_username, info.x_access_token, existing.id]);
        return res.redirect('/?connected=x');
      }
    }
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
  // If already logged in, link X to current user (don't swap session)
  if (req.session.userId) {
    const owner = await db.get('SELECT * FROM users WHERE x_user_id=? AND id<>?', [info.x_user_id, req.session.userId]);
    if (owner) await mergeUsers(owner.id, req.session.userId);
    await db.run('UPDATE users SET x_user_id=?, x_username=?, x_access_token=? WHERE id=?', [info.x_user_id, info.x_username, info.x_access_token, req.session.userId]);
    return res.redirect('/?connected=x');
  }
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
    let u = await db.get('SELECT * FROM users WHERE dc_user_id=?', [info.dc_user_id]);
    if (!u) {
      const r = await db.run('INSERT INTO users (dc_user_id, dc_username, dc_access_token, dc_guilds) VALUES (?,?,?,?)', [info.dc_user_id, info.dc_username, info.dc_access_token, JSON.stringify(info.dc_guilds)]);
      req.session.userId = r.lastInsertRowid;
    } else {
      req.session.userId = u.id;
    }
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
  const myProjects = await db.all(`SELECT p.*, pm.role, (SELECT COUNT(*) FROM giveaways g WHERE g.project_id=p.id) AS giveaway_count
      FROM projects p JOIN project_members pm ON pm.project_id=p.id
      WHERE pm.user_id=? ORDER BY p.created_at DESC`, [req.session.userId]);
  res.json({ mine, entered, myProjects });
});

// notify Discord bot: giveaway dibuat → bot post announce ke Discord dengan tombol join
function notifyBotGiveaway(gw) {
  const botUrl = process.env.GIVEFUEL_BOT_URL || '';
  const announceSecret = process.env.DC_ANNOUNCE_SECRET || '';
  if (!botUrl || !announceSecret) return;
  fetch(`${botUrl}/giveaway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-announce-secret': announceSecret },
    body: JSON.stringify({ giveawayId: gw.id, title: gw.title, prize: gw.prize, description: gw.description, projectName: gw.pn || null, hostHandle: gw.host || null }),
  }).catch(e => console.error('[notify giveaway] failed:', e.message));
}

// ---------- GIVEAWAYS ----------
app.get('/api/giveaways', async (req, res) => {
  const rows = await db.all(`SELECT g.*, u.x_username AS host, p.name AS project_name, p.slug AS project_slug, p.logo AS project_logo
    FROM giveaways g LEFT JOIN users u ON u.id=g.created_by LEFT JOIN projects p ON p.id=g.project_id
    ORDER BY g.created_at DESC`);
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
  const { title, description, prize, winners_count, ends_at, require_x_follow, require_x_repost, require_dc_guild, tasks } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  // normalize tasks array; also derive legacy columns from tasks for compatibility
  const taskList = Array.isArray(tasks) && tasks.length ? tasks : [];
  const tasksJson = JSON.stringify(taskList);
  // derive legacy fields if not explicitly given
  const xFollow = require_x_follow || (taskList.find(t => t.type === 'follow_x') || {}).target || null;
  const dcg = require_dc_guild || (taskList.find(t => t.type === 'join_dc') || {}).target || null;
  const r = await db.run(`INSERT INTO giveaways
    (created_by,title,description,prize,winners_count,ends_at,require_x_follow,require_x_repost,require_dc_guild,tasks)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [req.session.userId, title, description || '', prize || '', parseInt(winners_count) || 1, ends_at || null,
      xFollow, require_x_repost || null, dcg, tasksJson]);
  notifyBotGiveaway({ id: r.lastInsertRowid, title, prize, description, host: null, pn: null });
  res.json({ id: r.lastInsertRowid, ok: true });
});

app.post('/api/giveaways/:id/enter', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const g = await db.get('SELECT * FROM giveaways WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.status !== 'open') return res.status(400).json({ error: 'giveaway closed' });
  const u = await currentUser(req);

  // Dynamic task system (kayak Alphabot/Atlas): parse tasks JSON; fallback to legacy columns
  let taskList = [];
  try { taskList = JSON.parse(g.tasks || '[]'); } catch (e) { taskList = []; }
  if (!taskList.length) {
    // legacy: build from old columns
    if (g.require_x_follow) taskList.push({ type: 'follow_x', target: g.require_x_follow });
    if (g.require_x_repost) taskList.push({ type: 'repost_x', target: g.require_x_repost });
    if (g.require_dc_guild) taskList.push({ type: 'join_dc', target: g.require_dc_guild });
  }

  const { verifyTasks } = require('../lib/tasks');
  const { results, verified } = await verifyTasks(taskList, u, X_VERIFY, xscrape);

  const x_follow_ok = (results.find(t => t.type === 'follow_x') || {}).ok ?? !g.require_x_follow;
  const x_repost_ok = (results.find(t => t.type === 'repost_x') || {}).ok ?? !g.require_x_repost;
  const dc_ok = (results.find(t => t.type === 'join_dc') || {}).ok ?? !g.require_dc_guild;

  await db.run(`INSERT INTO entries (giveaway_id,user_id,x_follow_ok,x_repost_ok,dc_ok,verified)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(giveaway_id,user_id) DO UPDATE SET
               x_follow_ok=excluded.x_follow_ok,x_repost_ok=excluded.x_repost_ok,
               dc_ok=excluded.dc_ok,verified=excluded.verified`,
    [g.id, req.session.userId, x_follow_ok ? 1 : 0, x_repost_ok ? 1 : 0, dc_ok ? 1 : 0, verified ? 1 : 0]);
  res.json({ entered: true, verified, x_follow_ok, x_repost_ok, dc_ok, tasks: results });
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
  // notify Discord bot to announce winners (best-effort)
  const botUrl = process.env.GIVEFUEL_BOT_URL || '';
  const announceSecret = process.env.DC_ANNOUNCE_SECRET || '';
  if (botUrl && announceSecret) {
    const winRows = await db.all(`SELECT u.dc_user_id, u.dc_username, u.x_username FROM winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=?`, [g.id]);
    fetch(`${botUrl}/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-announce-secret': announceSecret },
      body: JSON.stringify({ giveawayId: g.id, title: g.title, prize: g.prize, winners: winRows }),
    }).catch(e => console.error('[announce] failed:', e.message));
  }
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

// ---------- PROJECTS ----------
// List projects (+ giveaway count). Public.
app.get('/api/projects', async (req, res) => {
  try {
    const rows = await db.all(`SELECT p.*, u.x_username AS owner_handle,
      (SELECT COUNT(*) FROM giveaways g WHERE g.project_id=p.id) AS giveaway_count,
      (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id=p.id) AS member_count
      FROM projects p LEFT JOIN users u ON u.id=p.created_by
      ORDER BY p.created_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a project (logged-in). Creator auto-added as owner.
app.post('/api/projects', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const { name, description, type, website, twitter, discord, logo } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  const r = await db.run(`INSERT INTO projects (created_by,name,slug,description,type,website,twitter,discord,logo)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.session.userId, name, slug, description || '', type || 'nft', website || '', twitter || '', discord || '', logo || '']);
  const pid = r.lastInsertRowid;
  await db.run('INSERT INTO project_members (project_id,user_id,role) VALUES (?,?,?)', [pid, req.session.userId, 'owner']);
  res.json({ id: pid, ok: true });
});

// Project detail + its giveaways + members. Public.
app.get('/api/projects/:id', async (req, res) => {
  const p = await db.get('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'not found' });
  const giveaways = await db.all(`SELECT g.*, (SELECT COUNT(*) FROM entries e WHERE e.giveaway_id=g.id) AS entry_count
    FROM giveaways g WHERE g.project_id=? ORDER BY g.created_at DESC`, [p.id]);
  const members = await db.all(`SELECT pm.role, u.x_username, u.dc_username FROM project_members pm
    JOIN users u ON u.id=pm.user_id WHERE pm.project_id=?`, [p.id]);
  res.json({ ...p, giveaways, members });
});

// Create a project (logged-in). Creator auto-added as owner.
app.post('/api/projects/:id/giveaways', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login first' });
  const p = await db.get('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'not found' });
  const isMember = await db.get('SELECT * FROM project_members WHERE project_id=? AND user_id=?', [p.id, req.session.userId]);
  if (!isMember) return res.status(403).json({ error: 'not a member of this project' });
  const { title, description, prize, winners_count, ends_at, require_x_follow, require_x_repost, require_dc_guild, tasks } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const taskList = Array.isArray(tasks) && tasks.length ? tasks : [];
  const tasksJson = JSON.stringify(taskList);
  const xFollow = require_x_follow || (taskList.find(t => t.type === 'follow_x') || {}).target || null;
  const dcg = require_dc_guild || (taskList.find(t => t.type === 'join_dc') || {}).target || null;
  const r = await db.run(`INSERT INTO giveaways
    (project_id,created_by,title,description,prize,winners_count,ends_at,require_x_follow,require_x_repost,require_dc_guild,tasks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [p.id, req.session.userId, title, description || '', prize || '', parseInt(winners_count) || 1, ends_at || null,
      xFollow, require_x_repost || null, dcg, tasksJson]);
  notifyBotGiveaway({ id: r.lastInsertRowid, title, prize, description, host: null, pn: p.name });
  res.json({ id: r.lastInsertRowid, ok: true });
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
