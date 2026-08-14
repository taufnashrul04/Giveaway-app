#!/bin/bash
# Jalankan Discord bot GiveFuel (muat .env.bot)
cd "$(dirname "$0")"
set -a; source .env.bot; set +a
node bot/discord-bot.js
