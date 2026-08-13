'use strict';
// X follower verification via twscrape (cookies of our OWN scraping account) — FREE, no paid X API.
//
// Approach: scrape the TARGET handle's followers and check whether the USER's
// username appears in the list. This is the most reliable server-side check
// without needing the user's own X credentials (they connect via OAuth2 and we
// only get their username).
//
// If target followers are huge (> e.g. 20k) this is expensive; see SCRAPE_LIMIT.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VENV_PY = process.env.TWSCRAPE_VENV || '/home/ubuntu/x_intel_bot/venv/bin/python';
const DB = process.env.TWSCRAPE_DB || '/home/ubuntu/x_intel_bot/accounts.db';
const SCRAPE_LIMIT = parseInt(process.env.SCRAPE_LIMIT || '8000', 10); // cap followers scanned
const TIMEOUT = parseInt(process.env.SCRAPE_TIMEOUT || '120000', 10); // 2min per check

const SCRAPER = `import sys, json, asyncio
import twscrape
from twscrape import API, AccountsPool

DB_FILE = sys.argv[1]
target = sys.argv[2].lstrip('@').lower()
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 8000

async def main():
    api = API(AccountsPool(db_file=DB_FILE), debug=False)
    found = []
    count = 0
    try:
        async for user in api.followers(target, limit=limit):
            count += 1
            h = (user.username or '').lower()
            if h:
                found.append(h)
            if count >= limit:
                break
    except Exception as e:
        print(json.dumps({"count": count, "followers": found, "error": str(e)}))
        return
    print(json.dumps({"count": count, "followers": found}));

asyncio.run(main())
`;

// Check if the given username follows the target handle.
//   targetHandle: e.g. "0xskypots" (the host's handle users must follow)
//   userUsername: e.g. "alice" (the user trying to enter)
// Returns boolean.
async function checkFollow(targetHandle, userUsername) {
  const scriptPath = path.join(__dirname, '..', 'scripts', '__xscrape_check.py');
  fs.writeFileSync(scriptPath, SCRAPER);

  const target = targetHandle.replace(/^@/, '').trim().toLowerCase();
  const player = (userUsername || '').replace(/^@/, '').trim().toLowerCase();
  if (!target || !player) return false;

  try {
    const out = execFileSync(VENV_PY, [scriptPath, DB, target, String(SCRAPE_LIMIT)], {
      env: { ...process.env },
      timeout: TIMEOUT,
      maxBuffer: 1024 * 1024 * 50,
    });
    const data = JSON.parse(out.toString().trim().split('\n').pop());
    if (data.error) console.error('[xscrape] upstream error:', data.error);
    return (data.followers || []).includes(player);
  } catch (e) {
    console.error('[xscrape] check failed:', e.message || e);
    return false; // fail closed
  }
}

module.exports = { checkFollow, SCRAPE_LIMIT };
