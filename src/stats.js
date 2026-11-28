import { MOODS, moodColor } from './mood.js';
import { playSource, playVersion, selectedPlayIds } from './play-query.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_SQL = "strftime('%Y-%m-%d', p.started_at / 1000, 'unixepoch', 'localtime')";

export function rangeBounds(range = 'week', now = Date.now()) {
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: now };
  }
  if (range === 'month') return { from: now - 30 * DAY_MS, to: now };
  if (range === 'all') return { from: 0, to: now };
  return { from: now - 7 * DAY_MS, to: now };
}

const summaryCache = new WeakMap();

function sumPlayedMs(db, ids) {
  if (!ids.length) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(played_ms), 0) AS playedMs
      FROM plays
     WHERE id IN (SELECT value FROM json_each(?))
  `).get(JSON.stringify(ids));
  return row.playedMs ?? 0;
}

// Structural writes (new/ended plays, mood changes) invalidate the cache.
// Plain played_ms ticks are refreshed from the cached play ids, so a poll every
// few seconds does not rerun the full dedupe and aggregation.
export function getSummary(db, options = {}) {
  const key = [
    Math.floor((options.to ?? Date.now()) / 60_000),
    Math.floor((options.from ?? 0) / 60_000),
    options.deviceId ?? '',
    options.trackId ?? '',
    playVersion(db),
  ].join('|');
  let cache = summaryCache.get(db);
  if (!cache) {
    cache = new Map();
    summaryCache.set(db, cache);
  }
  let entry = cache.get(key);
  if (!entry) {
    entry = computeSummary(db, options);
    cache.set(key, entry);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  entry.summary.totals.playedMs = sumPlayedMs(db, entry.ids);
  return entry.summary;
}

// Play filtering and multiroom dedupe are shared with the recent-plays query.
function computeSummary(db, options = {}) {
  const ids = selectedPlayIds(db, options);
  const { from, where, params } = playSource(options, ids);
  // Device views intentionally skip dedupe; keep their exact id list so the
  // cached played-time refresh still sums the same rows.
  const playedIds = ids ?? db.prepare(`
    SELECT p.id FROM ${from} WHERE ${where}
  `).all(...params).map((row) => row.id);
  const totals = db.prepare(`
    SELECT COUNT(*) AS plays,
           COUNT(DISTINCT p.track_id) AS uniqueTracks,
           COALESCE(SUM(p.played_ms), 0) AS playedMs,
           COUNT(DISTINCT ${DAY_SQL}) AS activeDays
      FROM ${from}
     WHERE ${where}
  `).get(...params);

  const topTracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, m.mood,
           CASE WHEN t.art_uri IS NULL OR t.art_uri = '' THEN 0 ELSE 1 END AS hasArt,
           COUNT(*) AS plays, COALESCE(SUM(p.played_ms), 0) AS playedMs
      FROM ${from}
      JOIN tracks t ON t.id = p.track_id
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE ${where}
     GROUP BY t.id
     ORDER BY plays DESC, playedMs DESC
     LIMIT 20
  `).all(...params);

  const topArtists = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown') AS artist,
           COUNT(*) AS plays,
           COUNT(DISTINCT t.id) AS tracks
      FROM ${from}
      JOIN tracks t ON t.id = p.track_id
     WHERE ${where}
     GROUP BY artist
     ORDER BY plays DESC, tracks DESC
     LIMIT 8
  `).all(...params);

  const moods = db.prepare(`
    SELECT COALESCE(m.mood, 'unknown') AS mood,
           COUNT(*) AS plays,
           COALESCE(SUM(p.played_ms), 0) AS playedMs
      FROM ${from}
      JOIN tracks t ON t.id = p.track_id
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE ${where}
     GROUP BY mood
     ORDER BY plays DESC
  `).all(...params);

  const timelineParams = [...params, ...params, ...params];
  const timeline = db.prepare(`
    WITH day_counts AS (
      SELECT ${DAY_SQL} AS day,
             COUNT(*) AS plays,
             COALESCE(SUM(p.played_ms), 0) AS playedMs
        FROM ${from}
       WHERE ${where}
       GROUP BY day
    ), day_moods AS (
      SELECT ${DAY_SQL} AS day,
             COALESCE(m.mood, 'unknown') AS mood,
             COUNT(*) AS moodPlays
        FROM ${from}
        JOIN tracks t ON t.id = p.track_id
        LEFT JOIN track_mood m ON m.track_id = t.id
       WHERE ${where}
       GROUP BY day, mood
    ), day_tracks AS (
      SELECT ${DAY_SQL} AS day,
             t.id AS trackId,
             COUNT(*) AS trackPlays
        FROM ${from}
        JOIN tracks t ON t.id = p.track_id
       WHERE ${where}
       GROUP BY day, t.id
    ), ranked AS (
      SELECT day, mood,
             ROW_NUMBER() OVER (
               PARTITION BY day
               ORDER BY CASE WHEN mood = 'unknown' THEN 1 ELSE 0 END,
                        moodPlays DESC,
                        mood
             ) AS rn
        FROM day_moods
    ), ranked_tracks AS (
      SELECT day, trackId,
             ROW_NUMBER() OVER (
               PARTITION BY day
               ORDER BY trackPlays DESC, trackId
             ) AS rn
        FROM day_tracks
    )
    SELECT d.day, d.plays, d.playedMs, r.mood, rt.trackId,
           (SELECT json_group_array(json_object('mood', mood, 'plays', moodPlays))
              FROM day_moods dm
             WHERE dm.day = d.day) AS moodMix
      FROM day_counts d
      LEFT JOIN ranked r ON r.day = d.day AND r.rn = 1
      LEFT JOIN ranked_tracks rt ON rt.day = d.day AND rt.rn = 1
     ORDER BY d.day
  `).all(...timelineParams).map((row) => ({
    ...row,
    color: moodColor(row.mood),
    moodMix: JSON.parse(row.moodMix ?? '[]')
      .map((entry) => ({ ...entry, color: moodColor(entry.mood) }))
      .sort((a, b) => Number(a.mood === 'unknown') - Number(b.mood === 'unknown')
        || b.plays - a.plays
        || String(a.mood).localeCompare(String(b.mood))),
  }));

  return {
    ids: playedIds,
    summary: {
      totals: {
        plays: totals.plays ?? 0,
        uniqueTracks: totals.uniqueTracks ?? 0,
        playedMs: totals.playedMs ?? 0,
        activeDays: totals.activeDays ?? 0,
      },
      topTracks,
      topArtists,
      moods,
      timeline,
    },
  };
}

export function getMeta() {
  return { name: 'melune', version: '0.1.0', moods: MOODS };
}
