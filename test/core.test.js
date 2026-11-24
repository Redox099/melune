import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtService, detectImageType } from '../src/art.js';
import { hostsFor, parseSubnet } from '../src/discover.js';
import {
  endPlay,
  getArtistImage,
  getOpenPlay,
  getOrCreateTrack,
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
import { scoreMood } from '../src/mood.js';
import { PlayTracker } from '../src/play-detector.js';
import { Poller } from '../src/poller.js';
import { getSummary, rangeBounds } from '../src/stats.js';
import { cleanMeta, decodeMaybeHex, deviceIdForHost, fingerprint } from '../src/util.js';
import { normalizeObservation, sourceName } from '../src/wiim.js';

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

test('duplicate Last.fm tags are merged before storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-tags-'));
  try {
    const db = openDb(dir);
    const enricher = new Enricher(db, { lastfm: { apiKey: 'test' } });
    enricher.lastfmRequest = async (method) => {
      if (method !== 'track.getInfo') throw new Error(`unexpected method ${method}`);
      return {
        track: {
          toptags: {
            tag: [
              { name: 'Rock', count: 5 },
              { name: 'rock', count: 9 },
              { name: 'Metal', count: 2 },
            ],
          },
        },
      };
    };
    const tags = await enricher.lastfmTags({ artist: 'A', title: 'B' });
    assert.deepEqual(tags, [
      { name: 'Rock', weight: 9, source: 'lastfm' },
      { name: 'Metal', weight: 2, source: 'lastfm' },
    ]);
    const trackId = getOrCreateTrack(db, { artist: 'A', title: 'B' });
    upsertTrackTags(db, trackId, tags, 'lastfm');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_tags WHERE track_id = ?').get(trackId).n, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enrichment degrades safely without API keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-enrich-'));
  try {
    const db = openDb(dir);
    const enricher = new Enricher(db, { lastfm: { apiKey: '' } });
    enricher.enqueue({ title: 'A', artist: 'B' });
    assert.equal(enricher.status().skipped, 1);
    assert.equal(enricher.status().configured.lastfm, false);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('timeline reports the dominant mood for each day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melune-timeline-'));
  try {
    const db = openDb(dir);
    upsertDevice(db, { id: 'd1', name: 'Living Room', host: '192.168.1.50' }, {}, 1000);
    const calm = getOrCreateTrack(db, { title: 'Calm', artist: 'Artist' });
    const sad = getOrCreateTrack(db, { title: 'Sad', artist: 'Artist' });
    setTrackMood(db, calm, 'calm', {});
    setTrackMood(db, sad, 'sad', {});
    for (const [trackId, at] of [[calm, 1000], [calm, 20_000], [sad, 40_000]]) {
      const playId = startPlay(db, { deviceId: 'd1', trackId, startedAt: at, source: 'wiim' });
      updatePlayTick(db, playId, 5000, 5000);
      endPlay(db, playId, at + 6000, 5000);
    }

    const summary = getSummary(db, { from: 0, to: 60_000 });
    assert.equal(summary.timeline.length, 1);
    assert.equal(summary.timeline[0].plays, 3);
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
    assert.equal(plays[0].played_ms, 15_000);
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
    assert.equal(plays[0].played_ms, 15_000);
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
