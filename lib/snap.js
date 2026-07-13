// lib/snap.js — lightweight 24h-delta snapshots for the TOKE oracle.
// Stores one hourly bucket per metric set in a KV store (Upstash REST / Vercel KV),
// reads the ~24h-ago bucket, and returns deltas. No SDK dependency (REST via fetch).
// Gracefully no-ops if no KV is configured (deltas come back null, same as today).

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ENABLED = !!(KV_URL && KV_TOKEN);

const HOUR_MS = 3600000;
const TTL_SECONDS = 60 * 60 * 48; // keep ~48h of buckets
const KEY = (bucket) => `toke:oracle:snap:${bucket}`;

async function kv(parts) {
  const path = parts.map((p) => encodeURIComponent(String(p))).join('/');
  const r = await fetch(`${KV_URL}/${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  return (await r.json()).result;
}

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? ((a - b) / b) * 100 : null);
const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a - b : null);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * Record the current metrics in this hour's bucket and return 24h deltas vs the bucket ~24h ago.
 * @param {{price:number, liq:number, mcap:number, holders:number}} cur
 * @returns {Promise<object>} delta fields (or {} if KV off / no baseline yet)
 */
export async function recordAndDeltas(cur) {
  if (!ENABLED) return {};
  try {
    const bucket = Math.floor(Date.now() / HOUR_MS);
    // write current bucket (idempotent within the hour) + refresh TTL
    await kv(['set', KEY(bucket), JSON.stringify(cur)]);
    await kv(['expire', KEY(bucket), TTL_SECONDS]).catch(() => {});
    // read the snapshot nearest to ~24h ago. We can't assume an hourly cron
    // (Vercel Hobby crons run at most daily), so traffic-driven buckets may have
    // gaps — accept the closest bucket within ±3h, preferring exactly 24h.
    let past = null;
    for (const off of [24, 23, 25, 22, 26, 21, 27]) {
      const v = await kv(['get', KEY(bucket - off)]).catch(() => null);
      if (v) { past = v; break; }
    }
    if (!past) return {}; // no ~24h baseline yet (first day of warm-up)
    let p;
    try {
      p = JSON.parse(past);
    } catch {
      return {};
    }
    return {
      price_change_pct_24h: round2(pct(cur.price, p.price)),
      liquidity_change_pct_24h: round2(pct(cur.liq, p.liq)),
      mcap_change_pct_24h: round2(pct(cur.mcap, p.mcap)),
      holders_change_24h: diff(cur.holders, p.holders)
    };
  } catch {
    return {}; // never let snapshotting break the oracle
  }
}

// --- last-good oracle payload (degraded-upstream guard) -------------------
// When DexScreener serves a degraded pair list (a known major pool missing),
// the oracle serves this last-good payload instead of publishing skewed numbers.
// 2026-07-13 incident: DexScreener dropped the largest pool (6cVM…) from responses
// to Vercel's egress → price/mcap/liquidity collapsed platform-wide and a false
// -80% liquidity delta was recorded. See mctoken-rebuild/HANDOFF.md.

const LAST_GOOD_KEY = 'toke:oracle:last_good';
const LAST_GOOD_TTL = 60 * 60 * 24 * 7; // 7 days

/** Persist the latest known-good oracle payload. Best-effort, never throws. */
export async function setLastGood(payload) {
  if (!ENABLED) return;
  try {
    // Upstash REST: send the value as the POST body so it isn't path/size-limited
    const r = await fetch(`${KV_URL}/set/${LAST_GOOD_KEY}?EX=${LAST_GOOD_TTL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`kv set ${r.status}`);
  } catch {
    /* best-effort */
  }
}

/** Read the last known-good oracle payload, or null. Never throws. */
export async function getLastGood() {
  if (!ENABLED) return null;
  try {
    const v = await kv(['get', LAST_GOOD_KEY]);
    if (!v) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return null;
  }
}
