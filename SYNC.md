# Data Sync — Strava + WHOOP (Path A)

The app is a **static** site (GitHub Pages). It cannot safely hold OAuth secrets, so it
never calls Strava/WHOOP directly. Instead a **sync step** pulls the data and writes it to
[`data.json`](data.json), which the app fetches and renders read-only in the **History →
Connected** card.

```
Strava  ──(MCP, via Claude)──┐
                             ├──►  data.json  ──►  committed & pushed  ──►  Pages serves it  ──►  app renders
WHOOP   ──(REST API + curl)──┘
```

- **Strava** is pulled through the Strava MCP (Claude-side) — no secret needed.
- **WHOOP** is pulled with a refresh token + client secret, kept **only** in `.secrets.json`
  (gitignored). See [`.secrets.example.json`](.secrets.example.json).
- `data.json` **is** committed (it's your activity data, not a secret).
  `.secrets.json` is **never** committed.

---

## `data.json` schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "syncedAt": "ISO-8601 UTC",
  "sources": { "strava": true, "whoop": false },
  "athlete": { "name": "...", "strava_id": 0, "measurement_preference": "metric" },
  "strava": {
    "syncedAt": "...",
    "activities": [{
      "id","date","start_local","name","sport_type",
      "distance_m","moving_time_s","elapsed_time_s","elevation_gain_m",
      "avg_speed_mps","max_speed_mps","avg_cadence",
      "relative_effort","calories","achievement_count","pr_count"
    }]
  },
  "whoop": {
    "connected": false,           // flip to true once authed
    "syncedAt": null,
    "recovery": [{ "date","recovery_score","hrv_rmssd_ms","resting_hr","skin_temp_c","spo2" }],
    "sleep":    [{ "date","sleep_performance_pct","hours","efficiency_pct" }],
    "cycles":   [{ "date","day_strain","avg_hr","kilojoule" }]
  }
}
```

The app degrades gracefully: empty `whoop.recovery` / `connected:false` shows a "not connected
yet" hint; populated recovery shows a Recovery / HRV / RHR / Sleep readout.

---

## One-time WHOOP setup

### 1. Create the app (WHOOP developer dashboard)
- **Redirect URI:** `https://loteatucha.github.io/trainingapp/callback.html`
  (optionally also add `http://localhost:4178/callback.html` for local testing)
- **Privacy Policy URL:** `https://loteatucha.github.io/trainingapp/privacy.html`
- **Scopes:** `read:recovery` `read:sleep` `read:cycles` `read:workout` `read:profile` `offline`
- Save → copy the **Client ID** and **Client Secret**.

### 2. Store the secrets
Copy the example file and fill it in (this file is gitignored):
```bash
cp .secrets.example.json .secrets.json
# edit .secrets.json → client_id, client_secret
```

### 3. Authorize once
Open this URL in a browser (fill in `CLIENT_ID`; `state` can be any random ≥8-char string):
```
https://api.prod.whoop.com/oauth/oauth2/auth?response_type=code&client_id=CLIENT_ID&redirect_uri=https%3A%2F%2Floteatucha.github.io%2Ftrainingapp%2Fcallback.html&scope=read%3Arecovery%20read%3Asleep%20read%3Acycles%20read%3Aworkout%20read%3Aprofile%20offline&state=trainingapp123
```
Approve → `callback.html` shows the **authorization code** → copy it → **paste it to Claude**.
Claude exchanges it for tokens and writes the `refresh_token` into `.secrets.json`. (Token
exchange — Claude runs this; the code expires in minutes, so do it promptly):
```bash
curl -s -X POST https://api.prod.whoop.com/oauth/oauth2/token \
  -d grant_type=authorization_code -d code=THE_CODE \
  -d client_id=... -d client_secret=... \
  -d redirect_uri=https://loteatucha.github.io/trainingapp/callback.html
```

---

## Recurring sync (what "sync my data" does)

Just tell Claude **"sync my training data"**. Claude will:
1. Pull recent Strava activities via the Strava MCP and rewrite the `strava` block of `data.json`.
2. Pull WHOOP recovery / sleep / cycles by running:
   ```bash
   node whoop-sync.js
   ```
   This refreshes the access token (WHOOP **rotates** the refresh token on every refresh — the
   script saves the new one back to `.secrets.json`), fetches the WHOOP **v2** endpoints
   (`/developer/v2/recovery`, `/developer/v2/activity/sleep`, `/developer/v2/cycle`), and rewrites
   the `whoop` block with up to the 25 most-recent records each (flipping `whoop.connected` true).
   Note: WHOOP **v1** is deprecated for recovery/sleep — use v2.
3. **Deploy:** `git add data.json && git commit && git push` → Pages serves the fresh data.

The app uses a network-first service worker and fetches `data.json` with `cache:'no-store'`,
so a reload picks up new data immediately; offline, it shows the last synced copy.

---

## Optional: fully automated sync (decision needed)

To run unattended (e.g. every morning) without Claude in the loop, a scheduled agent needs the
WHOOP secrets available where it runs. Pick one before automating:
- **Local cron / scheduled Claude routine** (`/schedule`) reading `.secrets.json` on this machine.
- **Private cloud storage** (your Google Drive folder) holding the secrets, fetched at run time.
- **Graduate to Path B** (a tiny serverless function holding the secrets) for true real-time.

Until then, sync is **on-demand** — say the word and Claude runs it.
