#!/usr/bin/env node
// Pull WHOOP recovery / sleep / cycles into data.json (Path A — see SYNC.md).
// Reads + refreshes tokens in .secrets.json (gitignored). No secrets live in this file.
// Usage: node whoop-sync.js   →  then: git add data.json && git commit && git push
'use strict';
const fs = require('fs');

const SECRETS = '.secrets.json';
const DATA = 'data.json';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer';

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const dateOf = (rec) => (rec.created_at || rec.start || '').slice(0, 10);

async function refreshToken(s) {
  const w = s.whoop;
  if (!w.refresh_token) throw new Error('No refresh_token in .secrets.json — run the one-time OAuth first (see SYNC.md).');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: w.refresh_token,
    client_id: w.client_id,
    client_secret: w.client_secret,
    scope: 'offline',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status} ${await res.text()}`);
  const t = await res.json();
  w.access_token = t.access_token;
  if (t.refresh_token) w.refresh_token = t.refresh_token; // WHOOP rotates the refresh token
  w.token_expires_in = t.expires_in;
  fs.writeFileSync(SECRETS, JSON.stringify(s, null, 2) + '\n');
  return t.access_token;
}

async function getRecords(path, accessToken, limit = 25) {
  const res = await fetch(`${API}${path}?limit=${limit}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.next_token) console.log(`  note: ${path} has more pages (next_token present) — pulling first ${limit} only`);
  return (json.records || []).filter((r) => r.score_state === 'SCORED' && r.score);
}

(async () => {
  const s = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  console.log('Refreshing WHOOP access token…');
  const at = await refreshToken(s);

  console.log('Fetching recovery / sleep / cycles…');
  const [rec, slp, cyc] = await Promise.all([
    getRecords('/v2/recovery', at),
    getRecords('/v2/activity/sleep', at),
    getRecords('/v2/cycle', at),
  ]);

  const recovery = rec
    .map((r) => ({
      date: dateOf(r),
      recovery_score: r.score.recovery_score,
      hrv_rmssd_ms: round(r.score.hrv_rmssd_milli),
      resting_hr: r.score.resting_heart_rate,
      skin_temp_c: round(r.score.skin_temp_celsius),
      spo2: round(r.score.spo2_percentage),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sleep = slp
    .filter((r) => !r.nap)
    .map((r) => {
      const ss = r.score.stage_summary || {};
      const asleepMs = (ss.total_light_sleep_time_milli || 0) + (ss.total_slow_wave_sleep_time_milli || 0) + (ss.total_rem_sleep_time_milli || 0);
      return {
        date: dateOf(r),
        sleep_performance_pct: round(r.score.sleep_performance_percentage, 0),
        hours: round(asleepMs / 3600000),
        efficiency_pct: round(r.score.sleep_efficiency_percentage, 0),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const cycles = cyc
    .map((r) => ({
      date: dateOf(r),
      day_strain: round(r.score.strain),
      avg_hr: r.score.average_heart_rate,
      kilojoule: round(r.score.kilojoule, 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const now = new Date().toISOString();
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  data.syncedAt = now;
  data.sources = { ...(data.sources || {}), whoop: true };
  data.whoop = { connected: true, syncedAt: now, recovery, sleep, cycles };
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');

  console.log(`Done → recovery: ${recovery.length}, sleep: ${sleep.length}, cycles: ${cycles.length}`);
  if (recovery.length) console.log(`Latest recovery (${recovery.at(-1).date}): ${recovery.at(-1).recovery_score}% · HRV ${recovery.at(-1).hrv_rmssd_ms} · RHR ${recovery.at(-1).resting_hr}`);
})().catch((e) => { console.error('SYNC FAILED:', e.message); process.exit(1); });
