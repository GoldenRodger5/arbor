/**
 * MLB bullpen stats fetcher — uses the official MLB Stats API (statsapi.mlb.com).
 *
 * The web search that the prompt used to rely on was inconsistent:
 * sometimes Sonnet couldn't surface bullpen ERA, triggering a Hard NO on
 * data absence. This module resolves that: bullpen stats are structured,
 * authoritative, and free. We pull season / L30D / L7D ERA per team and
 * cache for 30 min so the dashboard + prompt share the same ground truth.
 *
 * Endpoint pattern (verified):
 *   /api/v1/teams/{id}/stats?stats=byDateRange&group=pitching
 *     &sitCodes=r&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&season=YYYY
 *   sitCode 'r' = relief appearances only (excludes starters).
 */

import { appendFileSync } from 'fs';

// Kalshi / ESPN 3-letter abbrev → MLB Stats API team ID.
// Our abbrev map normalizes 'CHW'↔'CWS' elsewhere — we key on the Kalshi form.
const MLB_TEAM_IDS = {
  ATH: 133, ATL: 144, AZ: 109, BAL: 110, BOS: 111, CHC: 112, CIN: 113,
  CLE: 114, COL: 115, CWS: 145, DET: 116, HOU: 117, KC: 118, LAA: 108,
  LAD: 119, MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, PHI: 143,
  PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139, TEX: 140,
  TOR: 141, WSH: 120,
  // Legacy / alt spellings that may arrive from various feeds
  CHW: 145, ARI: 109, OAK: 133, NYA: 147, NYN: 121, SDN: 135, SFN: 137,
  SLN: 138, TBA: 139, WAS: 120, CUB: 112, REDS: 113,
};

const cache = new Map(); // `${abbr}` → { at, data }
const TTL_MS = 30 * 60 * 1000; // 30 min

function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchWindow(teamId, daysBack, season) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86_400_000);
  const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=byDateRange`
    + `&group=pitching&sitCodes=r`
    + `&startDate=${ymd(start)}&endDate=${ymd(end)}&season=${season}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const s = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!s || s.era == null) return null;
    return {
      era: parseFloat(s.era),
      whip: parseFloat(s.whip ?? '0'),
      ip: parseFloat(s.inningsPitched ?? '0'),
      games: s.gamesPlayed ?? null,
      appearances: s.appearances ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Returns { season, l30d, l7d } where each is { era, whip, ip, games } or null.
 * Returns null entirely if the team abbrev isn't mapped or the API is down.
 */
export async function getBullpenStats(abbr) {
  if (!abbr) return null;
  const key = abbr.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const teamId = MLB_TEAM_IDS[key];
  if (!teamId) return null;

  const season = new Date().getUTCFullYear();
  const [seasonStats, l30d, l7d] = await Promise.all([
    fetchWindow(teamId, 180, season),  // effectively season-to-date
    fetchWindow(teamId, 30, season),
    fetchWindow(teamId, 7, season),
  ]);

  // Need at least one window to be useful
  if (!seasonStats && !l30d && !l7d) return null;

  const data = { season: seasonStats, l30d, l7d, fetchedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Format for prompt injection. Returns a short human-readable line or null.
 * Example: "ATL bullpen: season 2.85 ERA (164 IP) · L30D 3.24 (92 IP) · L7D 4.78 (49 IP)"
 */
export function formatBullpenLine(abbr, stats) {
  if (!stats) return null;
  const parts = [];
  if (stats.season?.era != null) parts.push(`season ${stats.season.era.toFixed(2)} ERA (${stats.season.ip.toFixed(0)} IP)`);
  if (stats.l30d?.era != null)   parts.push(`L30D ${stats.l30d.era.toFixed(2)} (${stats.l30d.ip.toFixed(0)} IP)`);
  if (stats.l7d?.era != null)    parts.push(`L7D ${stats.l7d.era.toFixed(2)} (${stats.l7d.ip.toFixed(0)} IP)`);
  return parts.length ? `${abbr.toUpperCase()} bullpen: ${parts.join(' · ')}` : null;
}

/**
 * Tier label for the graduated-penalty prompt rules.
 * elite    < 3.5
 * good     3.5–4.0
 * average  4.0–4.5
 * below    4.5–5.0
 * poor     ≥ 5.0
 * unknown  — no data
 */
export function bullpenTier(stats) {
  const era = stats?.l30d?.era ?? stats?.season?.era;
  if (era == null) return 'unknown';
  if (era < 3.5) return 'elite';
  if (era < 4.0) return 'good';
  if (era < 4.5) return 'average';
  if (era < 5.0) return 'below';
  return 'poor';
}

/** Simple JSONL logger for diagnostics. */
export function logBullpenLookup(abbr, stats, tier) {
  try {
    appendFileSync('./logs/bullpen-lookups.jsonl', JSON.stringify({
      at: new Date().toISOString(), abbr, tier,
      seasonERA: stats?.season?.era ?? null,
      l30dERA: stats?.l30d?.era ?? null,
      l7dERA: stats?.l7d?.era ?? null,
    }) + '\n');
  } catch { /* ignore */ }
}
