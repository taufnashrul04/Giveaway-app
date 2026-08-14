'use strict';
// Verifikasi Twitter/X REAL via twitter-cli (jackwener/twitter-cli) — pakai akun
// "tumbal" yang lo sediakan. Beda dari X API yang bayar, atau honor (free tapi trust).
//
// Mode aktif: X_VERIFY_MODE=cli  (lihat server.js / .env)
// Credential akun tumbal: setup twitter-cli (browser cookies / TWITTER_AUTH_TOKEN + TWITTER_CT0).
//   twitter status --yaml # harus AUTH_OK
//
// Keterbatasan (penting):
//  - FOLLOW: bisa di-verif real (twitter following/followers).
//  - LIKE/REPOST user LAIN: TERBATAS — X menjadikan likes private sejak Juni 2024,
//    jadi twitter likes cuma work utk akun sendiri. Kita pakai pendekatan terbaik:
//    cek user-posts untuk repost (retweet visible), dan follow. Like = BEST-EFFORT (fallback honor).
//
// Semua method: return Promise<boolean>.
const { execFile } = require('child_process');

const TWITTER_BIN = process.env.TWITTER_CLI_BIN || 'twitter'; // bisa set path abs
const VERIFIER_URL = process.env.X_VERIFIER_URL || ''; // e.g. http://150.109.94.222:8318
const VERIFY_SECRET = process.env.VERIFY_SECRET || '';

// If a remote verifier service is configured (box has twitter-cli, Vercel doesn't),
// route checks there instead of running the binary locally.
async function remoteVerify(type, userHandle, target) {
  if (!VERIFIER_URL) return null; // not configured → treat as cannot-verify
  try {
    const r = await fetch(`${VERIFIER_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-verify-secret': VERIFY_SECRET },
      body: JSON.stringify({ type, userHandle, target }),
    });
    const d = await r.json();
    return typeof d.ok === 'boolean' ? d.ok : null;
  } catch (e) { return null; }
}

// Jalankan twitter-cli, return parsed JSON envelope {ok, data, pagination, error}
function run(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(TWITTER_BIN, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: { message: (stderr || err.message || '').slice(0, 300) } });
      try { return resolve(JSON.parse(stdout)); }
      catch (e) {
        // non-JSON: coba ambil status teks
        return resolve({ ok: false, error: { message: (stdout || stderr || '').slice(0, 300) } });
      }
    });
  });
}

// Apakah `userHandle` follow `targetHandle`?  Cek via followers list target (lebih jarang pagination).
async function checkFollow(userHandle, targetHandle) {
  const u = (userHandle || '').replace(/^@/, '');
  const t = (targetHandle || '').replace(/^@/, '');
  if (!u || !t) return false;
  // remote verifier (Vercel → box): kalau X_VERIFIER_URL ter-set, pakai itu
  const remote = await remoteVerify('follow_x', u, t);
  if (remote !== null) return remote;
  // Jalur lokal: cek daftar `following` dari user → apakah target ada di daftarnya.
  // (twitter-cli: command `followers` returns 404/rusak di versi ini, `following` works.)
  let cursor = undefined;
  for (let page = 0; page < 20; page++) {
    const args = ['following', u, '--max', '500', '--json'];
    if (cursor) args.push('--cursor', cursor);
    const res = await run(args, 60000); // naikkan timeout: tiap call ~25s+ (init websocket)
    if (!res.ok) return null; // gagal → fallback honor
    const list = res.data || [];
    if (list.map(x => (x.username || x.screenName || '').replace(/^@/, '')).includes(t)) return true;
    cursor = res.pagination?.nextCursor;
    if (!cursor) break;
  }
  return false;
}

// Like — BEST-EFFORT. Likes private sejak Juni 2024; hanya bisa cek akun sendiri.
// Kalau user yang diperiksa == akun tumbal, cek likes akun sendiri; selain itu fallback.
async function checkLiked(userHandle, statusId) {
  // Not feasibly reliable for other users (likes private). Return null → caller falls back to honor.
  return null;
}

// Repost — cek apakah repost status muncul di user-posts (retweet terlihat).
async function checkReposted(userHandle, statusId) {
  const u = (userHandle || '').replace(/^@/, '');
  const s = String(statusId || '');
  if (!u || !s) return null;
  const remote = await remoteVerify('repost_x', u, s);
  if (remote !== null) return remote;
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

module.exports = { checkFollow, checkLiked, checkReposted };
