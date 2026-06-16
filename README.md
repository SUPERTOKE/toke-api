# toke-api — `api.mctoken.xyz/v1`

The canonical, stable TOKE API base. Both `mctoken.xyz` and `explorer.mctoken.xyz` code against this
so the backend can move underneath without touching consumers.

## Surface
- **`/v1/oracle`** → live serverless function (`api/oracle.js`): liquidity-weighted VWAP price + total pool
  liquidity (DexScreener, key-free) + implied mcap from the canonical supply. Real-time (s-maxage 20s).
- **`/v1/<dataset>`** → proxied (Vercel rewrite) to the explorer's static contract
  `https://explorer.mctoken.xyz/api/v1/<dataset>` — single source of truth for `token`, `supply`, `holders`,
  `oracle` (static), `pools`, etc. (see `/v1` index).
- **`/v1`** and **`/`** → the contract index.
- CORS `*` on everything.

## Hosting
Vercel project **`toke-api`** (Mycelium Networks team), domain **`api.mctoken.xyz`** via a Namecheap CNAME →
Vercel. No build step (functions + rewrites only). Node 18+ global `fetch`.

## Env (optional)
- `STATIC_BASE` — explorer contract base (default `https://explorer.mctoken.xyz/api/v1`).
- `TOKE_MINT` — defaults to the canonical mint.

## Roadmap
- Add `/v1/activity` (live Helius transfers; needs `HELIUS_KEY` secret).
- Migrate the static datasets off the explorer host into a first-class store if the explorer URL ever changes.
- Fold in `cmc-toke-api` (CMC-format surface) under this base.
