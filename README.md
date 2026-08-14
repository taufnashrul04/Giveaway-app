# GiveFuel — Free Web3 Giveaway Platform

Platform giveaway/quest Web3 gratis (kayak [Alphabot](https://alphabot.app) & [Atlas3](https://atlas3.io)).
Users connect X (Twitter) + Discord, verify they follow a handle / join a server, enter giveaways, hosts draw random winners & export CSV.

## Stack
- Express (Node) + Vanilla frontend
- **DB dual-mode**: `better-sqlite3` (dev/local) OR **Turso** (@libsql/client, cloud — for Vercel). Set `TURSO_URL` + `TURSO_AUTH_TOKEN` → Turso; unset → local SQLite.
- Deploy target: **Vercel** (via GitHub import) — `vercel.json` + `api/index.js` already set up.

## Fitur
- 🔗 Connect X (OAuth2) + Discord (OAuth2)
- ✅ Task verify: X follow (honor system, free) + Discord member (real, free)
- 🎁 Create / Enter / Draw giveaway (Fisher-Yates)
- 🏆 Export winners CSV: `wallet, dc_user_id, dc_username, x_username`
- 📊 Dashboard (host + user views), wallet paste in settings

## Live vs Mock auth

| Mode | Kapan | Butuh |
|---|---|---|
| **MOCK** (default) | Demo / local / tanpa API keys | Tidak ada |
| **X-API** | Production | X app OAuth2 + **X API paid** (follows.read ~$100/mo) |
| **DISCORD-API** | Production | Discord app OAuth2 (gratis, `identify guilds`) |

## Setup

```bash
cd ~/giveaway-platform
npm install
cp .env.example .env          # isi kalau mau live; kosong = mock
node scripts/init-db.js        # buat schema
npm start                      # → http://localhost:3000
```

## Test flow (mock)

```bash
# connect X
curl -c /tmp/gw.txt http://localhost:3000/auth/x/mock   # session
# connect Discord
curl -b /tmp/gw.txt -c /tmp/gw.txt http://localhost:3000/auth/dc/mock
# create
curl -b /tmp/gw.txt -X POST localhost:3000/api/giveaways \
  -H 'Content-Type: application/json' \
  -d '{"title":"Test","winners_count":1,"require_x_follow":"0xskypots"}'
# enter + draw
curl -b /tmp/gw.txt -X POST localhost:3000/api/giveaways/1/enter
curl -b /tmp/gw.txt -X POST localhost:3000/api/giveaways/1/draw
```

## API
| Method | Path | Desc |
|---|---|---|
| GET | `/api/me` | Current user + linked X/Discord |
| GET | `/api/giveaways` | List |
| GET | `/api/giveaways/:id` | Detail + winners |
| POST | `/api/giveaways` | Create (login) |
| POST | `/api/giveaways/:id/enter` | Enter + verify tasks |
| POST | `/api/giveaways/:id/draw` | Draw winners (host only) |
| POST | `/api/logout` | Logout |

## Deploy Vercel (manual via GitHub import)
1. Push repo ke GitHub (done — `github.com/taufnashrul04/Giveaway-app`)
2. Vercel → **Add New Project → Import** dari repo → framework: **Other**
3. Build command: `npm install`, Output: `api/index.js` (vercel.json handles routing)
4. Tambah **Environment Variables** di Vercel (Settings → Environment Variables):
   - `TURSO_URL` + `TURSO_AUTH_TOKEN` (wajib biar data persist)
   - `SESSION_SECRET` (random string)
   - `BASE_URL` = `https://<your-app>.vercel.app`
   - `DC_CLIENT_ID` + `DC_CLIENT_SECRET` (Discord — supaya user bisa connect DC real)
   - `X_CLIENT_ID` + `X_CLIENT_SECRET` (X — supaya user bisa connect X real)
   - `X_VERIFY_MODE=honor` (free, instant)
5. Deploy → test.

> ⚠️ **Turso wajib** di Vercel: filesystem serverless itu ephemeral & read-only. Tanpa Turso, data (user/giveaway/winner) hilang di tiap cold start. Local SQLite HANYA untuk dev.

## Setup Turso (free cloud DB — SQLite compatible)
```bash
# 1. Install CLI
curl -sSfL https://get.turso.tech/install.sh | bash
# 2. Login (buat akun free di turso.tech)
turso auth login
# 3. Buat database
turso db create givefuel
# 4. Dapat URL + token
turso db show givefuel          # → URL (libsql://givefuel-xxx.turso.io)
turso db tokens create givefuel # → auth token
# 5. Simpan ke env:
#    TURSO_URL=libsql://givefuel-xxx.turso.io
#    TURSO_AUTH_TOKEN=<token>
```

## Setup Discord OAuth (gratis — biar connect DC real)
1. https://discord.com/developers/applications → New Application → nama "GiveFuel"
2. OAuth2 → Redirects → tambah `https://<your-app>.vercel.app/auth/dc/callback`
3. OAuth2 → bot scope: centang **identify** + **guilds** (bukan scope bot)
4. Copas **Client ID** + **Client Secret** → env `DC_CLIENT_ID` / `DC_CLIENT_SECRET`

## Setup X OAuth (biar connect X real — connect gratis, verify honor)
1. https://developer.x.com/en/portal/dashboard → create app
2. User authentication settings → **Web app** + OAuth 2.0 (PKCE)
3. Redirect URI: `https://<your-app>.vercel.app/auth/x/callback`
4. Scopes: `tweet.read users.read offline.access`
5. Copas **Client ID** + **Client Secret** → env `X_CLIENT_ID` / `X_CLIENT_SECRET`
> Catatan: connect X (login user) itu GRATIS. Yang berbayar cuma kalau mau verify follower real via API (X_VERIFY_MODE=xapi ~$100/mo). Pakai `honor` = free.

## Setup Discord Bot (slash /join + announce winner)
Run as a separate long-lived process (NOT on Vercel — needs persistent WebSocket connection).

```bash
# 1. Discord Developer Portal → aplikasi "GiveFuel" → Bot tab → Build-A-Bot → copy TOKEN
# 2. Invite: OAuth2 → URL Generator → scope "applications.commands" + "bot"
#    + permissions: Send Messages, Embed Links, Use Slash Commands, Read Message History
# 3. Env (lihat .env.bot.example):
#    DC_BOT_TOKEN=...   GIVEFUEL_BASE_URL=https://givefuel.vercel.app
#    TURSO_URL=...      TURSO_AUTH_TOKEN=...
#    DC_ANNOUNCE_SECRET=...   GIVEFUEL_ANNOUNCE_PORT=4210
# 4. Jalankan:  node bot/discord-bot.js   (background/tmux)
```
Slash commands:
- `/giveaways` — list giveaway open
- `/join <id>` — ikut giveaway dari Discord (auto-verify; join_dc task = otomatis ok karena user di server)
- `/status` — cek akun lo terhubung ke GiveFuel
- `/announce <id>` — set channel ini jadi tempat announce winner

Wire ke web server (Vercel) — env vars tambahan di server:
```
GIVEFUEL_BOT_URL=http://<bot-host>:4210
DC_ANNOUNCE_SECRET=...   # sama seperti bot
```

## Flow Giveaway → Discord (otomatis)
1. Host bikin giveaway di **website** (public/project.html atau feed)
2. Web server otomatis POST `/giveaway` ke bot (GIVEFUEL_BOT_URL)
3. Bot post **embed announce + tombol "🎟️ Join Giveaway"** ke channel Discord
4. User klik tombol → buka `https://givefuel.vercel.app/?giveaway=<id>` → auto-scroll & highlight giveaway → klik **Ikut** di web (verify task)
5. Saat host **draw** di web → server POST `/announce` → bot kirim **embed winner** ke channel

Roles: bot punya `/giveaways`, `/join`, `/status`, `/announce <id>` (set channel announce per giveaway). `/announce <id>` juga bisa dipakai utk pilih channel mana yang jadi tempat announce giveaway #id.

## Roadmap
- [ ] `require_x_repost` real verify via X API (paid) — saat ini honor
- [ ] Email/jumlah entri per user, referral
- [ ] Auto-close giveaways (cron) berdasarkan ends_at
