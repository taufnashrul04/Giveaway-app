'use strict';
// GiveFuel Discord Bot — run separately (long-lived process).
//   /join <giveaway_id>  — ikut giveaway dari Discord (auto-verify)
//   /giveaways           — list giveaway open
//   /status              — cek akun terhubung lo
//
// Verifikasi: user yang dikirim bot = Discord user -> lookup GiveFuel user by dc_user_id.
// join_dc task = sudah member di server -> ok otomatis. X tasks tetap honor (butuh connect X dulu via web).
//
// Env:
//   DC_BOT_TOKEN=...            (Discord bot token)
//   GIVEFUEL_BASE_URL=...       (https://givefuel.vercel.app)
//   TURSO_URL / TURSO_AUTH_TOKEN (sama seperti server)
//
// Run:  node bot/discord-bot.js
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, Routes, REST } = require('discord.js');

const DISCORD_BOT_TOKEN = process.env.DC_BOT_TOKEN || '';
const BASE_URL = process.env.GIVEFUEL_BASE_URL || 'https://givefuel.vercel.app';
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const ANNOUNCE_CHANNEL = process.env.DC_ANNOUNCE_CHANNEL || ''; // optional fixed channel id

if (!DISCORD_BOT_TOKEN) { console.error('[givefuel-bot] DC_BOT_TOKEN required'); process.exit(1); }

// ---- minimal raw TURSO HTTP client (same as server db.js) ----
const host = TURSO_URL.replace(/^libsql:\/\//, '').replace(/\/.*$/, '');
const HTTP_URL = `https://${host}`;
function bindParams(sql, params = []) {
  if (!params.length) return sql;
  let i = 0;
  return String(sql).replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
  });
}
async function exec(sql, params = []) {
  const res = await fetch(`${HTTP_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TURSO_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: bindParams(sql, params) }, step: 0 }, { type: 'close' }] }),
  });
  const d = await res.json();
  const r = d.results?.[0];
  if (r?.type !== 'ok') throw new Error('TURSO err: ' + JSON.stringify(r));
  return r.response.result;
}
async function run(sql, params = []) { const r = await exec(sql, params); return { lastInsertRowid: r.last_insert_rowid || 0 }; }
async function all(sql, params = []) {
  const r = await exec(sql, params);
  const cols = (r.cols || []).map(c => c.name);
  return (r.rows || []).map(row => { const o = {}; cols.forEach((c, i) => o[c] = row[i]?.value ?? null); return o; });
}

// ensure schema
async function init() {
  await exec(`CREATE TABLE IF NOT EXISTS bot_announce (id INTEGER PRIMARY KEY AUTOINCREMENT, giveaway_id INTEGER, channel_id TEXT, announced_at TEXT DEFAULT (datetime('now')), UNIQUE(giveaway_id))`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ GiveFuel bot online as ${client.user.tag}`);
  await init();
  // register slash commands
  const commands = [
    new SlashCommandBuilder().setName('giveaways').setDescription('Daftar giveaway yang sedang OPEN di GiveFuel'),
    new SlashCommandBuilder().setName('join').setDescription('Ikut giveaway dari Discord').addStringOption(o => o.setName('id').setDescription('ID giveaway (lihat di /giveaways)').setRequired(true)),
    new SlashCommandBuilder().setName('status').setDescription('Cek akun Discord lo terhubung ke GiveFuel'),
    new SlashCommandBuilder().setName('announce').setDescription('Set channel ini jadi tempat announce winner giveaway').addStringOption(o => o.setName('id').setDescription('ID giveaway').setRequired(true)),
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ slash commands registered');
  } catch (e) { console.error('register slash failed:', e.message); }
});

function taskLabel(t) {
  // normalize target: follow → username bersih; like/repost → status id singkat
  const raw = String(t.target || '');
  switch (t.type) {
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
    default: return t.label || 'Task';
  }
}

client.on('interactionCreate', async (i) => {
  // Handle BUTTON interactions first (Join Giveaway button) — these are NOT
  // chat input commands, so the guard below must not swallow them.
  if (i.isButton() && i.customId.startsWith('join_gw:')) {
    try {
      const id = parseInt(i.customId.split(':')[1]);
      // Discord interaction must respond within 3s; real verify takes 30-40s.
      // Defer first (acknowledge), then edit with the result when done.
      await i.deferReply({ ephemeral: true });
      await i.editReply({ content: '⏳ Memeriksa task... (verifikasi follow real bisa ~30 detik)' });
      const out = await processJoin(i.user.id, i.user.username, id);
      if (out.ok === true) {
        return i.editReply({ content: out.message });
      }
      // incomplete → bawa ke web utk login + connect X + join.
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🔗 Login & Connect X & Join').setStyle(ButtonStyle.Link).setURL(`${BASE_URL}/giveaway.html?id=${id}`)
      );
      return i.editReply({ content: out.message + '\n\nKlik tombol di bawah, login Discord, connect X, lalu klik **Ikut Giveaway**.', components: [row] });
    } catch (e) {
      console.error('button error:', e);
      return i.editReply({ content: 'Terjadi error: ' + e.message }).catch(()=>{});
    }
  }
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'giveaways') {
      const rows = await all(`SELECT id, title, prize, tasks, winners_count, status FROM giveaways WHERE status='open' ORDER BY created_at DESC LIMIT 10`);
      if (!rows.length) return i.reply({ content: 'Belum ada giveaway open. Cek di ' + BASE_URL, ephemeral: true });
      const lines = rows.map(g => {
        let tasks = [];
        try { tasks = JSON.parse(g.tasks || '[]'); } catch (e) {}
        const labels = tasks.map(taskLabel);
        return `**#${g.id}** — ${g.title}${g.prize ? ' · 🏆 ' + g.prize : ''}\n${labels.length ? labels.map(l => '  • ' + l).join('\n') : '  • tanpa tugas'}`;
      });
      const emb = new EmbedBuilder().setTitle('🎁 GiveFuel — Giveaway OPEN').setColor(0x4f7cff).setDescription(lines.join('\n\n')).setFooter({ text: 'Join pakai /join id' });
      return i.reply({ embeds: [emb] });
    }
    if (i.commandName === 'status') {
      const u = (await all(`SELECT id, x_username, dc_username FROM users WHERE dc_user_id=?`, [i.user.id]))[0];
      if (!u) return i.reply({ content: `Discord lo **belum** connect ke GiveFuel akun apa pun. Kunjungi ${BASE_URL} → Login Discord, lalu kembali ke sini.`, ephemeral: true });
      return i.reply({ content: `✅ Terhubung: Discord \`${u.dc_username}\`${u.x_username ? ' + X @' + u.x_username : ' (X belum connect — connect di dashboard)'}.`, ephemeral: true });
    }
    if (i.commandName === 'join') {
      const id = parseInt(i.options.getString('id'));
      await i.deferReply({ ephemeral: true });
      await i.editReply({ content: '⏳ Memeriksa task... (verifikasi follow real bisa ~30 detik)' });
      const out = await processJoin(i.user.id, i.user.username, id);
      await i.editReply({ content: out.message });
      return;
    }
  } catch (e) {
    console.error('interaction error:', e);
    await i.reply({ content: 'Terjadi error: ' + e.message, ephemeral: true }).catch(()=>{});
  }
});

// Auto-verify via Discord + join ketika semua task terpenuhi.
// Returns {ok:true, message} bila berhasil, atau {ok:false, message} bila task belum lengkap.
async function processJoin(dcUserId, dcUsername, giveawayId) {
  const id = parseInt(giveawayId);
  if (!id) return { ok: false, message: 'ID giveaway tidak valid.' };
  const g = (await all(`SELECT * FROM giveaways WHERE id=?`, [id]))[0];
  if (!g) return { ok: false, message: 'Giveaway #' + id + ' tidak ditemukan.' };
  if (g.status !== 'open') return { ok: false, message: 'Giveaway #' + id + ' sudah ditutup.' };
  // find or create GiveFuel user for this discord id
  let u = (await all(`SELECT * FROM users WHERE dc_user_id=?`, [dcUserId]))[0];
  if (!u) {
    const r = await run(`INSERT INTO users (dc_user_id, dc_username) VALUES (?,?)`, [dcUserId, dcUsername]);
    u = { id: r.lastInsertRowid, dc_user_id: dcUserId, dc_username: dcUsername, x_username: null, dc_guilds: '[]' };
  }
  // parse tasks
  let tasks = [];
  try { tasks = JSON.parse(g.tasks || '[]'); } catch (e) {}
  if (!tasks.length) {
    if (g.require_x_follow) tasks.push({ type: 'follow_x', target: g.require_x_follow });
    if (g.require_x_repost) tasks.push({ type: 'repost_x' });
    if (g.require_dc_guild) tasks.push({ type: 'join_dc', target: g.require_dc_guild });
  }
  const results = [];
  for (const t of tasks) {
    if (t.type === 'connect_dc') { results.push({ ...t, ok: true }); continue; }
    if (t.type === 'join_dc') { results.push({ ...t, ok: true }); continue; } // user IS here in the server
    if (t.type === 'connect_x') { results.push({ ...t, ok: !!(u.x_username) }); continue; }
    // X-related tasks: real verify via remote verifier (box twitter-cli) when configured
    if (t.type === 'follow_x' || t.type === 'like_x' || t.type === 'repost_x') {
      const VERIFY_URL = process.env.X_VERIFIER_URL || '';
      const VERIFY_SECRET = process.env.VERIFY_SECRET || '';
      let realv = null;
      if (VERIFY_URL && u.x_username && (t.type === 'follow_x' || t.type === 'repost_x')) {
        const target = (t.type === 'follow_x')
          ? (String(t.target).match(/x\.com\/([A-Za-z0-9_]+)/i) || [])[1] || String(t.target).replace(/^@/,'').replace(/[^A-Za-z0-9_]/g,'')
          : (String(t.target).match(/status\/(\d+)/) || String(t.target).match(/\/i\/status\/(\d+)/) || String(t.target).match(/^(\d{10,25})$/) || [])[1] || '';
        if (target) {
          try {
            const rr = await fetch(`${VERIFY_URL}/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-verify-secret': VERIFY_SECRET },
              body: JSON.stringify({ type: t.type === 'repost_x' ? 'repost_x' : 'follow_x', userHandle: u.x_username, target }),
            });
            const dd = await rr.json();
            if (typeof dd.ok === 'boolean') realv = dd.ok;
          } catch (e) { realv = null; }
        }
      }
      // realv null = gagal/ga bisa → fallback honor
      const ok = (realv !== null) ? realv : !!(u.x_username);
      results.push({ ...t, ok });
      continue;
    }
    results.push({ ...t, ok: false });
  }
  const verified = results.every(r => r.ok);
  const x_ok = (results.find(r => r.type === 'follow_x') || {}).ok ?? 1;
  const xr_ok = (results.find(r => r.type === 'repost_x') || {}).ok ?? 1;
  const dc_ok = (results.find(r => r.type === 'join_dc') || {}).ok ?? 1;
  await run(`INSERT INTO entries (giveaway_id,user_id,x_follow_ok,x_repost_ok,dc_ok,verified)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(giveaway_id,user_id) DO UPDATE SET
               x_follow_ok=excluded.x_follow_ok, x_repost_ok=excluded.x_repost_ok,
               dc_ok=excluded.dc_ok, verified=excluded.verified`,
    [g.id, u.id, x_ok ? 1 : 0, xr_ok ? 1 : 0, dc_ok ? 1 : 0, verified ? 1 : 0]);
  if (verified) {
    return { ok: true, message: `✅ Lo masuk giveaway **#${g.id} — ${g.title}**! Semua task terpenuhi. Semoga menang 🍀` };
  } else {
    const { actionUrl } = require('../lib/tasks');
    const pending = results.filter(r => !r.ok).map(r => {
      const url = actionUrl(r);
      const suffix = url ? ` — [buka di X](${url})` : '';
      return '  ❌ ' + taskLabel(r) + suffix;
    }).join('\n');
    return { ok: false, message: `⚠️ Task belum lengkap buat **#${g.id} — ${g.title}**:\n${pending}\n\nKlik tombol **Login & Connect X & Join** di bawah untuk lanjut via web.` };
  }
}

client.login(DISCORD_BOT_TOKEN);

// ---- Winner announce HTTP endpoint ----
// Web server POSTs here after a draw. Listens on GIVEFUEL_ANNOUNCE_PORT (default 4210).
const http = require('http');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Resolve target channel: per-giveaway (bot_announce) or env default.
async function resolveChannel(giveawayId) {
  let target = ANNOUNCE_CHANNEL;
  try {
    const row = (await all(`SELECT channel_id FROM bot_announce WHERE giveaway_id=?`, [giveawayId]))[0];
    if (row?.channel_id) target = row.channel_id;
  } catch (e) {}
  return target;
}

// Post a NEW giveaway announcement to Discord with a Join button → opens web.
async function announceGiveaway(payload) {
  const { giveawayId, title, prize, description, projectName, hostHandle } = payload;
  const target = await resolveChannel(giveawayId);
  if (!target) return { ok: false, reason: 'no_channel' };
  const channel = await client.channels.fetch(target).catch(() => null);
  if (!channel?.isTextBased()) { console.warn('[announce] channel not found:', target); return { ok: false, reason: 'bad_channel' }; }
  const joinUrl = `${BASE_URL}/project.html${projectName ? '' : ''}?id=${giveawayId}`;
  // point to the giveaway — reuse web details page by id (feed/project anchor)
  const detailUrl = `${BASE_URL}/giveaway.html?id=${giveawayId}`;
  const emb = new EmbedBuilder()
    .setTitle('🎁 ' + (title || 'Giveaway #' + giveawayId))
    .setDescription((projectName ? `**${projectName}**\n` : '') + (hostHandle ? `Host: @${hostHandle}\n` : '') + (prize ? `🏆 Hadiah: **${prize}**\n` : '') + (description ? '\n' + description : ''))
    .setColor(0x4f7cff)
    .setFooter({ text: 'GiveFuel — klik Join utk auto-verify via Discord, atau View utk join via web' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🎟️ Join Giveaway').setStyle(ButtonStyle.Primary).setCustomId(`join_gw:${giveawayId}`),
    new ButtonBuilder().setLabel('👀 View Giveaway').setStyle(ButtonStyle.Link).setURL(detailUrl)
  );
  await channel.send({ embeds: [emb], components: [row] });
  return { ok: true };
}

async function announceWinner(payload) {
  const { giveawayId, title, prize, winners } = payload;
  const target = await resolveChannel(giveawayId);
  if (!target) { console.warn(`[announce] no channel for giveaway #${giveawayId} — announce skipped. Set DC_ANNOUNCE_CHANNEL or register channel.`); return { ok: false, reason: 'no_channel' }; }
  const channel = await client.channels.fetch(target).catch(() => null);
  if (!channel?.isTextBased()) { console.warn('[announce] channel not found/not text:', target); return { ok: false, reason: 'bad_channel' }; }
  const winLines = (winners || []).map(w => `  🏆 <@${w.dc_user_id || '@unknown'}>${w.dc_username ? ' (' + w.dc_username + ')' : ''}`);
  const emb = new EmbedBuilder()
    .setTitle('🏆 Winner Announcement')
    .setDescription(`**Giveaway: ${title || '#' + giveawayId}**\n${prize ? 'Hadiah: **' + prize + '**\n' : ''}\nSelamat! ${winLines.join('\n') || '*(tidak ada pemenang tercatat)*'}`)
    .setColor(0x2ecc71)
    .setFooter({ text: 'GiveFuel' });
  await channel.send({ embeds: [emb] });
  return { ok: true };
}
// `/announce` slash: register current channel as announce channel utk giveaway
client.on('interactionCreate', async (i) => {
  if (!i.isCommand) return;
  if (i.commandName === 'announce' && i.isChatInputCommand()) {
    const id = parseInt(i.options.getString('id'));
    if (!id) return i.reply({ content: 'ID invalid.', ephemeral: true });
    await run(`INSERT INTO bot_announce (giveaway_id, channel_id) VALUES (?,?) ON CONFLICT(giveaway_id) DO UPDATE SET channel_id=excluded.channel_id`, [id, i.channelId]);
    return i.reply({ content: `✅ Winners giveaway #${id} akan di-announce di channel ini.`, ephemeral: true });
  }
});
const PORT = parseInt(process.env.GIVEFUEL_ANNOUNCE_PORT || '4210', 10);
const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      if (req.headers['x-announce-secret'] !== (process.env.DC_ANNOUNCE_SECRET || '')) {
        res.writeHead(403); return res.end(JSON.stringify({ ok: false, reason: 'bad_secret' }));
      }
      const payload = JSON.parse(body || '{}');
      let out;
      if (req.method === 'POST' && req.url === '/giveaway') {
        out = await announceGiveaway(payload);       // new giveaway posted to Discord
      } else if (req.method === 'POST' && req.url === '/announce') {
        out = await announceWinner(payload);          // winners announced
      } else {
        res.writeHead(404); return res.end(JSON.stringify({ ok: false, reason: 'not_found' }));
      }
      res.writeHead(200); res.end(JSON.stringify(out));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); }
  });
});
server.listen(PORT, () => console.log(`[givefuel-bot] announce HTTP on :${PORT}`));
