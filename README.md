# moby-cli

Unofficial terminal client and typed TypeScript API client for [Moby](https://moby.co) research (stock picks, news, earnings summaries, AI portfolios and market intelligence reports).

Moby has no public API. This tool calls the same private web API that `app.moby.co` uses (`https://api.moby.co/api/v1`). The API can change at any time. You need your own paid Moby account. This project contains no Moby content and no credentials.

## Install

Requires [Bun](https://bun.sh) 1.1 or later.

```sh
git clone https://github.com/jeffscottward/moby-cli && cd moby-cli
bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/moby-cli
```

## Usage

```sh
moby-cli ideas --limit 5                 # latest stock picks
moby-cli list news --limit 10            # news | earnings | portfolios | reports | digest | ideas
moby-cli list ideas --query nvidia       # filter one type by text
moby-cli get stocks-example-corp-exmp    # one document by slug
moby-cli search nvidia                   # articles + companies
moby-cli export earnings --limit 200 --out earnings.json
moby-cli earnings 2026-11-03 2026-11-07
moby-cli auth status                     # token expiry
moby-cli ideas --json | jq '.[].stockSymbol'
```

`--json` prints exact JSON without colors. `--no-cache` skips the local cache.

## Authentication

The CLI reads `~/.config/moby/auth.json` (mode `0600`; the directory can be changed with `MOBY_CONFIG_DIR`):

```json
{
  "mobyToken": "<Moby service JWT, sent as Authorization: Bearer>",
  "firebaseApiKey": "<Firebase web API key of app.moby.co>",
  "firebaseRefreshToken": "<Firebase refresh token>"
}
```

How to get the values from a browser where you are logged in to `app.moby.co`:

- `mobyToken`: DevTools → Network → any request to `api.moby.co` → `Authorization` header, without `Bearer `. It is valid for about 30 days.
- `firebaseApiKey` and `firebaseRefreshToken`: DevTools → Application → IndexedDB → `firebaseLocalStorageDb` → `firebaseLocalStorage` → the `firebase:authUser:…` entry → `value.apiKey` and `value.stsTokenManager.refreshToken`.

With the two Firebase values present, the client renews `mobyToken` by itself when it is less than 24 hours from expiry or when the API returns 401 (`securetoken.googleapis.com` → `PUT /auth/refresh`). Without them, log in again and replace `mobyToken` when it expires. `MOBY_TOKEN` in the environment overrides the file (no refresh).

Never commit `auth.json`, HAR files or cookies. `.gitignore` excludes them.

## Library

```ts
import { MobyClient } from "moby-cli";
const moby = new MobyClient();            // rate limit 750 ms between calls, 10 min cache
const picks = await moby.ideas(5);
const doc = await moby.getDocument(picks.items[0]!.slug!);
const hits = await moby.search("nvidia");
```

## API map (recovered)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/content/documents` | Body `{type, sortBy, direction, page, perPage, filters, query, bannerType}`. Types: `stockPicksArticle`, `newsArticle`, `earningsArticle`, `aiPortfolioArticle`, `marketIntelligenceReport`, `todayDailyDigestV2` |
| GET | `/content/documents/{slug}` | Full document |
| GET | `/search/articles?query=` | Top 10 articles, counts per type, matching companies |
| GET | `/content/earnings-schedule?startDate=&endDate=` | Earnings calendar |
| PUT | `/auth/refresh` | Headers `Authorization` + `x-firebase-token`; new token in the `Authorization` response header |

Required request headers: `Authorization: Bearer …`, `x-client-platform: WEB`, `x-client-version: 4.12.0`.

## Responsible use

Use only your own subscription. Keep the request rate low (the client waits 750 ms between calls, backs off on HTTP 429 and caches responses for 10 minutes). Do not redistribute paid content. This project is not affiliated with Moby.

## Development

```sh
bun test            # synthetic fixtures only
bunx tsc --noEmit
bash scripts/secret-scan.sh
```
