const START_WINDOW_MS = 10_000;
const END_WINDOW_MS = 500;
const POSITION_WINDOW_MS = 10_000;

function num(value) {
  return Number(value) || 0;
}

function compatibleSource(a, b) {
  const first = a.source || null;
  const second = b.source || null;
  return !first || !second || first === second;
}

function overlaps(a, b, referenceNow, endWindowMs) {
  const aStart = num(a.started_at);
  const bStart = num(b.started_at);
  const aEnd = a.ended_at == null ? referenceNow : Math.max(aStart, num(a.ended_at));
  const bEnd = b.ended_at == null ? referenceNow : Math.max(bStart, num(b.ended_at));
  if (aStart > bEnd + endWindowMs || bStart > aEnd + endWindowMs) return false;
  if (a.position_start_ms == null || b.position_start_ms == null) return true;
  return Math.abs(num(a.position_start_ms) - num(b.position_start_ms))
    <= START_WINDOW_MS + POSITION_WINDOW_MS;
}

/**
 * WiiM multiroom streams one song to several devices. Polls can see the start
 * and finish a few seconds apart, and one device may still be playing while
 * another has already stopped. Group those rows by track, source, a bounded
 * start window, and overlapping playback; keep the longest representative.
 * Device-filtered views bypass this entirely and keep every device play.
 */
export function dedupePlayRows(rows, options = {}) {
  const startWindowMs = options.startWindowMs ?? START_WINDOW_MS;
  const endWindowMs = options.endWindowMs ?? END_WINDOW_MS;
  const referenceNow = Math.max(
    0,
    ...rows.map((row) => (row.ended_at == null ? num(row.started_at) : num(row.ended_at))),
  );
  const sorted = [...rows].sort((a, b) => num(a.started_at) - num(b.started_at) || num(a.id) - num(b.id));
  const groups = [];

  for (const row of sorted) {
    let match = null;
    let bestScore = Infinity;
    for (const group of groups) {
      const anchor = group.anchor;
      if (anchor.track_id !== row.track_id) continue;
      if (row.device_id != null && group.deviceIds.has(row.device_id)) continue;
      if (!compatibleSource(anchor, row)) continue;
      const startDiff = Math.abs(num(row.started_at) - num(anchor.started_at));
      if (startDiff > startWindowMs) continue;
      if (!overlaps(anchor, row, referenceNow, endWindowMs)) continue;
      const score = startDiff - (num(row.played_ms) - num(group.best.played_ms)) / 1000;
      if (score < bestScore) {
        bestScore = score;
        match = group;
      }
    }

    if (!match) {
      groups.push({
        anchor: row,
        best: row,
        deviceIds: new Set(row.device_id == null ? [] : [row.device_id]),
      });
      continue;
    }

    if (row.device_id != null) match.deviceIds.add(row.device_id);
    if (num(row.played_ms) > num(match.best.played_ms)
      || (num(row.played_ms) === num(match.best.played_ms) && num(row.id) < num(match.best.id))) {
      match.best = row;
    }
  }

  return groups.map((group) => num(group.best.id)).sort((a, b) => a - b);
}
