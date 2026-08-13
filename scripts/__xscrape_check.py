import sys, json, asyncio
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
