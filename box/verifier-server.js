'use strict';
// GiveFuel X-Verifier — standalone service on the box (has twitter-cli + tumbal account).
// Vercel serverless CANNOT run twitter-cli, so /verify & /enter on Vercel call THIS
// service over HTTP to do the real follow/repost check.
//
// Endpoint:  POST /verify   body: { type:'follow_x'|'repost_x'|'like_x', userHandle, target }
//   follow_x:  target = @handle to check user follows
//   repost_x:  target = status id
//   like_x:    target = status id (BEST-EFFORT — likes private; returns null)
// Response:  { ok: true|false|null }   null = cannot verify (caller falls back to honor)
//
// Auth: header x-verify-secret must match VERIFY_SECRET.
// Run:  source .env.twcli && node box/verifier-server.js   (port VERIFY_PORT default 8318)
const http = require('http');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.VERIFY_PORT || '8318', 10);
const SECRET = process.env.VERIFY_SECRET || '';
const TWITTER_BIN = process.env.TWITTER_CLI_BIN || 'twitter';

function run(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(TWITTER_BIN, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: { message: (stderr || err.message || '').slice(0, 300) } });
      try { return resolve(JSON.parse(stdout)); }
      catch (e) { return resolve({ ok: false, error: { message: (stdout || stderr || '').slice(0, 300) } }); }
    });
  });
}

// user follows target? via `following <user>` list (followers cmd is broken in 0.8.x)
async function checkFollow(userHandle, targetHandle) {
  const u = (userHandle || '').replace(/^@/, '');
  const t = (targetHandle || '').replace(/^@/, '');
  if (!u || !t) return false;
  let cursor = undefined;
  for (let page = 0; page < 20; page++) {
    const args = ['following', u, '--max', '500', '--json'];
    if (cursor) args.push('--cursor', cursor);
    const res = await run(args);
    if (!res.ok) return null; // gagal → fallback honor
    const list = res.data || [];
    if (list.map(x => (x.username || x.screenName || '').replace(/^@/, '')).includes(t)) return true;
    cursor = res.pagination?.nextCursor;
    if (!cursor) break;
  }
  return false;
}

// repost check — best-effort via user-posts screening
async function checkReposted(userHandle, statusId) {
  const u = (userHandle || '').replace(/^@/, '');
  const s = String(statusId || '');
  if (!u || !s) return null;
  for (let page = 0; page < 3; page++) {
    const res = await run(['user-posts', u, '--max', '100', '--json']);
    if (!res.ok) return null;
    const list = res.data || [];
    if (list.some(t => String(t.retweetedStatusId || t.quotedStatusId || t.retweeted_id || '') === s || t.id === s)) return true;
    const cursor = res.pagination?.nextCursor;
    if (!cursor) break;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/verify') { res.writeHead(404); return res.end(JSON.stringify({ ok: false, reason: 'not_found' })); }
  if (req.headers['x-verify-secret'] !== SECRET) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, reason: 'bad_secret' })); }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const p = JSON.parse(body || '{}');
      const { type, userHandle, target } = p;
      let ok;
      if (type === 'follow_x') ok = await checkFollow(userHandle, target);
      else if (type === 'repost_x') ok = await checkReposted(userHandle, target);
      else if (type === 'like_x') ok = null; // likes private → best-effort
      else ok = null;
      res.writeHead(200);
      res.end(JSON.stringify({ ok }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: null, error: e.message })); }
  });
});

server.listen(PORT, () => console.log(`[givefuel-verifier] on :${PORT} (twitter=${TWITTER_BIN})`));
