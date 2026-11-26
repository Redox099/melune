import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localMood, localMoodTags } from './mood.js';
import { playFilter, playVersion, selectedPlayIds } from './play-query.js';
import { fingerprint, normalizeText } from './util.js';

export const MERGE_GAP_MS = 10 * 60 * 1000;
const recentCache = new WeakMap();

// played_ms changes every poll, but it is the only volatile field. Refresh it
// in place so the cached rows still avoid a full dedupe on each request.
function refreshPlayDurations(db, rows) {
  if (!rows.length) return;
  const ids = JSON.stringify(rows.map((row) => row.id));
  const current = new Map(db.prepare(`
    SELECT id, played_ms FROM plays WHERE id IN (SELECT value FROM json_each(?))
  `).all(ids).map((row) => [row.id, row.played_ms]));
  for (const row of rows) row.played_ms = current.get(row.id) ?? row.played_ms;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  model TEXT,
  firmware TEXT,
  uuid TEXT,
  last_poll_at INTEGER,
  last_error TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  art_uri TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id),
  track_id TEXT NOT NULL REFERENCES tracks(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  played_ms INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  position_start_ms INTEGER,
  position_end_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plays_started_at_idx ON plays(started_at);
CREATE INDEX IF NOT EXISTS plays_track_idx ON plays(track_id, started_at);
CREATE INDEX IF NOT EXISTS plays_device_idx ON plays(device_id, started_at);
CREATE INDEX IF NOT EXISTS plays_open_idx ON plays(device_id, ended_at);

CREATE TABLE IF NOT EXISTS track_tags (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  source TEXT NOT NULL,
  tag TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, source, tag)
);

CREATE TABLE IF NOT EXISTS track_mood (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id),
  mood TEXT,
  scores TEXT,
  source TEXT NOT NULL DEFAULT 'musicbrainz',
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_images (
  artist_key TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  image_url TEXT,
  fetched_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('play_version', '0');

CREATE TRIGGER IF NOT EXISTS plays_version_insert AFTER INSERT ON plays BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
-- played_ms ticks are refreshed from the cache, so only identity, timing and
-- grouping columns invalidate aggregates.
CREATE TRIGGER IF NOT EXISTS plays_version_update AFTER UPDATE OF
  device_id, track_id, started_at, ended_at, source, position_start_ms, position_end_ms
  ON plays
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
CREATE TRIGGER IF NOT EXISTS plays_version_delete AFTER DELETE ON plays BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
CREATE TRIGGER IF NOT EXISTS track_mood_version_insert AFTER INSERT ON track_mood BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
CREATE TRIGGER IF NOT EXISTS track_mood_version_update AFTER UPDATE ON track_mood BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
CREATE TRIGGER IF NOT EXISTS track_mood_version_delete AFTER DELETE ON track_mood BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
CREATE TRIGGER IF NOT EXISTS tracks_version_update AFTER UPDATE ON tracks BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'play_version';
END;
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'melune.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Databases created before version triggers existed need a starting value
  // that reflects their existing rows.
  db.exec(`
    UPDATE meta
       SET value = CAST(MAX(
         CAST(value AS INTEGER),
         (SELECT COUNT(*) FROM plays),
         (SELECT COUNT(*) FROM track_mood)
       ) AS TEXT)
     WHERE key = 'play_version'
  `);
  if (!db.prepare('PRAGMA table_info(track_mood)').all().some((column) => column.name === 'source')) {
    db.exec("ALTER TABLE track_mood ADD COLUMN source TEXT NOT NULL DEFAULT 'musicbrainz'");
    db.exec("UPDATE track_mood SET source = 'local' WHERE mood IS NULL");
  }
  const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0);
  if (version < 3) {
    // Local inference rules changed; discard old guesses so startup can redo them.
    db.exec("UPDATE track_mood SET mood = NULL, scores = NULL WHERE source = 'local'");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')").run();
  }
  if (version < 4) {
    // Last.fm is no longer a tag source; queue those tracks for MusicBrainz.
    db.exec("DELETE FROM track_tags WHERE source = 'lastfm'");
    db.exec("UPDATE track_mood SET mood = NULL, scores = NULL, source = 'local' WHERE source = 'lastfm'");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')").run();
  }
  return db;
}

export function upsertDevice(db, device, info = {}, at = Date.now()) {
  const row = {
    id: device.id,
    name: info.name || device.name || device.host,
    host: device.host,
    model: info.model || null,
    firmware: info.firmware || null,
    uuid: info.uuid || null,
  };
  db.prepare(`
    INSERT INTO devices (id, name, host, model, firmware, uuid, first_seen_at, last_seen_at)
    VALUES (@id, @name, @host, @model, @firmware, @uuid, @at, @at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      host = excluded.host,
      model = COALESCE(excluded.model, devices.model),
      firmware = COALESCE(excluded.firmware, devices.firmware),
      uuid = COALESCE(excluded.uuid, devices.uuid),
      last_seen_at = excluded.last_seen_at
  `).run({ ...row, at });
  return row;
}

export function markDevicePolled(db, deviceId, at, error = null) {
  db.prepare(`
    UPDATE devices
       SET last_poll_at = ?, last_error = ?, last_seen_at = CASE WHEN ? IS NULL THEN ? ELSE last_seen_at END
     WHERE id = ?
  `).run(at, error, error, at, deviceId);
}

export function getDevices(db) {
  return db.prepare('SELECT * FROM devices ORDER BY name').all();
}

export function getOrCreateTrack(db, track = {}) {
  const id = track.id || fingerprint(track);
  const at = Date.now();
  db.prepare(`
    INSERT INTO tracks (id, title, artist, album, art_uri, created_at, updated_at)
    VALUES (@id, @title, @artist, @album, @artUri, @at, @at)
    ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(excluded.title, tracks.title),
      artist = COALESCE(excluded.artist, tracks.artist),
      album = COALESCE(excluded.album, tracks.album),
      art_uri = COALESCE(excluded.art_uri, tracks.art_uri),
      updated_at = excluded.updated_at
  `).run({
    id,
    title: track.title || 'Unknown track',
    artist: track.artist ?? null,
    album: track.album ?? null,
    artUri: track.artUri ?? null,
    at,
  });
  ensureLocalMood(db, id, track, at);
  return id;
}

function ensureLocalMood(db, id, track, at = Date.now()) {
  const existing = db.prepare('SELECT source, mood FROM track_mood WHERE track_id = ?').get(id);
  if (existing && (existing.mood || existing.source !== 'local')) return false;
  const tags = localMoodTags(track);
  const { mood, scores } = localMood(track);
  if (tags.length) upsertTrackTags(db, id, tags, 'local', at);
  setTrackMood(db, id, mood, scores, { source: 'local', fetchedAt: at });
  return true;
}

export function backfillLocalMoods(db, limit = 500) {
  let filled = 0;
  for (const track of getTracksForLocalMood(db, limit)) {
    if (ensureLocalMood(db, track.id, track)) filled += 1;
  }
  return filled;
}

export function getOpenPlay(db, deviceId) {
  return db.prepare('SELECT * FROM plays WHERE device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(deviceId) ?? null;
}

export function endPlay(db, playId, endedAt, positionEndMs = null) {
  const result = db.prepare(`
    UPDATE plays
       SET ended_at = ?, position_end_ms = COALESCE(?, position_end_ms)
     WHERE id = ? AND ended_at IS NULL
  `).run(endedAt, positionEndMs, playId);
  return result.changes > 0;
}

/** Close a play and discard it when the listener skipped it too quickly. */
export function finishPlay(db, playId, endedAt, positionEndMs = null, minPlayMs = 0) {
  const row = db.prepare('SELECT played_ms FROM plays WHERE id = ? AND ended_at IS NULL').get(playId);
  if (!row || !endPlay(db, playId, endedAt, positionEndMs)) {
    return { ended: false, discarded: false };
  }
  if (minPlayMs > 0 && (row.played_ms ?? 0) < minPlayMs) {
    db.prepare('DELETE FROM plays WHERE id = ?').run(playId);
    return { ended: true, discarded: true };
  }
  return { ended: true, discarded: false };
}

/** Remove short plays already stored, e.g. after changing the threshold. */
export function removeShortPlays(db, minPlayMs = 0) {
  if (minPlayMs <= 0) return 0;
  return db.prepare(`
    DELETE FROM plays WHERE ended_at IS NOT NULL AND played_ms < ?
  `).run(minPlayMs).changes;
}

export function reopenPlay(db, playId) {
  const result = db.prepare(`
    UPDATE plays SET ended_at = NULL WHERE id = ? AND ended_at IS NOT NULL
  `).run(playId);
  return result.changes > 0;
}

export function startPlay(db, { deviceId, trackId, startedAt, source, positionStartMs }) {
  const existing = getOpenPlay(db, deviceId);
  if (existing) endPlay(db, existing.id, startedAt, positionStartMs);
  const result = db.prepare(`
    INSERT INTO plays (device_id, track_id, started_at, source, position_start_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, trackId, startedAt, source ?? null, positionStartMs ?? null, startedAt);
  return Number(result.lastInsertRowid);
}

export function updatePlayTick(db, playId, deltaMs, positionEndMs = null) {
  if (deltaMs <= 0) return;
  db.prepare(`
    UPDATE plays
       SET played_ms = played_ms + ?, position_end_ms = COALESCE(?, position_end_ms)
     WHERE id = ?
  `).run(Math.round(deltaMs), positionEndMs, playId);
}

export function getTrack(db, trackId) {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) ?? null;
}

export function getTrackMood(db, trackId) {
  if (!trackId) return null;
  return db.prepare('SELECT mood FROM track_mood WHERE track_id = ?').get(trackId)?.mood ?? null;
}

export function getTracksForEnrichment(db, limit = 100, before = 0) {
  return db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.art_uri
      FROM tracks t
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE (m.track_id IS NULL OR m.mood IS NULL OR m.source = 'local')
       AND COALESCE(m.fetched_at, 0) <= ?
       AND COALESCE(t.title, '') <> ''
       AND COALESCE(t.artist, '') <> ''
     ORDER BY t.updated_at DESC
     LIMIT ?
  `).all(before, limit);
}

function getTracksForLocalMood(db, limit = 500) {
  return db.prepare(`
    SELECT t.id, t.title, t.artist, t.album
      FROM tracks t
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE (m.track_id IS NULL OR (m.mood IS NULL AND m.source = 'local'))
       AND COALESCE(t.title, '') <> ''
       AND COALESCE(t.artist, '') <> ''
     ORDER BY t.updated_at DESC
     LIMIT ?
  `).all(limit);
}

export function upsertTrackTags(db, trackId, tags, source, fetchedAt = Date.now()) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM track_tags WHERE track_id = ? AND source = ?').run(trackId, source);
    const insert = db.prepare(`
      INSERT INTO track_tags (track_id, source, tag, weight, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(track_id, source, tag) DO UPDATE SET weight = excluded.weight, fetched_at = excluded.fetched_at
    `);
    for (const tag of tags) {
      insert.run(trackId, source, tag.name, Math.max(1, Math.round(tag.weight ?? 1)), fetchedAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function setTrackMood(db, trackId, mood, scores, { fetchedAt = Date.now(), source = 'musicbrainz' } = {}) {
  const existing = db.prepare('SELECT source, mood FROM track_mood WHERE track_id = ?').get(trackId);
  // A local guess must never replace a mood inferred from real MusicBrainz tags.
  if (source === 'local' && existing?.source === 'musicbrainz' && existing.mood) return false;
  db.prepare(`
    INSERT INTO track_mood (track_id, mood, scores, source, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET
      mood = excluded.mood,
      scores = excluded.scores,
      source = excluded.source,
      fetched_at = excluded.fetched_at
  `).run(trackId, mood, JSON.stringify(scores ?? {}), source, fetchedAt);
  return true;
}

function artistKey(artist) {
  return normalizeText(artist) || 'unknown';
}

export function getArtistImage(db, artist) {
  return db.prepare('SELECT * FROM artist_images WHERE artist_key = ?').get(artistKey(artist)) ?? null;
}

export function setArtistImage(db, artist, imageUrl, fetchedAt = Date.now()) {
  db.prepare(`
    INSERT INTO artist_images (artist_key, artist, image_url, fetched_at)
    VALUES (@key, @artist, @imageUrl, @fetchedAt)
    ON CONFLICT(artist_key) DO UPDATE SET
      artist = excluded.artist,
      image_url = excluded.image_url,
      fetched_at = excluded.fetched_at
  `).run({
    key: artistKey(artist),
    artist: String(artist ?? 'Unknown'),
    imageUrl: imageUrl ?? null,
    fetchedAt,
  });
}

export function getRecentPlays(db, { from = 0, to = Date.now(), deviceId = null, limit = 50 } = {}) {
  const key = [
    Math.floor(to / 60_000),
    Math.floor(from / 60_000),
    deviceId ?? '',
    limit,
    playVersion(db),
  ].join('|');
  let cache = recentCache.get(db);
  if (!cache) {
    cache = new Map();
    recentCache.set(db, cache);
  }
  const cached = cache.get(key);
  if (cached) {
    refreshPlayDurations(db, cached);
    return cached;
  }

  const { sql, params } = playFilter({ from, to, deviceId });
  const ids = selectedPlayIds(db, { from, to, deviceId });
  let where = sql;
  if (ids) {
    where += ' AND p.id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify(ids));
  }
  params.push(limit);
  const rows = db.prepare(`
    SELECT p.id, p.started_at, p.ended_at, p.played_ms, p.source,
           t.id AS track_id, t.title, t.artist, t.album,
           CASE WHEN t.art_uri IS NULL OR t.art_uri = '' THEN 0 ELSE 1 END AS hasArt,
           d.name AS device_name,
           m.mood
      FROM plays p
      JOIN tracks t ON t.id = p.track_id
      JOIN devices d ON d.id = p.device_id
      LEFT JOIN track_mood m ON m.track_id = t.id
     WHERE ${where}
     ORDER BY p.started_at DESC
     LIMIT ?
  `).all(...params);
  cache.set(key, rows);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return rows;
}

/**
 * Merge adjacent segments of the same play that were split by a brief stop or
 * a transient device status when the playback position kept moving forward.
 * A position rewind (a genuine repeat) is never merged.
 */
export function mergeDuplicatePlays(db, { maxGapMs = MERGE_GAP_MS, rewindMs = 10_000 } = {}) {
  const rows = db.prepare(`
    SELECT id, device_id, track_id, source, started_at, ended_at,
           played_ms, position_start_ms, position_end_ms
      FROM plays
     ORDER BY device_id, track_id, source, started_at, id
  `).all();
  const previous = new Map();
  let merged = 0;

  db.exec('BEGIN');
  try {
    const update = db.prepare(`
      UPDATE plays
         SET ended_at = ?, played_ms = played_ms + ?, position_end_ms = COALESCE(?, position_end_ms)
       WHERE id = ?
    `);
    const remove = db.prepare('DELETE FROM plays WHERE id = ?');

    for (const row of rows) {
      const key = `${row.device_id}|${row.track_id}|${row.source ?? ''}`;
      const prev = previous.get(key);
      const gap = prev && prev.ended_at !== null ? row.started_at - prev.ended_at : null;
      const forward =
        !row.position_start_ms ||
        !prev?.position_end_ms ||
        row.position_start_ms >= prev.position_end_ms - rewindMs;
      const canMerge = prev && gap !== null && gap >= 0 && gap <= maxGapMs && forward;

      if (canMerge) {
        update.run(row.ended_at, row.played_ms ?? 0, row.position_end_ms, prev.id);
        remove.run(row.id);
        prev.ended_at = row.ended_at;
        prev.played_ms = (prev.played_ms ?? 0) + (row.played_ms ?? 0);
        prev.position_end_ms = row.position_end_ms ?? prev.position_end_ms;
        merged += 1;
      } else {
        previous.set(key, row);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return merged;
}
