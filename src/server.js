import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtService } from './art.js';
import { loadConfig } from './config.js';
import { endPlay, getRecentPlays, mergeDuplicatePlays, openDb } from './db.js';
import { Enricher } from './enrichment.js';
import { getMeta, getSummary, getTrackDetails, rangeBounds } from './stats.js';
import { PlayTracker } from './play-detector.js';
import { Poller } from './poller.js';
import { clamp } from './util.js';

const webDir = fileURLToPath(new URL('./web/', import.meta.url));
const startedAt = Date.now();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function parseQuery(req) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(webDir, requested);
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let target = filePath;
  if (!fs.existsSync(target) && !path.extname(target)) target = path.join(webDir, 'index.html');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}

function sendArt(res, art, trackId) {
  void art
    .get(trackId)
    .then(({ buffer, contentType, cached, stale }) => {
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=86400',
        'X-Cover-Cache': stale ? 'stale' : cached ? 'hit' : 'miss',
      });
      res.end(buffer);
    })
    .catch(() => {
      if (res.headersSent) return;
      sendJson(res, 404, { error: 'Cover unavailable' });
    });
}

function main() {
  const config = loadConfig();
  const db = openDb(config.dataDir);
  const merged = mergeDuplicatePlays(db);
  if (merged) console.log(`merged ${merged} duplicate play segments`);
  const art = createArtService(db, config.dataDir);
  const enricher = new Enricher(db, config);
  const backfilled = enricher.backfill();
  if (backfilled) console.log(`enriching ${backfilled} previously seen tracks with Last.fm tags`);
  const tracker = new PlayTracker(db, {
    pollIntervalMs: config.pollIntervalMs,
    onPlayStarted: ({ track }) => enricher.enqueue(track),
  });
  const poller = new Poller({ config, db, tracker });

  const server = http.createServer((req, res) => {
    const url = parseQuery(req);
    const route = url.pathname;

    try {
      if (route === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          uptimeMs: Date.now() - startedAt,
          now: Date.now(),
          devices: config.devices.length,
          poller: { running: poller.running, ticks: poller.ticks, pollIntervalMs: config.pollIntervalMs },
          enrichment: enricher.status(),
        });
        return;
      }

      if (route === '/api/devices') {
        sendJson(res, 200, { devices: poller.status() });
        return;
      }

      if (route === '/api/meta') {
        sendJson(res, 200, getMeta());
        return;
      }

      if (route === '/api/stats') {
        const range = url.searchParams.get('range') || 'week';
        const { from, to } = rangeBounds(range);
        const deviceId = url.searchParams.get('device') || null;
        sendJson(res, 200, {
          range,
          from,
          to,
          device: deviceId,
          ...getSummary(db, { from, to, deviceId }),
        });
        return;
      }

      if (route === '/api/plays') {
        const range = url.searchParams.get('range') || 'week';
        const { from, to } = rangeBounds(range);
        const deviceId = url.searchParams.get('device') || null;
        const limit = clamp(Number(url.searchParams.get('limit')) || 50, 1, 200);
        sendJson(res, 200, {
          range,
          from,
          to,
          plays: getRecentPlays(db, { from, to, deviceId, limit }),
        });
        return;
      }

      if (route.startsWith('/api/art/')) {
        let id;
        try {
          id = decodeURIComponent(route.slice('/api/art/'.length));
        } catch {
          id = '';
        }
        if (!/^[\w-]{1,128}$/.test(id)) {
          sendJson(res, 400, { error: 'Invalid track id' });
          return;
        }
        sendArt(res, art, id);
        return;
      }

      if (route.startsWith('/api/tracks/')) {
        const id = route.slice('/api/tracks/'.length);
        const details = getTrackDetails(db, id);
        if (!details) {
          sendJson(res, 404, { error: 'Track not found' });
          return;
        }
        sendJson(res, 200, details);
        return;
      }

      if (route.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Unknown endpoint' });
        return;
      }

      serveStatic(res, route);
    } catch (error) {
      console.error('[http]', error);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: 'Internal server error', message: error.message });
      }
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`melune listening on http://${config.host}:${config.port}`);
    console.log(`devices configured: ${config.devices.length} — poll every ${config.pollIntervalMs}ms`);
    console.log(`database: ${path.join(config.dataDir, 'melune.db')}`);
    if (!config.devices.length) console.warn('Add a WiiM device to config.json to start recording.');
    poller.start();
  });

  const shutdown = () => {
    poller.stop();
    for (const row of db.prepare('SELECT id FROM plays WHERE ended_at IS NULL').all()) {
      endPlay(db, row.id, Date.now());
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
