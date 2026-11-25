import { getOrCreateTrack, getTracksForEnrichment, setTrackMood, upsertTrackTags } from './db.js';
import { localMood, scoreMood } from './mood.js';
import { fingerprint, sleep } from './util.js';

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MB_API_ROOT = 'https://musicbrainz.org/ws/2/';
const MB_USER_AGENT = 'melune/0.1.0 ( https://github.com/redox/melune )';
// MusicBrainz allows one request per second per source IP. Leave a little room.
const MB_REQUEST_GAP_MS = 1100;
const MB_SEARCH_LIMIT = 3;
const MB_MAX_RETRIES = 3;
const MB_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function tagList(value, source = 'musicbrainz') {
  const tags = Array.isArray(value) ? value : value ? [value] : [];
  const byName = new Map();
  for (const tag of tags) {
    const name = String(tag?.name ?? '').trim();
    if (!name) continue;
    const rawWeight = tag.weight ?? tag.count;
    const weight = Math.max(1, Number(rawWeight) || 1);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.weight = Math.max(existing.weight, weight);
    else byName.set(key, { name, weight, source });
  }
  return [...byName.values()].slice(0, 12);
}

function combinedTags(payload) {
  return tagList([...(payload?.tags ?? []), ...(payload?.genres ?? [])]);
}

function phrase(value) {
  return `"${String(value).replace(/[\\"]/g, '\\$&')}"`;
}

function searchQuery(fields) {
  return fields.filter(Boolean).join(' AND ');
}

function primaryArtist(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.split(/\s*(?:,|;|&|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i)[0].trim() || text;
}

function artistQueries(artist) {
  const primary = primaryArtist(artist);
  const full = String(artist ?? '').trim();
  return [...new Set([primary, full].filter(Boolean))];
}

function retryDelayMs(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(seconds * 1000, MB_REQUEST_GAP_MS);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(at - Date.now(), MB_REQUEST_GAP_MS);
  }
  return MB_REQUEST_GAP_MS * (attempt + 1);
}

function hasMood(tags) {
  return Boolean(scoreMood(tags).mood);
}

/**
 * Metadata enrichment from MusicBrainz tags and genres. Everything is
 * best-effort: playback recording never depends on it.
 */
export class Enricher {
  constructor(db, config = {}) {
    this.db = db;
    this.config = config;
    this.queue = [];
    this.processing = false;
    this.seen = new Map();
    this.lastMbRequestAt = 0;
    this.fetch = fetch;
    this.sleep = sleep;
    this.stats = { enriched: 0, failed: 0, skipped: 0 };
  }

  get configured() {
    return { musicbrainz: true };
  }

  enqueue(track) {
    if (!track?.artist && !track?.title && !track?.album) {
      this.stats.skipped += 1;
      return;
    }
    const id = fingerprint(track);
    const lastSeen = this.seen.get(id);
    if (lastSeen && Date.now() - lastSeen < RETRY_AFTER_MS) return;
    this.seen.set(id, Date.now());
    this.queue.push({ ...track, id });
    void this.drain();
  }

  /** Queue already-seen tracks so history is enriched on startup. */
  backfill(limit = 100) {
    const tracks = getTracksForEnrichment(this.db, limit);
    for (const track of tracks) this.enqueue(track);
    return tracks.length;
  }

  async drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const track = this.queue.shift();
      try {
        await this.process(track);
        this.stats.enriched += 1;
      } catch (error) {
        this.stats.failed += 1;
        console.warn(`[enrich] ${track.title || 'unknown'}: ${error.message}`);
      }
      await this.sleep(300);
    }
    this.processing = false;
  }

  async process(track) {
    const trackId = getOrCreateTrack(this.db, track);
    let tags = [];
    try {
      tags = await this.mbTags(track);
    } catch (error) {
      console.warn(`[enrich] MusicBrainz: ${error.message}`);
    }
    upsertTrackTags(this.db, trackId, tags, 'musicbrainz');
    const inferred = scoreMood(tags);
    const fallback = localMood(track);
    const mood = inferred.mood ?? fallback.mood;
    const scores = inferred.mood ? inferred.scores : fallback.scores;
    setTrackMood(this.db, trackId, mood, scores, {
      source: inferred.mood ? 'musicbrainz' : 'local',
    });
    return { mood, scores, tags };
  }

  async mbRequest(path, params = {}, attempt = 0) {
    const wait = MB_REQUEST_GAP_MS - (Date.now() - this.lastMbRequestAt);
    if (wait > 0) await this.sleep(wait);
    const url = new URL(path, MB_API_ROOT);
    url.search = new URLSearchParams({ fmt: 'json', ...params }).toString();
    let response;
    try {
      response = await this.fetch(url, {
        headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      this.lastMbRequestAt = Date.now();
    } catch (error) {
      this.lastMbRequestAt = Date.now();
      if (attempt < MB_MAX_RETRIES) {
        await this.sleep(MB_REQUEST_GAP_MS * (attempt + 1));
        return this.mbRequest(path, params, attempt + 1);
      }
      throw error;
    }

    if (MB_TRANSIENT_STATUSES.has(response?.status) && attempt < MB_MAX_RETRIES) {
      await this.sleep(retryDelayMs(response, attempt));
      return this.mbRequest(path, params, attempt + 1);
    }
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  async mbSearch(entity, query) {
    const data = await this.mbRequest(entity, { query, limit: String(MB_SEARCH_LIMIT) });
    const key = entity === 'release-group' ? 'release-groups' : `${entity}s`;
    return (data[key] ?? [])
      .slice(0, MB_SEARCH_LIMIT)
      .map((item) => item?.id)
      .filter(Boolean);
  }

  async findTags(entity, query) {
    const ids = await this.mbSearch(entity, query);
    let best = [];
    let bestCoverage = -1;
    for (const id of ids) {
      const data = await this.mbRequest(`${entity}/${id}`, { inc: 'tags+genres' });
      const tags = combinedTags(data);
      if (!tags.length) continue;
      const inferred = scoreMood(tags);
      if (inferred.mood) return tags;
      const coverage = Object.keys(inferred.scores).length;
      if (coverage > bestCoverage) {
        best = tags;
        bestCoverage = coverage;
      }
    }
    return best;
  }

  async mbTags(track) {
    const album = track.album ? `releasegroup:${phrase(track.album)}` : null;
    const title = track.title ? `recording:${phrase(track.title)}` : null;
    let tags = [];

    for (const artistName of artistQueries(track.artist)) {
      const artist = `artist:${phrase(artistName)}`;
      if (album) tags = tagList([...tags, ...(await this.findTags('release-group', searchQuery([album, artist])))]);
      if (hasMood(tags)) break;
      if (title) tags = tagList([...tags, ...(await this.findTags('recording', searchQuery([title, artist])))]);
      if (hasMood(tags)) break;
      tags = tagList([...tags, ...(await this.findTags('artist', artist))]);
      if (hasMood(tags)) break;
    }

    return tags;
  }

  status() {
    return {
      configured: this.configured,
      queued: this.queue.length,
      processing: this.processing,
      cachedTracks: this.seen.size,
      ...this.stats,
    };
  }
}
