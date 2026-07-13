// api/oracle.js — live TOKE oracle for api.mctoken.xyz/v1/oracle
// Liquidity-weighted VWAP price + total pool liquidity from DexScreener (key-free),
// implied market cap from the canonical TOKE API supply. Same envelope shape as the
// rest of the TOKE API contract so consumers (mctoken.xyz site + explorer) are uniform.

import { recordAndDeltas, getLastGood, setLastGood } from '../lib/snap.js';

const MINT = process.env.TOKE_MINT || 'AmgUMQeqW8H74trc8UkKjzZWtxBdpS496wh4GLy2mCpo';
const STATIC_BASE = (process.env.STATIC_BASE || 'https://explorer.mctoken.xyz/api/v1').replace(/\/+$/, '');
// Degraded-upstream guard: a pool from the canonical registry (pools.json) with at
// least this much liquidity at last build must appear in DexScreener's response,
// otherwise the response is treated as degraded and last-good is served instead.
// (2026-07-13: DexScreener dropped the largest pool from responses to Vercel's egress.)
const GUARD_MIN_LIQ_USD = Number(process.env.ORACLE_GUARD_MIN_LIQ_USD) || 1000;
const GUARD_ENABLED = process.env.ORACLE_GUARD !== '0';

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

    // ⚠️ DexScreener's token endpoint returns pairs where TOKE is base OR quote. For
    // quote-side pairs (e.g. DANK/TOKE) `priceUsd` is the BASE token's price, NOT TOKE's —
    // blending those into the VWAP silently skews the published TOKE price. Price therefore
    // uses base-side pairs only; liquidity + volume still sum across ALL pairs (ecosystem-wide).
    const basePairs = pairs.filter((p) => p.baseToken && p.baseToken.address === MINT);

    // --- degraded-upstream guard -------------------------------------------
    // Cross-check the pair list against the canonical pool registry. If a major
    // known pool is missing, DexScreener is serving us a degraded view: publish
    // the last known-good payload (flagged) rather than skewed numbers, and do
    // NOT record the degraded values into the 24h delta buckets.
    let missingPools = [];
    if (GUARD_ENABLED) {
      try {
        const pr = await fetch(`${STATIC_BASE}/pools.json`, { headers: { Accept: 'application/json' } });
        if (pr.ok) {
          const pj = await pr.json();
          const registry = Array.isArray(pj?.data) ? pj.data : [];
          const seen = new Set(pairs.map((p) => p.pairAddress));
          missingPools = registry
            .filter((p) => p && p.pair && Number(p.liquidity_usd) >= GUARD_MIN_LIQ_USD && !seen.has(p.pair))
            .map((p) => p.pair);
        }
      } catch {
        /* registry unreachable → guard can't judge; proceed live */
      }
    }
    if (missingPools.length > 0) {
      const lastGood = await getLastGood();
      if (lastGood && lastGood.data) {
        // serve last-good, honestly labeled; envelope as_of stays "now",
        // data_as_of says how old the numbers actually are
        return res.status(200).json(
          envelope(lastGood.data, {
            source: {
              live: 'dexscreener',
              degraded: true,
              served: 'last_good',
              data_as_of: lastGood.as_of || null,
              missing_pools: missingPools
            }
          })
        );
      }
      // no last-good available: fall through and publish live numbers, but the
      // response is flagged and the delta buckets are protected below.
    }
    const degraded = missingPools.length > 0;

    let liq = 0;
    let vol24 = 0;
    for (const p of pairs) {
      liq += +p.liquidity.usd || 0;
      vol24 += +(p.volume && p.volume.h24) || 0;
    }
    let priceLiq = 0;
    let priceWeighted = 0;
    for (const p of basePairs) {
      const L = +p.liquidity.usd || 0;
      priceLiq += L;
      priceWeighted += (+p.priceUsd || 0) * L;
    }
    const price = priceLiq ? priceWeighted / priceLiq : +(basePairs[0] || pairs[0] || {}).priceUsd || 0;

    // 24h price change from the deepest-liquidity BASE pair (DexScreener)
    const topPairChange = Number((basePairs[0] || {})?.priceChange?.h24);
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

    // record an hourly snapshot + compute 24h deltas (no-op until a KV is configured + ~24h warm-up).
    // Degraded responses never enter the delta buckets — that's how a false -80%
    // liquidity delta got published on 2026-07-13.
    const deltas = degraded ? {} : await recordAndDeltas({ price, liq, mcap: implied_mcap_usd, holders });

    const payload = {
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
        method: 'live liquidity-weighted VWAP over TOKE-base pairs (DexScreener); liquidity/volume summed over all pairs; mcap = price × TOKE-API supply',
        pools: pairs.map((p) => ({
          dex: p.dexId,
          base: p.baseToken && p.baseToken.symbol,
          quote: p.quoteToken && p.quoteToken.symbol,
          priceUsd: +p.priceUsd,
          in_vwap: !!(p.baseToken && p.baseToken.address === MINT),
          liquidityUsd: +p.liquidity.usd,
          cite: { type: 'account', ref: p.pairAddress }
        }))
    };

    if (!degraded) {
      // remember this payload as last-good for the guard (best-effort)
      await setLastGood({ as_of: new Date().toISOString(), data: payload });
      return res.status(200).json(envelope(payload));
    }
    // degraded but no last-good baseline: publish live numbers, honestly flagged
    return res.status(200).json(
      envelope(payload, {
        source: { live: 'dexscreener', degraded: true, served: 'live_partial', missing_pools: missingPools }
      })
    );
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json(envelope(null, { source: { error: String(e) } }));
  }
}
