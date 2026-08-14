'use strict';
// Task system — verifikasi multi-task untuk giveaway (kayak Alphabot/Atlas3).
// Setiap giveaway punya array tasks: [{type, target, label}]
//
// Tipe task:
//   follow_x   {type:'follow_x', target:'@handle'}          — user follow handle X
//   like_x     {type:'like_x', target:'<post_id or URL>'}   — user like post X
//   repost_x   {type:'repost_x', target:'<post_id or URL>'} — user repost post X
//   join_dc    {type:'join_dc', target:'<guild_id>'}        — user join Discord server
//   connect_x  {type:'connect_x'}                                 — user punya akun X ke-link
//   connect_dc {type:'connect_dc'}                                — user punya akun DC ke-link
//
// Mode verifikasi (X_VERIFY_MODE):
//   honor (default) — follow/like/repost X dianggap selesai kalau user connect X (gratis, instant)
//   xapi           — verifikasi real via X API v2 follows.read (PAID ~$100/mo) utk follow; like/repost masih honor
//   scrape         — verifikasi follow via twscrape (free, rate-limited)
//
// Join_dc & connect_dc tetap real (guild membership) apapun mode X.

// Task label human-readable (target dinormalisasi: link ATAU username/id)
function label(task) {
  const raw = String(task.target || '');
  switch (task.type) {
    case 'follow_x': {
      let m = raw.match(/x\.com\/([A-Za-z0-9_]+)/i) || raw.match(/twitter\.com\/([A-Za-z0-9_]+)/i);
      const h = m ? m[1] : raw.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
      return 'Follow @' + h + ' di X';
    }
    case 'like_x': {
      const m = raw.match(/status\/(\d+)/) || raw.match(/\/i\/status\/(\d+)/) || raw.match(/^(\d{10,25})$/);
      return 'Like postingan X' + (m ? ' (#' + m[1].slice(-8) + ')' : '');
    }
    case 'repost_x': {
      const m = raw.match(/status\/(\d+)/) || raw.match(/\/i\/status\/(\d+)/) || raw.match(/^(\d{10,25})$/);
      return 'Repost postingan X' + (m ? ' (#' + m[1].slice(-8) + ')' : '');
    }
    case 'join_dc': return 'Join Discord server';
    case 'connect_x': return 'Connect akun X';
    case 'connect_dc': return 'Connect akun Discord';
    default: return task.label || 'Selesaikan task';
  }
}

// ---- Target normalization ----
// Accept both a full URL and a bare username / status id.
//   follow_x:  'https://x.com/0xskypots' | '0xskypots' | '@0xskypots'
//   like/repost_x: 'https://x.com/0xskypots/status/2061076823136784725'
//              | 'https://x.com/i/status/2061076823136784725' | '2061076823136784725'
function normalizeTarget(type, target) {
  const raw = String(target || '').trim();
  if (!raw) return { handle: '', statusId: '' };
  if (type === 'follow_x') {
    // strip URL → keep username
    let m = raw.match(/x\.com\/([A-Za-z0-9_]+)/i) || raw.match(/twitter\.com\/([A-Za-z0-9_]+)/i);
    const handle = m ? m[1] : raw.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
    return { handle, statusId: '' };
  }
  // like_x / repost_x → extract status id
  let m = raw.match(/status\/(\d+)/) || raw.match(/\/i\/status\/(\d+)/) || raw.match(/^(\d{10,25})$/);
  const statusId = m ? m[1] : '';
  // also try to grab handle for display
  const h = raw.match(/x\.com\/([A-Za-z0-9_]+)/i);
  return { handle: h ? h[1] : '', statusId };
}

// Direct X URL to perform the action (for "belum selesai → arahkan ke X")
function actionUrl(task) {
  const { handle, statusId } = normalizeTarget(task.type, task.target);
  if (task.type === 'follow_x') return handle ? `https://x.com/${handle}` : '';
  if (task.type === 'like_x' || task.type === 'repost_x') return statusId ? `https://x.com/i/status/${statusId}` : '';
  return '';
}

// Check a single task; returns boolean
async function checkTask(task, user, X_VERIFY, xscrape) {
  const type = task.type;
  if (type === 'connect_dc') return !!(user && user.dc_user_id);
  if (type === 'connect_x') return !!(user && user.x_username);

  if (type === 'join_dc') {
    let guilds = [];
    try { guilds = JSON.parse(user.dc_guilds || '[]'); } catch (e) {}
    return guilds.some(g => g.id === task.target);
  }

  // X-related tasks
  if (type === 'follow_x') {
    if (X_VERIFY === 'xapi' && user && user.x_access_token) {
      const x = require('./x');
      const { handle } = normalizeTarget('follow_x', task.target);
      try { return await x.checkFollow(user.x_access_token, handle); } catch (e) { return false; }
    }
    if (X_VERIFY === 'cli') {
      const twcli = require('./twcli');
      const { handle } = normalizeTarget('follow_x', task.target);
      const r = await twcli.checkFollow(user.x_username, handle);
      if (r !== null) return r; // null = gagal/fallback → honor
      return !!(user && user.x_username);
    }
    if (X_VERIFY === 'scrape' && user && user.x_username) {
      const { handle } = normalizeTarget('follow_x', task.target);
      return xscrape.checkFollow(handle, user.x_username);
    }
    // honor
    return !!(user && user.x_username);
  }

  if (type === 'like_x' || type === 'repost_x') {
    if (X_VERIFY === 'xapi' && user && user.x_access_token) {
      const x = require('./x');
      const { statusId } = normalizeTarget(type, task.target);
      if (!statusId) return false;
      try {
        return type === 'like_x'
          ? await x.checkLiked(user.x_access_token, user.x_user_id, statusId)
          : await x.checkReposted(user.x_access_token, user.x_user_id, statusId);
      } catch (e) { return false; }
    }
    if (X_VERIFY === 'cli') {
      const twcli = require('./twcli');
      const { statusId } = normalizeTarget(type, task.target);
      const r = type === 'like_x'
        ? await twcli.checkLiked(user.x_username, statusId)
        : await twcli.checkReposted(user.x_username, statusId);
      if (r !== null) return r; // null = tidak bisa diverifikasi → honor
      return !!(user && user.x_username);
    }
    // honor (no paid API for like/repost by default)
    return !!(user && user.x_username);
  }

  return false; // unknown task type
}

// Verify all tasks for a giveaway user; returns {tasks array + overall verified}
// `cache` optional: {get(key), set(key, ok, ttlMs)} — dipakai utk cache hasil verifikasi
// mahal (twitter-cli ~40s). Kalau ga ada cache → check langsung.
async function verifyTasks(tasks, user, X_VERIFY, xscrape, cache) {
  const list = Array.isArray(tasks) ? tasks : [];
  const results = [];
  let allOk = true;
  for (const t of list) {
    const cacheable = cache && user && user.id && ['follow_x', 'like_x', 'repost_x'].includes(t.type);
    let ok;
    if (cacheable) {
      const key = `${user.id}:${t.type}:${t.target || ''}`;
      const cached = await cache.get(key);
      if (cached !== null && cached !== undefined) {
        ok = !!cached;
      } else {
        ok = await checkTask(t, user, X_VERIFY, xscrape);
        await cache.set(key, ok, 10 * 60 * 1000); // TTL 10 menit
      }
    } else {
      ok = await checkTask(t, user, X_VERIFY, xscrape);
    }
    results.push({ ...t, ok });
    if (!ok) allOk = false;
  }
  return { results, verified: allOk };
}

module.exports = { label, normalizeTarget, actionUrl, checkTask, verifyTasks };
