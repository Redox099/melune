import { getTrack } from './db.js';
import { MOODS, moodColor } from './mood.js';

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

function playFilter({ from, to, deviceId }, alias = 'p') {
  const clauses = [`${alias}.started_at >= ?`, `${alias}.started_at <= ?`];
  const params = [from ?? 0, to ?? Date.now()];
  if (deviceId) {
    clauses.push(`${alias}.device_id = ?`);
    params.push(deviceId);
  }
  return { sql: clauses.join(' AND '), params };
}

export function getSummary(db, options = {}) {
  const { sql, params } = playFilter(options);
  const totals = db.prepare(`
    SELECT COUNT(*) AS plays,
           COUNT(DISTINCT p.track_id) AS uniqueTracks,
           COALESCE(SUM(p.played_ms), 0) AS playedMs,
           COUNT(DISTINCT ${DAY_SQL}) AS activeDays
      FROM plays p
     WHERE ${sql}
  `).get(...params);

  const topTracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, m.mood,
           CASE WHEN t.art_uri IS NULL OR t.art_uri = '' THEN 0 ELSE 1 END AS hasArt,
           COUNT(*) AS plays, COALESCE(SUM(p.played_ms), 0) AS playedMs
      FROM plays p
      JOIN tracks t ON t.id = p.track_id
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE ${sql}
     GROUP BY t.id
     ORDER BY plays DESC, playedMs DESC
     LIMIT 20
  `).all(...params);

  const topArtists = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(t.artist), ''), 'Unknown') AS artist,
           COUNT(*) AS plays,
           COUNT(DISTINCT t.id) AS tracks
      FROM plays p
      JOIN tracks t ON t.id = p.track_id
     WHERE ${sql}
     GROUP BY artist
     ORDER BY plays DESC, tracks DESC
     LIMIT 8
  `).all(...params);

  const moods = db.prepare(`
    SELECT COALESCE(m.mood, 'unknown') AS mood,
           COUNT(*) AS plays,
           COALESCE(SUM(p.played_ms), 0) AS playedMs
      FROM plays p
      JOIN tracks t ON t.id = p.track_id
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE ${sql}
     GROUP BY mood
     ORDER BY plays DESC
  `).all(...params);

  const sources = db.prepare(`
    SELECT COALESCE(p.source, 'unknown') AS source, COUNT(*) AS plays
      FROM plays p
     WHERE ${sql}
     GROUP BY source
     ORDER BY plays DESC
  `).all(...params);

  const timeline = db.prepare(`
    WITH day_counts AS (
      SELECT ${DAY_SQL} AS day,
             COUNT(*) AS plays,
             COALESCE(SUM(p.played_ms), 0) AS playedMs
        FROM plays p
       WHERE ${sql}
       GROUP BY day
    ), day_moods AS (
      SELECT ${DAY_SQL} AS day,
             COALESCE(m.mood, 'unknown') AS mood,
             COUNT(*) AS moodPlays
        FROM plays p
        JOIN tracks t ON t.id = p.track_id
        LEFT JOIN track_mood m ON m.track_id = t.id
       WHERE ${sql}
       GROUP BY day, mood
    ), day_tracks AS (
      SELECT ${DAY_SQL} AS day,
             t.id AS trackId,
             COUNT(*) AS trackPlays
        FROM plays p
        JOIN tracks t ON t.id = p.track_id
       WHERE ${sql}
       GROUP BY day, t.id
    ), ranked AS (
      SELECT day, mood,
             ROW_NUMBER() OVER (
               PARTITION BY day
               ORDER BY moodPlays DESC,
                        CASE WHEN mood = 'unknown' THEN 1 ELSE 0 END,
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
    SELECT d.day, d.plays, d.playedMs, r.mood, rt.trackId
      FROM day_counts d
      LEFT JOIN ranked r ON r.day = d.day AND r.rn = 1
      LEFT JOIN ranked_tracks rt ON rt.day = d.day AND rt.rn = 1
     ORDER BY d.day
  `).all(...params, ...params, ...params).map((row) => ({
    ...row,
    color: moodColor(row.mood),
  }));

  return {
    totals: {
      plays: totals.plays ?? 0,
      uniqueTracks: totals.uniqueTracks ?? 0,
      playedMs: totals.playedMs ?? 0,
      activeDays: totals.activeDays ?? 0,
    },
    topTracks,
    topArtists,
    moods,
    sources,
    timeline,
  };
}

export function getTrackDetails(db, trackId) {
  const track = getTrack(db, trackId);
  if (!track) return null;
  const totals = db.prepare(`
    SELECT COUNT(*) AS plays, COALESCE(SUM(played_ms), 0) AS playedMs, MAX(started_at) AS lastPlayedAt
      FROM plays WHERE track_id = ?
  `).get(trackId);
  const tags = db.prepare(`
    SELECT source, tag, weight FROM track_tags WHERE track_id = ? ORDER BY weight DESC, tag
  `).all(trackId);
  const moodRow = db.prepare('SELECT mood, scores, source, fetched_at FROM track_mood WHERE track_id = ?').get(trackId);
  return {
    track,
    totals: { plays: totals.plays ?? 0, playedMs: totals.playedMs ?? 0, lastPlayedAt: totals.lastPlayedAt ?? null },
    tags,
    mood: moodRow?.mood ?? null,
    scores: moodRow?.scores ? JSON.parse(moodRow.scores) : {},
    source: moodRow?.source ?? null,
    fetchedAt: moodRow?.fetched_at ?? null,
  };
}

export function getMeta() {
  return { name: 'melune', version: '0.1.0', moods: MOODS };
}
