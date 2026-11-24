# melune

A small local server that records what your WiiM devices play, so you can answer
questions like "what were my most-played tracks last month?" or "what mood have
I been in lately?"

It polls the WiiM/LinkPlay HTTP API on your LAN, stores discrete play events in
SQLite, and serves a lightweight dashboard. No cloud account is required for the
core history — it all stays on the machine running melune. Art is cached locally;
Last.fm is contacted only for tags when configured, Deezer for artist photos.

## Quick start

Requires Node 24 or newer (tested on Node 26). No `npm install` needed — melune
uses only Node built-ins.

```bash
cp config.example.json config.json
# edit config.json and set your WiiM's IP under "devices"
npm start
```

Open <http://127.0.0.1:8787>.

If `config.json` is missing, the first `npm start` creates it from
`config.example.json` for you.

### Finding your WiiM's IP

```bash
npm run discover
```

This sends an SSDP search, then scans the local `/24` subnet(s) and validates
responders with `getStatusEx`. If your machine has several networks, pass the
right one explicitly:

```bash
npm run discover -- 192.168.2.0/24
```

If nothing is found, get the IP from the WiiM Home app
(**Devices → Settings → Network Status**) or your router's DHCP list and set it
manually.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `host` | `127.0.0.1` | Bind address. Use `0.0.0.0` only if you want the dashboard reachable from other LAN devices. |
| `port` | `8787` | HTTP port. |
| `dataDir` | `./data` | Where `melune.db` (SQLite) is stored. |
| `pollIntervalMs` | `5000` | How often each WiiM is polled. 5s is a good tradeoff. |
| `requestTimeoutMs` | `2500` | Per-device request timeout. |
| `minPlayMs` | `30000` | Plays shorter than this are skipped tracks and are not counted. Set to `0` to keep every play. |
| `devices` | `[]` | Array of `{ "name": "...", "host": "192.168.1.50" }`. |
| `lastfm.apiKey` | `""` | Optional; enables tag-based mood inference. |

Secrets can also be supplied via environment variables, which take precedence:

```bash
LASTFM_API_KEY=... npm start
```

`MELUNE_PORT` overrides the port. WiiM devices use a self-signed HTTPS
certificate, so device requests deliberately disable certificate verification —
only point melune at devices you trust on your own LAN.

Device requests use Node's built-in HTTPS client, with a fallback to the system
`curl` binary if direct sockets are blocked by a hardened local runtime. `curl`
is only used for connection-level failures, and is not needed on normal setups.

## How plays are recorded

A naive poll loop would count the same song 12 times a minute. melune instead
tracks play sessions per device:

- A **new play** starts when the track metadata changes, the input source
  changes, the playback position jumps backwards (repeat/seek), a `stop` is
  seen, or polling resumes after a long gap.
- **Pause/resume** keeps the same play open. Listening time only accumulates
  while the player reports `play` or `loading`, so leaving a track paused for an
  hour does not inflate its duration.
- **Brief stop/start glitches, tracker restarts, and poll outages** on the same
  track are merged back into one play when the reported position keeps moving
  forward (up to a 10-minute gap). A real repeat (position jumps back near the
  start) still counts as a new play. The same cleanup runs on startup and after
  each poll, so older split plays are repaired automatically.
- **Skipped tracks are discarded.** A play shorter than `minPlayMs` (30s by
  default) is deleted instead of counted. Existing short plays are cleaned up
  on startup, and the threshold can be changed in `config.json`.
- WiiM metadata is often UTF-8 encoded as hex; melune decodes it and treats
  `unknow`/`Unknown` as missing.
- Tracks are keyed by normalized artist + title + album, so the same song from
  different sources still rolls up into one entry in the charts.

The dashboard offers **Today / 7 days / 30 days / All time** ranges and a device
filter, with most-played tracks, top artists, mood mix, activity timeline, and
recent plays. **Devices** scans the LAN and lets you add or remove WiiM
devices without editing `config.json` or restarting the server. Removing a
device stops polling immediately but keeps its listening history.

Open <http://127.0.0.1:8787/?demo=1> to preview the Activity card with
example bars. Demo mode only affects that card; your real data is untouched.

The default dark design is unchanged. Add `?theme=light` to use the light color
palette, e.g. <http://127.0.0.1:8787/?theme=light> (combine with `&demo=1` if
needed). Both themes share the same layout and CSS, so future changes apply to
both automatically.

## Album covers

When WiiM reports an album art URL, melune fetches it server-side and caches it
under `data/art/`. The dashboard loads covers from the local API, so the browser
never talks to the CDN and repeated views don't re-download artwork. Cached
images are refreshed after seven days; if the source is unreachable, the last
cached copy is still served. Sources without artwork get a small placeholder.

Top artist photos are looked up from Deezer's public artist API and cached the
same way under `data/art/`. No API key is needed, and artist names are resolved
once per week. If no matching photo is found, the card shows a placeholder
instead of an album cover.

## Mood tags

Mood inference is optional and best-effort. When configured, each newly seen
track is enriched in the background with **Last.fm** `track.getInfo` tags
(with a `track.search` fallback).

Tags are mapped to moods (`happy`, `energetic`, `calm`, `sad`, `focused`,
`romantic`, `nostalgic`, `intense`, `dreamy`) using keyword rules in
`src/mood.js`. Without an API key, play recording still works and the mood panels
simply stay empty.

> Enrichment sends artist/track names to Last.fm; playback history itself is
> never uploaded.

## API

All endpoints are unauthenticated and intended for localhost use.

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Uptime, poller state, enrichment counters. |
| `GET /api/devices` | Devices, online state, last error, and current track. |
| `GET /api/discover?subnet=192.168.2.0/24` | Scan for WiiM devices. The `subnet` parameter is optional. |
| `POST /api/devices` | Add `{ "name": "...", "host": "..." }` to config and start polling it. |
| `DELETE /api/devices` | Stop tracking `{ "host": "..." }` and remove it from config. Past plays are kept. |
| `GET /api/stats?range=week&device=<id>` | Totals, top tracks/artists, moods, sources, daily timeline. `range` is `today`, `week`, `month`, or `all`. |
| `GET /api/plays?range=week&device=<id>&limit=50` | Recent play events. |
| `GET /api/art/:trackId` | Cached album cover image for a track. |
| `GET /api/tracks/:id` | Track details, tags, mood scores. |
| `GET /api/meta` | App version and mood legend/colors. |

## Scripts

```bash
npm start       # run the server
npm run dev     # run with --watch
npm run discover # find WiiM devices via SSDP
npm test        # run built-in tests
```

## Storage

SQLite lives at `data/melune.db` (WAL mode), with cached artwork in `data/art/`.
Back it up by copying the whole `data/` directory while the server is stopped.
Schema is created automatically on first run.

## Roadmap

- Better handling of metadata-free sources (AUX/Bluetooth) and radio streams.
- Per-day mood timeline and listening-streak stats.
- Import/export of play history.
- Optional push updates to the dashboard instead of 15-second polling.
