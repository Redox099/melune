import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createArtService, detectImageType } from '../src/art.js';
import { hostsFor, isAllowedDiscoverySubnet, parseSubnet } from '../src/discover.js';
import {
  endPlay,
  getArtistImage,
  getOpenPlay,
  getOrCreateTrack,
  getRecentPlays,
  mergeDuplicatePlays,
  openDb,
  removeShortPlays,
  setTrackMood,
  startPlay,
  updatePlayTick,
  upsertDevice,
  upsertTrackTags,
} from '../src/db.js';
import { Enricher } from '../src/enrichment.js';
import { localMood, moodColor, scoreMood } from '../src/mood.js';
import { PlayTracker } from '../src/play-detector.js';
import { dedupePlayRows } from '../src/play-dedupe.js';
import { Poller } from '../src/poller.js';
import { RETIRED_PAGES, startServer } from '../src/server.js';
import { getSummary, rangeBounds } from '../src/stats.js';
import { cleanMeta, decodeMaybeHex, deviceIdForHost, fingerprint } from '../src/util.js';
import { configureWiimTls, normalizeObservation, sourceName, wiimTlsOptions } from '../src/wiim.js';

async function withTestServer(dir, options, run) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    devices: [],
    pollIntervalMs: 1000,
    requestTimeoutMs: 500,
    minPlayMs: 0,
  }, null, 2)}\n`);
  const previousPort = process.env.MELUNE_PORT;
  delete process.env.MELUNE_PORT;
  let server;
  let poller;
  try {
    ({ server, poller } = await startServer({ configPath, restart: () => {}, ...options }));
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (previousPort === undefined) delete process.env.MELUNE_PORT;
    else process.env.MELUNE_PORT = previousPort;
    poller?.stop();
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('subnet helpers expand a LAN range', () => {
  assert.deepEqual(parseSubnet('192.168.2.0/24'), {
    base: '192.168.2.0',
    baseInt: 0xc0a80200,
    prefix: 24,
  });
  assert.deepEqual(parseSubnet('192.168.2'), parseSubnet('192.168.2.135'));

  const hosts = hostsFor('192.168.2.0/24');
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], '192.168.2.1');
  assert.equal(hosts.at(-1), '192.168.2.254');

  assert.equal(isAllowedDiscoverySubnet('10.0.0.0/24'), true);
  assert.equal(isAllowedDiscoverySubnet('192.168.2.135'), true);
  assert.equal(isAllowedDiscoverySubnet('169.254.1.0/24'), true);
  assert.equal(isAllowedDiscoverySubnet('8.8.8.0/24'), false);
  assert.equal(isAllowedDiscoverySubnet('172.32.0.0/24'), false);
  assert.equal(isAllowedDiscoverySubnet('nope'), false);
});

test('hex metadata is decoded only when it round-trips', () => {
  assert.equal(decodeMaybeHex('4D6F726E696E67204C69676874'), 'Morning Light');
  assert.equal(decodeMaybeHex('48656c6c6f'), 'Hello');
  assert.equal(decodeMaybeHex('deadbeef'), 'deadbeef');
  assert.equal(decodeMaybeHex('plain text'), 'plain text');
});

test('missing metadata markers become null', () => {
  assert.equal(cleanMeta('unknow'), null);
  assert.equal(cleanMeta(' Unknown '), null);
  assert.equal(cleanMeta('  Hello   World '), 'Hello World');
});

test('fingerprints ignore case and punctuation', () => {
  const a = fingerprint({ artist: 'Owen Ringeling', title: 'Morning Light', album: 'Morning Light' });
  const b = fingerprint({ artist: '  owen ringeling ', title: 'morning-light!', album: 'Morning  Light' });
  assert.equal(a, b);
  assert.equal(deviceIdForHost('192.168.1.50'), deviceIdForHost('192.168.1.50'));
});

test('WiiM status is normalized with hex metadata and source names', () => {
  const observation = normalizeObservation(
    {
      status: 'play',
      mode: '31',
      curpos: '12000',
      totlen: '200000',
      Title: '4D6F726E696E67204C69676874',
      Artist: '4F77656E2052696E67656C696E67',
    },
    { metaData: { album: 'Morning Light', albumArtURI: 'http://local/cover.jpg' } },
    1234,
  );
  assert.equal(observation.track.title, 'Morning Light');
  assert.equal(observation.track.artist, 'Owen Ringeling');
  assert.equal(observation.track.album, 'Morning Light');
  assert.equal(observation.track.artUri, 'http://local/cover.jpg');
  assert.equal(observation.source, 'spotify');
  assert.equal(observation.positionMs, 12000);
  assert.equal(sourceName(10), 'wiim');
  assert.equal(sourceName(41), 'bluetooth');
});

test('vendor refines service names for network playback', () => {
  assert.equal(sourceName(10, 'Tidal'), 'tidal');
  assert.equal(sourceName(10, 'vTuner'), 'radio');
  assert.equal(sourceName(32, 'Tidal'), 'tidal');
  assert.equal(sourceName(33, 'Roon'), 'roon');
  assert.equal(sourceName(40, 'Tidal'), 'aux-in');
  const observation = normalizeObservation({ status: 'play', mode: '10', vendor: 'vTuner' });
  assert.equal(observation.source, 'radio');
});

test('tags map to moods', () => {
  const sad = scoreMood([{ name: 'melancholy', weight: 10 }]);
  assert.equal(sad.mood, 'sad');
  assert.ok(sad.scores.sad > 0);

  const calm = scoreMood([{ name: 'ambient', weight: 5 }, { name: 'instrumental', weight: 2 }]);
  assert.equal(calm.mood, 'calm');

  assert.equal(scoreMood([]).mood, null);
});

test('local metadata infers moods without partial word matches', () => {
  assert.equal(localMood({ title: 'Chill Ambient', artist: 'Test Artist' }).mood, 'calm');
  assert.equal(localMood({ title: 'Dance Anthem', artist: 'Test Artist' }).mood, 'energetic');
  assert.equal(localMood({ title: 'Sadie', artist: 'Test Artist' }).mood, null);
  assert.equal(localMood({ title: 'Fast Car', artist: 'Tracy Chapman' }).mood, null);
  assert.equal(localMood({ title: 'Sad Eyed Lady of the Lowlands', artist: 'Bob Dylan' }).mood, null);
  assert.equal(localMood({ title: 'Into The Black', album: 'Kill For Love' }).mood, null);
});

test('tracks without a mood use neutral gray', () => {
  assert.equal(moodColor(null), '#6b7280');
  assert.equal(moodColor('unknown'), '#6b7280');
});

test('local moods never replace a MusicBrainz mood', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-mood-'));
  try {
    const db = openDb(dir);
    const track = { artist: 'Test Artist', title: 'Chill Ambient' };
    const id = getOrCreateTrack(db, track);
    const local = db.prepare('SELECT mood, source FROM track_mood WHERE track_id = ?').get(id);
    assert.equal(local.mood, 'calm');
    assert.equal(local.source, 'local');

    setTrackMood(db, id, 'happy', { happy: 1 }, { source: 'musicbrainz' });
    getOrCreateTrack(db, track);
    const enriched = db.prepare('SELECT mood, source FROM track_mood WHERE track_id = ?').get(id);
    assert.equal(enriched.mood, 'happy');
    assert.equal(enriched.source, 'musicbrainz');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MusicBrainz tags are merged before storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-tags-'));
  try {
    const db = openDb(dir);
    const enricher = new Enricher(db);
    enricher.mbRequest = async (path, params = {}) => {
      if (path === 'release-group' && params.query) {
        return { 'release-groups': [{ id: 'rg1' }] };
      }
      if (path === 'release-group/rg1') {
        return {
          tags: [
            { name: 'Rock', count: 5 },
            { name: 'rock', count: 9 },
            { name: 'Metal', count: 2 },
          ],
          genres: [{ name: 'rock', count: 7 }],
        };
      }
      throw new Error(`unexpected path ${path}`);
    };
    const tags = await enricher.mbTags({ artist: 'A', title: 'B', album: 'C' });
    assert.deepEqual(tags, [
      { name: 'Rock', weight: 9, source: 'musicbrainz' },
      { name: 'Metal', weight: 2, source: 'musicbrainz' },
    ]);
    const trackId = getOrCreateTrack(db, { artist: 'A', title: 'B' });
    upsertTrackTags(db, trackId, tags, 'musicbrainz');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM track_tags WHERE track_id = ? AND source = 'musicbrainz'").get(trackId).n, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MusicBrainz retries rate limits and tries alternate matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-mbretry-'));
  try {
    const db = openDb(dir);
    const enricher = new Enricher(db);
    enricher.sleep = async () => {};
    let requests = 0;
    enricher.fetch = async (url) => {
      requests += 1;
      const parsed = new URL(url);
      if (requests === 1) {
        return { ok: false, status: 503, headers: { get: () => null } };
      }
      const json = async () => {
        if (parsed.pathname.endsWith('/release-group')) {
          return { 'release-groups': [{ id: 'bad' }, { id: 'good' }] };
        }
        if (parsed.pathname.endsWith('/release-group/bad')) return { tags: [], genres: [] };
        if (parsed.pathname.endsWith('/release-group/good')) {
          return { tags: [{ name: 'ambient', count: 3 }], genres: [] };
        }
        return {};
      };
      return { ok: true, status: 200, headers: { get: () => null }, json };
    };

    const tags = await enricher.mbTags({ artist: 'A', title: 'B', album: 'C' });
    assert.deepEqual(tags, [{ name: 'ambient', weight: 3, source: 'musicbrainz' }]);
    assert.equal(requests, 4);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enrichment needs no API key and skips empty tracks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-enrich-'));
  try {
    const db = openDb(dir);
    const enricher = new Enricher(db);
    enricher.enqueue({});
    assert.equal(enricher.status().skipped, 1);
    assert.equal(enricher.status().configured.musicbrainz, true);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enrichment backs off retries and caps its queue and seen set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-enrich-limits-'));
  try {
    const db = openDb(dir);
    const enricher = new Enricher(db);
    // Keep this test about admission control, not network calls.
    enricher.drain = async () => {};
    const track = { artist: 'Artist', title: 'Track' };

    assert.equal(enricher.enqueue(track), true);
    assert.equal(enricher.enqueue(track), false);
    enricher.queue.length = 0;
    assert.equal(enricher.enqueue(track), false);
    assert.equal(enricher.stats.backedOff, 1);

    for (let index = 0; index < 60; index += 1) {
      enricher.enqueue({ artist: 'Artist', title: `Track ${index}` });
    }
    assert.equal(enricher.queue.length, 50);
    assert.equal(enricher.stats.dropped, 10);
    assert.ok(enricher.attempts.size <= 500);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WiiM TLS verification can be enabled with a custom CA', () => {
  try {
    configureWiimTls({ tlsRejectUnauthorized: true, tlsCaFile: '/tmp/melune-ca.pem' });
    assert.deepEqual(wiimTlsOptions(), {
      rejectUnauthorized: true,
      caFile: '/tmp/melune-ca.pem',
    });
  } finally {
    configureWiimTls({ tlsRejectUnauthorized: false, tlsCaFile: null });
  }
  assert.deepEqual(wiimTlsOptions(), { rejectUnauthorized: false, caFile: null });
});

test('play tracking dedupes polls and ignores pause time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-track-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const started = [];
    const tracker = new PlayTracker(db, {
      pollIntervalMs: 5000,
      minPlayMs: 0,
      onPlayStarted: (play) => started.push(play),
    });
    const observation = (at, status, track, positionMs) => ({
      at,
      status,
      track,
      positionMs,
      durationMs: 200000,
      source: 'wiim',
    });
    const a = { artist: 'Artist A', title: 'Track A' };
    const b = { artist: 'Artist B', title: 'Track B' };

    tracker.observe('d1', observation(1000, 'play', a, 0));
    tracker.observe('d1', observation(6000, 'play', a, 5000));
    tracker.observe('d1', observation(11000, 'pause', a, 5000));
    tracker.observe('d1', observation(60000, 'play', a, 5000));
    tracker.observe('d1', observation(65000, 'play', a, 10000));
    tracker.observe('d1', observation(70000, 'play', b, 0));

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(started.length, 2);
    assert.equal(plays.length, 2);
    assert.equal(plays[0].played_ms, 10_000);
    assert.equal(plays[0].ended_at, 70000);
    assert.equal(plays[1].played_ms, 0);
    assert.equal(plays[1].ended_at, null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('playback with blank metadata records an Unknown track instead of failing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-unknown-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const started = [];
    const tracker = new PlayTracker(db, {
      pollIntervalMs: 5000,
      minPlayMs: 0,
      onPlayStarted: (play) => started.push(play),
    });
    const observe = (at, status, positionMs) => tracker.observe('d1', {
      at,
      status,
      source: 'wiim',
      positionMs,
      track: {},
    });

    observe(1000, 'play', 0);
    observe(6000, 'play', 5000);
    observe(11_000, 'stop', 5000);

    const plays = db.prepare(`
      SELECT p.*, t.title FROM plays p JOIN tracks t ON t.id = p.track_id
    `).all();
    assert.equal(plays.length, 1);
    assert.equal(plays[0].title, 'Unknown track');
    assert.equal(plays[0].played_ms, 5000);
    assert.equal(started.length, 1);
    assert.ok(started[0].trackId);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delayed polls use playback position instead of a short wall-clock cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-tick-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    const observe = (at, track, positionMs, status = 'play') => tracker.observe('d1', {
      at, status, source: 'wiim', positionMs, track,
    });
    const one = { title: 'One', artist: 'Artist' };
    const two = { title: 'Two', artist: 'Artist' };

    observe(1000, one, 0);
    observe(31_000, one, 30_000);
    observe(32_000, one, 30_000, 'stop');
    observe(33_000, two, 0);
    observe(43_000, two, 200_000);
    observe(44_000, two, 200_000, 'stop');

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 2);
    assert.equal(plays[0].played_ms, 30_000);
    assert.equal(plays[1].played_ms, 10_000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stats aggregate plays from SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-stats-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    const at = Date.now();
    tracker.observe('d1', { at: at - 60_000, status: 'play', source: 'spotify', positionMs: 0, track: { title: 'One', artist: 'Artist' } });
    tracker.observe('d1', { at: at - 55_000, status: 'play', source: 'spotify', positionMs: 5000, track: { title: 'One', artist: 'Artist' } });
    tracker.observe('d1', { at: at - 40_000, status: 'play', source: 'spotify', positionMs: 0, track: { title: 'Two', artist: 'Artist' } });

    const summary = getSummary(db, { from: 0, to: at, deviceId: 'd1' });
    assert.equal(summary.totals.plays, 2);
    assert.equal(summary.totals.uniqueTracks, 2);
    assert.equal(summary.topTracks[0].plays, 1);
    assert.equal(summary.topArtists[0].artist, 'Artist');
    assert.equal(summary.moods[0].mood, 'unknown');
    assert.equal(rangeBounds('week', at).to - rangeBounds('week', at).from, 7 * 24 * 60 * 60 * 1000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summary cache invalidates when plays change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-cache-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const trackId = getOrCreateTrack(db, { title: 'One', artist: 'Artist' });
    const options = { from: 0, to: 120_000 };

    const first = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 1000, source: 'wiim', positionStartMs: 0,
    });
    updatePlayTick(db, first, 10_000, 10_000);
    endPlay(db, first, 11_000, 10_000);
    assert.equal(getSummary(db, options).totals.plays, 1);

    const second = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 20_000, source: 'wiim', positionStartMs: 0,
    });
    updatePlayTick(db, second, 10_000, 10_000);
    endPlay(db, second, 31_000, 10_000);
    assert.equal(getSummary(db, options).totals.plays, 2);

    // Plain played_ms ticks do not invalidate the structural cache; both
    // aggregates and recent rows still report the new duration.
    const beforeMs = getSummary(db, options).totals.playedMs;
    const beforeRows = getRecentPlays(db, { from: 0, to: 120_000 });
    const beforeRowMs = beforeRows.find((row) => row.id === second).played_ms;
    db.prepare('UPDATE plays SET played_ms = played_ms + 5000 WHERE id = ?').run(second);
    assert.equal(getSummary(db, options).totals.playedMs, beforeMs + 5000);
    assert.equal(getSummary(db, options).totals.plays, 2);
    const afterRows = getRecentPlays(db, { from: 0, to: 120_000 });
    assert.equal(afterRows.find((row) => row.id === second).played_ms, 15_000);
    assert.equal(beforeRowMs, 10_000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multiroom plays with the same start and finish count once across devices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-multiroom-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    upsertDevice(db, { id: 'd2', name: 'Kitchen', host: '192.168.1.51' }, {}, 1000);
    upsertDevice(db, { id: 'd3', name: 'Studio', host: '192.168.1.52' }, {}, 1000);
    const trackId = getOrCreateTrack(db, { title: 'One', artist: 'Artist' });

    for (const deviceId of ['d1', 'd2']) {
      const playId = startPlay(db, {
        deviceId, trackId, startedAt: 1000, source: 'wiim', positionStartMs: 0,
      });
      updatePlayTick(db, playId, 60_000, 60_000);
      endPlay(db, playId, 61_000, 60_000);
    }

    const summary = getSummary(db, { from: 0, to: 120_000 });
    assert.equal(summary.totals.plays, 1);
    assert.equal(summary.totals.playedMs, 60_000);
    assert.equal(summary.totals.uniqueTracks, 1);
    assert.equal(summary.topTracks[0].plays, 1);
    assert.equal(summary.timeline[0].plays, 1);
    assert.equal(getSummary(db, { from: 0, to: 120_000, deviceId: 'd1' }).totals.plays, 1);
    assert.equal(getSummary(db, { from: 0, to: 120_000, deviceId: 'd2' }).totals.plays, 1);
    assert.equal(getRecentPlays(db, { from: 0, to: 120_000 }).length, 1);
    assert.equal(getRecentPlays(db, { from: 0, to: 120_000, deviceId: 'd2' }).length, 1);

    const lateDevice = startPlay(db, {
      deviceId: 'd3', trackId, startedAt: 6000, source: 'wiim', positionStartMs: 5000,
    });
    updatePlayTick(db, lateDevice, 55_000, 65_000);
    endPlay(db, lateDevice, 65_000, 65_000);
    assert.equal(getSummary(db, { from: 0, to: 120_000 }).totals.plays, 1);

    const laterPlay = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 120_000, source: 'wiim', positionStartMs: 0,
    });
    updatePlayTick(db, laterPlay, 30_000, 30_000);
    endPlay(db, laterPlay, 151_000, 30_000);
    assert.equal(getSummary(db, { from: 0, to: 200_000 }).totals.plays, 2);
    assert.equal(getRecentPlays(db, { from: 0, to: 200_000 }).length, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('play dedupe keeps the longest play and breaks ties by id', () => {
  const rows = [
    { id: 9, device_id: 'a', track_id: 't1', started_at: 1000, ended_at: 2000, played_ms: 1000 },
    { id: 4, device_id: 'b', track_id: 't1', started_at: 1000, ended_at: 2000, played_ms: 1000 },
    { id: 5, device_id: 'c', track_id: 't1', started_at: 1000, ended_at: 2000, played_ms: 1500 },
    { id: 7, device_id: 'd', track_id: 't1', started_at: 3000, ended_at: 3500, played_ms: 500 },
    { id: 3, device_id: 'e', track_id: 't1', started_at: 3000, ended_at: 3500, played_ms: 500 },
    { id: 8, device_id: 'f', track_id: 't1', started_at: 5000, ended_at: null, played_ms: 100 },
    { id: 2, device_id: 'a', track_id: 't2', started_at: 1000, ended_at: 2000, played_ms: 1000 },
  ];
  assert.deepEqual(dedupePlayRows(rows), [2, 3, 5, 8]);
});

test('play dedupe groups staggered multiroom plays but preserves distinct sources', () => {
  const rows = [
    {
      id: 1, device_id: 'a', track_id: 't1', started_at: 1000, ended_at: 61_000,
      played_ms: 60_000, source: 'wiim', position_start_ms: 0, position_end_ms: 60_000,
    },
    {
      id: 2, device_id: 'b', track_id: 't1', started_at: 6000, ended_at: 65_000,
      played_ms: 55_000, source: 'wiim', position_start_ms: 5000, position_end_ms: 65_000,
    },
    {
      id: 3, device_id: 'a', track_id: 't1', started_at: 120_000, ended_at: 150_000,
      played_ms: 30_000, source: 'wiim', position_start_ms: 0, position_end_ms: 30_000,
    },
    {
      id: 4, device_id: 'b', track_id: 't1', started_at: 126_000, ended_at: 156_000,
      played_ms: 30_000, source: 'airplay', position_start_ms: 0, position_end_ms: 30_000,
    },
  ];
  assert.deepEqual(dedupePlayRows(rows), [1, 3, 4]);
});

test('timeline reports the dominant mood for each day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-timeline-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const calm = getOrCreateTrack(db, { title: 'Calm', artist: 'Artist' });
    const sad = getOrCreateTrack(db, { title: 'Sad', artist: 'Artist' });
    const untagged = getOrCreateTrack(db, { title: 'Untagged', artist: 'Artist' });
    setTrackMood(db, calm, 'calm', {});
    setTrackMood(db, sad, 'sad', {});
    for (const [trackId, at] of [
      [calm, 1000], [calm, 20_000], [sad, 40_000],
      [untagged, 50_000], [untagged, 60_000], [untagged, 70_000],
      [untagged, 80_000], [untagged, 90_000],
    ]) {
      const playId = startPlay(db, { deviceId: 'd1', trackId, startedAt: at, source: 'wiim' });
      updatePlayTick(db, playId, 5000, 5000);
      endPlay(db, playId, at + 6000, 5000);
    }

    const summary = getSummary(db, { from: 0, to: 120_000 });
    assert.equal(summary.timeline.length, 1);
    assert.equal(summary.timeline[0].plays, 8);
    assert.equal(summary.timeline[0].mood, 'calm');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artist images come from Deezer and are cached locally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-artist-image-'));
  try {
    const db = openDb(dir);
    const imageUrl = 'https://cdn-images.dzcdn.net/images/artist/abc/500x500.jpg';
    let metadataCalls = 0;
    let imageCalls = 0;
    const service = createArtService(db, dir, {
      jsonFetcher: async (url) => {
        metadataCalls += 1;
        assert.match(url, /api\.deezer\.com\/search\/artist/);
        return { data: [{ name: 'Artist', picture_xl: imageUrl }] };
      },
      fetcher: async (url) => {
        imageCalls += 1;
        assert.equal(url, imageUrl);
        return {
          buffer: Buffer.from('ffd8ffe000104a4649460001', 'hex'),
          contentType: 'image/jpeg',
        };
      },
    });

    const first = await service.getArtist('Artist');
    const second = await service.getArtist('Artist');

    assert.equal(metadataCalls, 1);
    assert.equal(imageCalls, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(getArtistImage(db, 'Artist').image_url, imageUrl);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('album art is fetched once and cached locally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-art-'));
  try {
    const db = openDb(dir);
    const trackId = getOrCreateTrack(db, {
      title: 'Covered',
      artist: 'Artist',
      artUri: 'https://example.test/cover.jpg',
    });
    let calls = 0;
    const service = createArtService(db, dir, {
      fetcher: async () => {
        calls += 1;
        return {
          buffer: Buffer.from('ffd8ffe000104a4649460001', 'hex'),
          contentType: 'image/jpeg',
        };
      },
    });

    const first = await service.get(trackId);
    const second = await service.get(trackId);

    assert.equal(calls, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(first.contentType, 'image/jpeg');
    assert.equal(detectImageType(first.buffer), 'image/jpeg');
    assert.ok(fs.existsSync(path.join(dir, 'art')));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a brief stop and resume of the same track counts as one play', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-resume-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    const track = { title: 'One', artist: 'Artist' };
    const observe = (at, status, positionMs) => tracker.observe('d1', {
      at,
      status,
      source: 'wiim',
      positionMs,
      track,
    });

    observe(1000, 'play', 0);
    observe(6000, 'play', 5000);
    observe(8000, 'stop', 7000);
    observe(12000, 'play', 9000);
    observe(22000, 'play', 19000);

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 1);
    assert.equal(plays[0].ended_at, null);
    // The device reports position 7s -> 9s across the brief stop, so that
    // interval was real playback rather than paused time.
    assert.equal(plays[0].played_ms, 17_000);
    assert.equal(plays[0].position_start_ms, 0);
    assert.ok(plays[0].position_end_ms >= 19_000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real repeat is still a separate play', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-repeat-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    const track = { title: 'One', artist: 'Artist' };
    const observe = (at, status, positionMs) => tracker.observe('d1', {
      at,
      status,
      source: 'wiim',
      positionMs,
      track,
    });

    observe(1000, 'play', 0);
    observe(6000, 'play', 200_000);
    observe(8000, 'stop', 205_000);
    observe(12000, 'play', 0);

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 2);
    assert.equal(plays[1].position_start_ms, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a track change keeps the old play end position', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-change-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    tracker.observe('d1', {
      at: 1000, status: 'play', source: 'wiim', positionMs: 1000,
      track: { title: 'One', artist: 'Artist' },
    });
    tracker.observe('d1', {
      at: 6000, status: 'play', source: 'wiim', positionMs: 6000,
      track: { title: 'One', artist: 'Artist' },
    });
    tracker.observe('d1', {
      at: 11_000, status: 'play', source: 'wiim', positionMs: 225,
      track: { title: 'Two', artist: 'Artist' },
    });

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 2);
    assert.equal(plays[0].position_end_ms, 6000);
    assert.equal(plays[1].position_start_ms, 225);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an open play survives a tracker restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-restart-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const track = { title: 'One', artist: 'Artist' };
    const observe = (tracker, at, positionMs) => tracker.observe('d1', {
      at,
      status: 'play',
      source: 'wiim',
      positionMs,
      track,
    });
    const first = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    observe(first, 1000, 0);
    observe(first, 6000, 5000);

    const second = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    observe(second, 11000, 10_000);
    observe(second, 21000, 20_000);

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 1);
    // Position advances 15s across the restart, so the full interval counts.
    assert.equal(plays[0].played_ms, 20_000);
    assert.equal(plays[0].ended_at, null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a device closes its open play and stops polling it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-remove-'));
  try {
    const db = openDb(dir);
    const device = { id: deviceIdForHost('192.168.1.60'), name: 'Office', host: '192.168.1.60' };
    const other = { id: deviceIdForHost('192.168.1.61'), name: 'Room', host: '192.168.1.61' };
    upsertDevice(db, device, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 0 });
    tracker.observe(device.id, {
      at: 1000, status: 'play', source: 'wiim', positionMs: 0,
      track: { title: 'One', artist: 'Artist' },
    });
    const poller = new Poller({
      config: { devices: [device, other], pollIntervalMs: 5000, requestTimeoutMs: 100 },
      db,
      tracker,
    });

    assert.ok(getOpenPlay(db, device.id));
    assert.equal(poller.removeDevice(device.host)?.host, device.host);
    assert.equal(poller.removeDevice(device.host), null);
    assert.equal(getOpenPlay(db, device.id), null);
    assert.equal(tracker.getState(device.id).openPlays, null);
    assert.deepEqual(poller.config.devices.map((entry) => entry.host), [other.host]);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stored duplicate segments are merged on cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-merge-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const trackId = getOrCreateTrack(db, { title: 'One', artist: 'Artist' });
    const first = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 1000, source: 'wiim', positionStartMs: 0,
    });
    updatePlayTick(db, first, 5000, 5000);
    endPlay(db, first, 7000, 5000);
    const second = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 12_000, source: 'wiim', positionStartMs: 9000,
    });
    updatePlayTick(db, second, 4000, 13_000);
    endPlay(db, second, 16_000, 13_000);

    assert.equal(mergeDuplicatePlays(db), 1);
    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 1);
    assert.equal(plays[0].played_ms, 9000);
    assert.equal(plays[0].ended_at, 16_000);
    assert.equal(plays[0].position_end_ms, 13_000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('play segments split by a poll outage are merged when the position moves forward', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-outage-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const trackId = getOrCreateTrack(db, { title: 'One', artist: 'Artist' });
    const first = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 1000, source: 'wiim', positionStartMs: 3000,
    });
    updatePlayTick(db, first, 60_000, 63_000);
    endPlay(db, first, 61_000, 63_000);
    const second = startPlay(db, {
      deviceId: 'd1', trackId, startedAt: 301_000, source: 'wiim', positionStartMs: 303_000,
    });
    updatePlayTick(db, second, 30_000, 333_000);
    endPlay(db, second, 332_000, 333_000);

    assert.equal(mergeDuplicatePlays(db), 1);
    const plays = db.prepare('SELECT * FROM plays').all();
    assert.equal(plays.length, 1);
    assert.equal(plays[0].played_ms, 90_000);
    assert.equal(plays[0].position_start_ms, 3000);
    assert.equal(plays[0].position_end_ms, 333_000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a track skipped after a few seconds is not counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-skip-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 30_000 });
    const observe = (at, track, positionMs) => tracker.observe('d1', {
      at, status: 'play', source: 'wiim', positionMs, track,
    });
    const skipped = { title: 'Skipped', artist: 'Artist' };
    const kept = { title: 'Kept', artist: 'Artist' };

    observe(1000, skipped, 0);
    observe(6000, skipped, 5000);
    observe(11_000, kept, 0);

    const plays = db.prepare('SELECT t.title, p.played_ms FROM plays p JOIN tracks t ON t.id = p.track_id').all();
    assert.equal(plays.length, 1);
    assert.equal(plays[0].title, 'Kept');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a track played past the threshold is still counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-kept-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const tracker = new PlayTracker(db, { pollIntervalMs: 5000, minPlayMs: 30_000 });
    const track = { title: 'Kept', artist: 'Artist' };
    const observe = (at, positionMs) => tracker.observe('d1', {
      at, status: 'play', source: 'wiim', positionMs, track,
    });

    observe(1000, 0);
    observe(11_000, 10_000);
    observe(21_000, 20_000);
    observe(31_000, 30_000);
    observe(41_000, 40_000);
    tracker.observe('d1', {
      at: 51_000, status: 'stop', source: 'wiim', positionMs: 40_000, track,
    });

    const plays = db.prepare('SELECT * FROM plays ORDER BY id').all();
    assert.equal(plays.length, 1);
    assert.equal(plays[0].played_ms, 40_000);
    assert.equal(plays[0].ended_at, 51_000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('short stored plays are removed on cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-cleanup-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const short = getOrCreateTrack(db, { title: 'Short', artist: 'Artist' });
    const long = getOrCreateTrack(db, { title: 'Long', artist: 'Artist' });
    const a = startPlay(db, { deviceId: 'd1', trackId: short, startedAt: 1000, source: 'wiim' });
    updatePlayTick(db, a, 10_000, 10_000);
    endPlay(db, a, 11_000, 10_000);
    const b = startPlay(db, { deviceId: 'd1', trackId: long, startedAt: 20_000, source: 'wiim' });
    updatePlayTick(db, b, 40_000, 40_000);
    endPlay(db, b, 60_000, 40_000);

    assert.equal(removeShortPlays(db, 30_000), 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plays').get().n, 1);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting data removes the database and art cache without touching config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-wipe-'));
  const configPath = path.join(dir, 'config.json');
  const dataDir = path.join(dir, 'data');
  const savedConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    devices: [],
    pollIntervalMs: 1000,
    requestTimeoutMs: 500,
    minPlayMs: 0,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(savedConfig, null, 2)}\n`);
  fs.mkdirSync(path.join(dataDir, 'art'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'art', 'cached.txt'), 'sentinel');

  const previousPort = process.env.MELUNE_PORT;
  delete process.env.MELUNE_PORT;
  let server;
  let restarted = false;
  try {
    ({ server } = await startServer({
      configPath,
      restart: () => { restarted = true; },
    }));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.ok(fs.existsSync(path.join(dataDir, 'melune.db')));

    const rejected = await fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'no' }),
    });
    assert.equal(rejected.status, 400);
    assert.ok(fs.existsSync(path.join(dataDir, 'melune.db')));

    const response = await fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE ALL DATA' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, restarting: true });

    for (let attempt = 0; attempt < 80 && !restarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(restarted, true);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(fs.existsSync(path.join(dataDir, `melune.db${suffix}`)), false);
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'art')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), savedConfig);
  } finally {
    if (previousPort === undefined) delete process.env.MELUNE_PORT;
    else process.env.MELUNE_PORT = previousPort;
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second instance fails before touching the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-port-'));
  const firstDir = path.join(dir, 'first');
  const secondDir = path.join(dir, 'second');
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  const firstConfig = path.join(dir, 'first.json');
  const secondConfig = path.join(dir, 'second.json');
  const previousPort = process.env.MELUNE_PORT;
  delete process.env.MELUNE_PORT;
  let server;
  let poller;
  try {
    fs.writeFileSync(firstConfig, `${JSON.stringify({
      host: '127.0.0.1', port: 0, dataDir: firstDir, devices: [],
    }, null, 2)}\n`);
    ({ server, poller } = await startServer({ configPath: firstConfig, restart: () => {} }));
    const port = server.address().port;

    const seed = openDb(secondDir);
    const trackId = getOrCreateTrack(seed, { artist: 'Test Artist', title: 'Chill Ambient' });
    seed.prepare("UPDATE track_mood SET mood = NULL, scores = NULL, source = 'local' WHERE track_id = ?").run(trackId);
    seed.close();
    fs.writeFileSync(secondConfig, `${JSON.stringify({
      host: '127.0.0.1', port, dataDir: secondDir, devices: [],
    }, null, 2)}\n`);

    await assert.rejects(
      startServer({ configPath: secondConfig, restart: () => {} }),
      /EADDRINUSE/,
    );
    const check = openDb(secondDir);
    const mood = check.prepare('SELECT mood FROM track_mood WHERE track_id = ?').get(trackId);
    assert.equal(mood.mood, null);
    check.close();
  } finally {
    if (previousPort === undefined) delete process.env.MELUNE_PORT;
    else process.env.MELUNE_PORT = previousPort;
    poller?.stop();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API has no wildcard CORS and rejects unsafe mutation requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-origin-'));
  await withTestServer(dir, {}, async (base) => {
    const meta = await fetch(`${base}/api/meta`);
    assert.equal(meta.status, 200);
    assert.equal(meta.headers.get('access-control-allow-origin'), null);

    const crossOrigin = await fetch(`${base}/api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ host: '192.168.1.99' }),
    });
    assert.equal(crossOrigin.status, 403);

    const crossSite = await fetch(`${base}/api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ host: '192.168.1.99' }),
    });
    assert.equal(crossSite.status, 403);

    const wrongType = await fetch(`${base}/api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ host: '192.168.1.99' }),
    });
    assert.equal(wrongType.status, 400);
    assert.match((await wrongType.json()).error, /application\/json/);

    const added = await fetch(`${base}/api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: '192.168.1.99', name: 'Office' }),
    });
    assert.equal(added.status, 201);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(saved.devices.map((device) => device.host), ['192.168.1.99']);
  });
});

test('static paths reject malformed escapes and traversal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-static-'));
  await withTestServer(dir, {}, async (base) => {
    const [malformed, traversal, fallback, asset] = await Promise.all([
      fetch(`${base}/%E0%A4%A`),
      fetch(`${base}/%2e%2e%2fserver.js`),
      fetch(`${base}/not-a-real-page`),
      fetch(`${base}/music-note.svg`),
    ]);
    assert.equal(malformed.status, 400);
    assert.equal(traversal.status, 403);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /id="kpis"/);
    assert.equal(asset.status, 200);
  });
});

test('discovery rejects public subnets and throttles repeated scans', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-discover-'));
  const calls = [];
  await withTestServer(dir, {
    discoveryCooldownMs: 100,
    discoverDevices: async (options) => {
      calls.push(options);
      return [];
    },
  }, async (base) => {
    const publicSubnet = await fetch(`${base}/api/discover?subnet=8.8.8.0%2F24`);
    assert.equal(publicSubnet.status, 400);

    const invalid = await fetch(`${base}/api/discover?subnet=not-a-subnet`);
    assert.equal(invalid.status, 400);

    const first = await fetch(`${base}/api/discover?subnet=192.168.1.0%2F24`);
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).devices, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].subnets, ['192.168.1.0/24']);

    const second = await fetch(`${base}/api/discover?subnet=192.168.1.0%2F24`);
    assert.equal(second.status, 429);
    assert.equal(calls.length, 1);
  });
});

test('alternate views are retired', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-single-page-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    host: '127.0.0.1', port: 0, dataDir: dir, devices: [],
  }, null, 2)}\n`);
  const previousPort = process.env.MELUNE_PORT;
  delete process.env.MELUNE_PORT;
  let server;
  let poller;
  try {
    ({ server, poller } = await startServer({ configPath, restart: () => {} }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const retiredRoutes = [...RETIRED_PAGES];
    const [dashboard, fallbackIcon, ...retired] = await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/music-note.svg`),
      ...retiredRoutes.map((route) => fetch(`${base}${route}`)),
    ]);
    assert.equal(dashboard.status, 200);
    assert.equal(fallbackIcon.status, 200);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /id="kpis"/);
    assert.equal((dashboardHtml.match(/href="\/styles\.css"/g) ?? []).length, 1);
    assert.equal((dashboardHtml.match(/src="\/app\.js"/g) ?? []).length, 1);
    retired.forEach((response, index) => {
      assert.equal(response.status, 404, `${retiredRoutes[index]} should be retired`);
    });
  } finally {
    if (previousPort === undefined) delete process.env.MELUNE_PORT;
    else process.env.MELUNE_PORT = previousPort;
    poller?.stop();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeline days use local time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-timezone-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = `
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(root)};
    const { openDb, upsertDevice, getOrCreateTrack, startPlay } =
      await import(pathToFileURL(path.join(root, 'src/db.js')).href);
    const { getSummary } =
      await import(pathToFileURL(path.join(root, 'src/stats.js')).href);
    const db = openDb(process.env.MELUNE_TEST_DIR);
    upsertDevice(db, { id: 'd1', name: 'D', host: '1.2.3.4' }, {}, 1000);
    const trackId = getOrCreateTrack(db, { artist: 'A', title: 'T' });
    const startedAt = Date.parse('2026-06-01T23:00:00Z');
    startPlay(db, { deviceId: 'd1', trackId, startedAt, source: 'wiim', positionStartMs: 0 });
    console.log(JSON.stringify({ day: getSummary(db, { from: 0, to: Date.now() }).timeline[0].day }));
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: 'Europe/Copenhagen', MELUNE_TEST_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(output).day, '2026-06-02');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
