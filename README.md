# melune

A local listening recorder for WiiM devices. melune polls the WiiM/LinkPlay API
on your LAN, turns those polls into discrete play events, stores them in SQLite,
and serves a dashboard for exploring what you listened to and when.

Everything runs on the machine that starts melune. There is no account, no cloud
sync, and no `npm install` — the server uses only Node built-ins, and the UI is
plain JavaScript and CSS. Artwork is cached locally. MusicBrainz supplies mood
tags, Deezer supplies artist photos, and local metadata inference is the
offline fallback.

## Features

- Per-device play detection with pause handling, deduplication, and repeat
  detection.
- sqlite storage with automatic schema creation, cleanup, and repair.
- Dashboard that starts on **Today** and supports **Today / 7 days /
  30 days / All time** ranges plus a device filter.
- Charts for most-played tracks, top artists, mood mix, daily activity, and
  recent plays.
- Local album-art cache with stale fallback; weekly Deezer artist photos.
- MusicBrainz tag-based moods with offline local inference and stable per-track
  colors. No API key is needed.
- Device discovery and add/remove from the dashboard, no restart required.
- One-click **Delete data** that wipes history and cached art but keeps devices.

## Requirements

- **Node.js 24 or newer** (melune uses `node:sqlite`; developed on Node 26).
- A WiiM device reachable from this machine on the same LAN.
- `curl` is optional. It is used only as a fallback when Node's direct HTTPS
  sockets cannot reach a hardened local runtime.
- Internet access is optional. Without it, local moods and colors still work;
  MusicBrainz tags and Deezer artist photos are skipped.

WiiM devices use self-signed HTTPS certificates, so certificate verification is
disabled for device requests. Only point melune at devices you trust on your own
network.

## Quick start

```bash
cp config.example.json config.json
# Set devices[].host to your WiiM's IP, or leave devices empty and add it in the UI.
npm start
```

Open <http://127.0.0.1:8787>.

If `config.json` is missing, the first start copies `config.example.json` into
place for you. The dashboard is always dark; query parameters such as
`?theme=light` and `?demo=1` are ignored and never affect your data.

### Finding your WiiM's IP

```bash
npm run discover
```

Discovery first sends an SSDP search, then probes local `/24` subnets and
validates responders through the WiiM status API. If multicast is blocked or the
wrong network is selected, pass a subnet explicitly:

```bash
npm run discover -- 192.168.2.0/24
```

You can also find the IP in the WiiM Home app under **Devices → Settings →
Network Status**, or in your router's DHCP client list. Devices can then be
added from the dashboard's **Devices** dialog without editing `config.json`.

## Configuration

`config.json` is created from `config.example.json` on first run if it does not
exist.

| Key | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` | Bind address. Use `0.0.0.0` only on a trusted LAN; the API has no authentication. |
| `port` | `8787` | HTTP port for the dashboard and API. |
| `dataDir` | `./data` | Directory for `melune.db`, its WAL files, and `art/`. |
| `pollIntervalMs` | `5000` | How often each device is polled. 5s is a good tradeoff. |
| `requestTimeoutMs` | `2500` | Per-request timeout for device calls. |
| `minPlayMs` | `30000` | Plays shorter than this are treated as skips and discarded. Set to `0` to keep every play. |
| `devices` | `[]` | Array of `{ "name": "Living Room", "host": "192.168.1.50" }`. |

No environment variables are required. They only override config values when
you need them:

```bash
# Example overrides — omit any you do not need.
export MELUNE_PORT=8788
export MELUNE_CONFIG=./my-config.json
export MELUNE_DISCOVER_SUBNET=192.168.2.0/24

npm start
```

No API key is needed for anything. `MELUNE_DISCOVER_SUBNET` is optional and only
sets the default subnet used by `npm run discover`.

The **Devices** dialog writes added/removed devices back to `config.json`
automatically.

## Dashboard

The dashboard refreshes every 15 seconds and starts on the **Today** range.
Use the tabs to switch between Today, 7 days, 30 days, and All time, or the
device selector to focus on one WiiM.

It shows:

- Now-playing cards for configured devices, including status, source, progress,
  and mood when known.
- Summary counters: plays, unique tracks, estimated listening time, and active
  days.
- Top 20 tracks and top 8 artists for the selected range.
- Mood mix, with colors and labels from the mood legend; untagged tracks still
  get stable colors in now-playing cards and activity.
- Daily activity for the last 21 days.
- The 30 most recent play events, with device, source, and listened duration.

There is no light theme and no demo dataset. Every chart always comes from the
local database.

## How plays are recorded

A naive poll loop would count the same song once per poll. melune instead keeps
play sessions per device:

- A **new play** starts when track metadata changes, the input source changes,
  the reported position jumps backwards, a `stop` is seen, or polling resumes
  after a long gap.
- **Pause** keeps the play open but does not add listening time. Only `play` and
  `loading` states accumulate duration.
- Brief stop/start glitches, tracker restarts, and poll outages on the same track
  are merged back into one play when the position keeps moving forward, up to a
  ten-minute gap. A real repeat starts a new play. The same cleanup runs on
  startup and after each poll.
- Plays shorter than `minPlayMs` are discarded as skipped tracks. Existing short
  plays are cleaned up at startup.
- WiiM metadata is often UTF-8 encoded as hex; melune decodes it and treats
  `unknow`/`Unknown` as missing.
- Tracks are keyed by normalized artist + title + album, so the same song from
  different sources rolls up into one chart entry.

Source labels come from WiiM status where available. Vendor names refine common
cases such as Tidal, Roon, and radio/vTuner; older history recorded simply as
`wiim` is left unchanged.

## Metadata and artwork

### Album covers

When WiiM reports an art URL, melune fetches it server-side and caches it under
`data/art/`. The browser loads covers from the local API, so it never talks to
the CDN and repeated views do not re-download artwork. Cached images refresh
after seven days; if the source is unreachable, the last cached copy is still
served. Tracks without artwork get a small placeholder.

### Artist photos

Top-artist tiles use Deezer's public artist API and are cached the same way. No
API key is needed, artist names are resolved about once per week, and missing
photos fall back to a placeholder.

### Mood tags and colors

Mood metadata is best-effort. Every newly seen or previously unmapped track is
queued for MusicBrainz in the background. melune checks up to three search
candidates per release group, recording, and artist, trying release-group
tags/genres first, then recording tags, then artist tags. Duplicate tags are
merged case-insensitively and capped at 12 per track. Requests are spaced at
least 1.1 seconds apart with a proper User-Agent, and transient rate limits or
5xx responses are retried with backoff to respect MusicBrainz's
one-request-per-second limit.

Tags are scored with the keyword rules in `src/mood.js`. Local inference is the
offline fallback: it only trusts genre-like words and known phrases in
artist/title/album text, so ordinary words such as `fast` or `sad` do not turn
**Fast Car** into Energetic. If MusicBrainz produces no usable mood, the local
guess is kept. Tracks with no evidence at all get a deterministic color from
their track ID. Most played tracks bars remain neutral.

Stored tags are labeled with their source (`musicbrainz` or `local`), and that
source is available from `GET /api/tracks/:id`. The keyword rules map tags to
Happy, Energetic, Calm, Sad, Focused, Romantic, Nostalgic, Intense, and Dreamy.

MusicBrainz receives artist, title, and album names. Your playback history is
never uploaded. Deezer receives artist names for photo lookup.

## API

All endpoints are unauthenticated and intended for localhost use. If you bind to
`0.0.0.0`, protect access with your network setup or a reverse proxy.

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Process id, start time, uptime, device count, poller state, and enrichment counters. |
| `GET /api/devices` | Configured devices, online state, last error, and current track. |
| `GET /api/discover?subnet=192.168.2.0/24` | Scan for WiiM devices. `subnet` is optional and must be a `/24`. |
| `POST /api/devices` | Add `{ "name": "Living Room", "host": "192.168.1.50" }` to config and start polling it. |
| `DELETE /api/devices` | Remove `{ "host": "192.168.1.50" }` or `?host=192.168.1.50` from config. Past plays are kept. |
| `GET /api/meta` | App name/version and the mood legend. |
| `GET /api/stats?range=week&device=<id>` | Totals, top tracks/artists, moods, sources, and daily timeline. `range` is `today`, `week`, `month`, or `all` (raw API default: `week`). |
| `GET /api/plays?range=week&device=<id>&limit=50` | Recent play events. `limit` is clamped to 1–200. |
| `GET /api/art/:trackId` | Cached album cover image. |
| `GET /api/artist-art/:artist` | Cached Deezer artist image. |
| `GET /api/tracks/:id` | Track details, stored tags, and mood scores. |
| `DELETE /api/data` | Wipe history and cached art. Requires body `{ "confirm": "DELETE ALL DATA" }`; devices are kept and the server restarts. |

## Storage and data management

SQLite lives at `data/melune.db` in WAL mode, with cached images in `data/art/`.
The schema is created automatically. To back up melune, stop the server and copy
the whole `data/` directory.

To erase listening history and cached art, click **Delete data** in the footer
and confirm. melune stops polling, closes the database, deletes `melune.db`,
`melune.db-wal`, `melune.db-shm`, and `data/art/`, then restarts into a fresh
database. `config.json` is untouched, so your devices keep polling. The same
action is available through `DELETE /api/data`.

To forget devices as well, remove them in the **Devices** dialog, via
`DELETE /api/devices`, or from `config.json`. Their historical plays remain
unless you also delete the data.

## Scripts

```bash
npm start        # run the server
npm run dev      # run with --watch
npm run discover # find WiiM devices via SSDP + subnet scan
npm test         # run the built-in node:test suite
```

## Troubleshooting

- **No devices found:** pass the correct `/24` subnet to `npm run discover`, or
  enter the IP manually from the WiiM Home app or router.
- **Device stays offline:** confirm the IP, that the device is powered on, and
  that this machine can reach it. Connection-level failures fall back to
  `curl`; install `curl` if direct sockets are blocked.
- **Mood mix is sparse:** MusicBrainz enrichment runs in the background and is
  rate-limited to one request per second, so a large history takes a while.
  Tracks with no usable tags still get stable colors. Mood data is never
  required for recording.
- **Dashboard is empty:** check the selected range and device filter, and
  remember that plays shorter than `minPlayMs` are discarded by default.
- **API is reachable from other machines:** that is expected when `host` is
  `0.0.0.0`. The API has no authentication, so restrict access accordingly.

## Known limitations

- Playback is sampled by polling, so listening time is an estimate based on the
  WiiM-reported position, not sample-accurate playback.
- The UI refreshes on a 15-second interval rather than push updates.
- Sources without useful metadata, such as AUX, Bluetooth, or some radio
  streams, produce limited titles and may not map to moods; they still get
  stable decorative colors.
- The built-in API is designed for localhost use and has no user accounts or
  permissions.
