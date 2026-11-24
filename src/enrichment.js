import { getOrCreateTrack, getTracksForEnrichment, setTrackMood, upsertTrackTags } from './db.js';
import { scoreMood } from './mood.js';
import { fingerprint, sleep } from './util.js';

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

async function externalJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function tagList(value, source = 'lastfm') {
  const tags = Array.isArray(value) ? value : value ? [value] : [];
  const byName = new Map();
  for (const tag of tags) {
    const name = String(tag?.name ?? '').trim();
    if (!name) continue;
    const weight = Math.max(1, Number(tag?.count) || 1);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.weight = Math.max(existing.weight, weight);
    else byName.set(key, { name, weight, source });
  }
  return [...byName.values()].slice(0, 12);
}

/**
 * Optional metadata enrichment from Last.fm tags. Everything is best-effort:
 * playback recording never depends on it.
 */
export class Enricher {
  constructor(db, config = {}) {
    this.db = db;
    this.config = config;
    this.queue = [];
    this.processing = false;
    this.seen = new Map();
    this.stats = { enriched: 0, failed: 0, skipped: 0 };
  }

  get configured() {
    return { lastfm: Boolean(this.config.lastfm?.apiKey) };
  }

  enqueue(track) {
    if (!this.configured.lastfm) {
      this.stats.skipped += 1;
      return;
    }
    if (!track?.title && !track?.artist) {
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

  /** Queue already-seen tracks so a newly added key also enriches history. */
  backfill(limit = 100) {
    if (!this.configured.lastfm) return 0;
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
      await sleep(300);
    }
    this.processing = false;
  }

  async process(track) {
    const trackId = getOrCreateTrack(this.db, track);
    let tags = [];
    try {
      tags = await this.lastfmTags(track);
    } catch (error) {
      console.warn(`[enrich] Last.fm: ${error.message}`);
    }
    upsertTrackTags(this.db, trackId, tags, 'lastfm');
    const { mood, scores } = scoreMood(tags);
    setTrackMood(this.db, trackId, mood, scores);
    return { mood, scores, tags };
  }

  async lastfmRequest(method, extra = {}) {
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    url.search = new URLSearchParams({
      method,
      api_key: this.config.lastfm.apiKey,
      format: 'json',
      ...extra,
    }).toString();
    return externalJson(url);
  }

  async lastfmTags(track) {
    if (!track.artist || !track.title) return [];
    let response = await this.lastfmRequest('track.getInfo', { artist: track.artist, track: track.title });
    let tags = tagList(response?.track?.toptags?.tag);
    let artist = track.artist;

    if (!tags.length) {
      const search = await this.lastfmRequest('track.search', {
        artist: track.artist,
        track: track.title,
        limit: '3',
      });
      const match = search?.results?.trackmatches?.track?.[0];
      if (match?.artist && match?.name) {
        artist = match.artist;
        response = await this.lastfmRequest('track.getInfo', { artist: match.artist, track: match.name });
        tags = tagList(response?.track?.toptags?.tag);
      }
    }

    // Last.fm often returns empty track tags. Fall back to the artist's top
    // tags so mood inference still has useful Last.fm metadata.
    if (!tags.length) {
      response = await this.lastfmRequest('artist.getTopTags', { artist });
      tags = tagList(response?.toptags?.tag);
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
