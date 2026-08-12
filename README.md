# GiveawayHub — Free Web3 Giveaway Platform

Platform giveaway/quest Web3 gratis (kayak [Alphabot](https://alphabot.app) & [Atlas3](https://atlas3.io)).
Users connect X (Twitter) + Discord, verify they follow a handle / join a server, enter giveaways, host draws random winners.

## Fitur (MVP)
- 🔗 **Connect X** (OAuth2) + **Connect Discord** (OAuth2) — satu akun bisa link dua-duanya
- ✅ **Task verification**: cek user follow @handle di X, cek user member di Discord server
- 🎁 **Create giveaway**: title, prize, desc, winners count, deadline
- 🎟️ **Enter giveaway**: auto-verify tasks, `verified=1` kalau semua terpenuhi
- 🏆 **Draw winners**: random (Fisher-Yates), hanya host yang bisa draw, pemenang tersimpan

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

## Deploy / public
- Tunnel: `cloudflared tunnel --url http://localhost:3000` atau `npx localtunnel --port 3000`
- Set `BASE_URL` ke URL publik + redirect URI di X/Discord dashboard harus match.

## Roadmap
- [ ] Repost task verification (X API `retweeted` check)
- [ ] Wallet connect (EVM/Solana) — airdrop claim flow
- [ ] Email/jumlah entri per user, referral
- [ ] Auto-DM pemenang via X DM / Discord
