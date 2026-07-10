// api/oracle.js — live TOKE oracle for api.mctoken.xyz/v1/oracle
// Liquidity-weighted VWAP price + total pool liquidity from DexScreener (key-free),
// implied market cap from the canonical TOKE API supply. Same envelope shape as the
// rest of the TOKE API contract so consumers (mctoken.xyz site + explorer) are uniform.

import { recordAndDeltas } from '../lib/snap.js';

const MINT = process.env.TOKE_MINT || 'AmgUMQeqW8H74trc8UkKjzZWtxBdpS496wh4GLy2mCpo';
const STATIC_BASE = (process.env.STATIC_BASE || 'https://explorer.mctoken.xyz/api/v1').replace(/\/+$/, '');

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'public, s-maxage=20, stale-while-revalidate=40');
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
    return res.status(204).end();
  }

  const envelope = (data, extra = {}) => ({
    dataset: 'oracle',
    version: 'v1',
    as_of: new Date().toISOString(),
    chain: 'solana-mainnet',
    visibility: 'l2',
    source: extra.source || { live: 'dexscreener' },
    data
  });

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`, {
      headers: { Accept: 'application/json' }
    });
    if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
    const j = await r.json();

    const pairs = (j.pairs || [])
      .filter((p) => p.liquidity && +p.liquidity.usd > 0)
      .sort((a, b) => +b.liquidity.usd - +a.liquidity.usd);

    let liq = 0;
    let priceWeighted = 0;
    let vol24 = 0;
    for (const p of pairs) {
      const L = +p.liquidity.usd || 0;
      liq += L;
      priceWeighted += (+p.priceUsd || 0) * L;
      vol24 += +(p.volume && p.volume.h24) || 0;
    }
    const price = liq ? priceWeighted / liq : +(pairs[0] || {}).priceUsd || 0;

    // 24h price change from the deepest-liquidity pair (DexScreener)
    const topPairChange = Number((pairs[0] || {})?.priceChange?.h24);
    const price_change_h24 = Number.isFinite(topPairChange) ? topPairChange : null;

    // implied mcap from the canonical TOKE API supply (single source of truth)
    let supply = null;
    try {
      const t = await fetch(`${STATIC_BASE}/token.json`, { headers: { Accept: 'application/json' } });
      if (t.ok) {
        const tj = await t.json();
        const s = Number(tj?.data?.current_supply);
        if (Number.isFinite(s) && s > 0) supply = s;
      }
    } catch {
      /* non-fatal: mcap falls back to null */
    }

    const implied_mcap_usd =
      Number.isFinite(price) && price > 0 && Number.isFinite(supply) && supply > 0
        ? price * supply
        : null;

    // canonical holder count (for the holders 24h delta) from the TOKE API
    let holders = null;
    try {
      const h = await fetch(`${STATIC_BASE}/_lean_stats.json`, { headers: { Accept: 'application/json' } });
      if (h.ok) {
        const hj = await h.json();
        const n = Number(hj?.holders);
        if (Number.isFinite(n) && n > 0) holders = n;
      }
    } catch {
      /* non-fatal */
    }

    // record an hourly snapshot + compute 24h deltas (no-op until a KV is configured + ~24h warm-up)
    const deltas = await recordAndDeltas({ price, liq, mcap: implied_mcap_usd, holders });

    return res.status(200).json(
      envelope({
        liquidity_weighted_price_usd: price,
        price_change_h24: price_change_h24,
        total_pool_liquidity_usd: Math.round(liq * 100) / 100,
        total_volume_h24_usd: Math.round(vol24 * 100) / 100,
        implied_mcap_usd: implied_mcap_usd != null ? Math.round(implied_mcap_usd) : null,
        supply_used: supply,
        holders,
        liquidity_change_pct_24h: deltas.liquidity_change_pct_24h ?? null,
        holders_change_24h: deltas.holders_change_24h ?? null,
        mcap_change_pct_24h: deltas.mcap_change_pct_24h ?? null,
        method: 'live liquidity-weighted VWAP (DexScreener); mcap = price × TOKE-API supply',
        pools: pairs.map((p) => ({
          dex: p.dexId,
          quote: p.quoteToken && p.quoteToken.symbol,
          priceUsd: +p.priceUsd,
          liquidityUsd: +p.liquidity.usd,
          cite: { type: 'account', ref: p.pairAddress }
        }))
      })
    );
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json(envelope(null, { source: { error: String(e) } }));
  }
}
