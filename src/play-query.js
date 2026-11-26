import { dedupePlayRows } from './play-dedupe.js';

export function playVersion(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'play_version'").get()?.value ?? '0';
}

export function playFilter({ from, to, deviceId, trackId } = {}, alias = 'p') {
  const clauses = [`${alias}.started_at >= ?`, `${alias}.started_at <= ?`];
  const params = [from ?? 0, to ?? Date.now()];
  if (deviceId) {
    clauses.push(`${alias}.device_id = ?`);
    params.push(deviceId);
  }
  if (trackId) {
    clauses.push(`${alias}.track_id = ?`);
    params.push(trackId);
  }
  return { sql: clauses.join(' AND '), params };
}

// Device-filtered views keep every play; only cross-device totals are deduped.
export function selectedPlayIds(db, options = {}) {
  if (options.deviceId) return null;
  const { sql, params } = playFilter(options);
  const rows = db.prepare(`
    SELECT p.id, p.track_id, p.device_id, p.started_at, p.ended_at,
           p.played_ms, p.source, p.position_start_ms, p.position_end_ms
      FROM plays p
     WHERE ${sql}
  `).all(...params);
  return dedupePlayRows(rows);
}

export function playSource(options, ids) {
  const { sql, params } = playFilter(options);
  if (ids === null) return { from: 'plays p', where: sql, params };
  return {
    from: 'plays p JOIN json_each(?) picked ON picked.value = p.id',
    where: sql,
    params: [JSON.stringify(ids), ...params],
  };
}
