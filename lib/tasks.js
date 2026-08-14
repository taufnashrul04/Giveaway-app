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

// Task label human-readable
function label(task) {
  switch (task.type) {
    case 'follow_x': return 'Follow @' + (task.target || '').replace(/^@/, '') + ' di X';
    case 'like_x': return 'Like postingan X';
    case 'repost_x': return 'Repost postingan X';
    case 'join_dc': return 'Join Discord server';
    case 'connect_x': return 'Connect akun X';
    case 'connect_dc': return 'Connect akun Discord';
    default: return task.label || 'Selesaikan task';
  }
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
    if (X_VERIFY === 'xapi') {
      const x = require('./x');
      try { return await x.checkFollow(user.x_access_token, task.target); } catch (e) { return false; }
    }
    if (X_VERIFY === 'scrape') {
      return xscrape.checkFollow(task.target, user.x_username);
    }
    // honor
    return !!(user && user.x_username);
  }

  // like_x / repost_x — honor (kami tak pakai X API paid utk ini)
  if (type === 'like_x' || type === 'repost_x') {
    return !!(user && user.x_username);
  }

  return false; // unknown task type
}

// Verify all tasks for a giveaway user; returns {tasks array + overall verified}
async function verifyTasks(tasks, user, X_VERIFY, xscrape) {
  const list = Array.isArray(tasks) ? tasks : [];
  const results = [];
  let allOk = true;
  for (const t of list) {
    const ok = await checkTask(t, user, X_VERIFY, xscrape);
    results.push({ ...t, ok });
    if (!ok) allOk = false;
  }
  return { results, verified: allOk };
}

module.exports = { label, checkTask, verifyTasks };
