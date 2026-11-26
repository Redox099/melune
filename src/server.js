import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtService } from './art.js';
import { defaultConfigPath, loadConfig, saveConfig } from './config.js';
import { backfillLocalMoods, endPlay, getRecentPlays, mergeDuplicatePlays, openDb, removeShortPlays } from './db.js';
import { discoverWiimDevices, isAllowedDiscoverySubnet } from './discover.js';
import { Enricher } from './enrichment.js';
import { getMeta, getSummary, rangeBounds } from './stats.js';
import { PlayTracker } from './play-detector.js';
import { Poller } from './poller.js';
import { clamp, deviceIdForHost } from './util.js';
import { configureWiimTls } from './wiim.js';

const webDir = fs.realpathSync(fileURLToPath(new URL('./web/', import.meta.url)));
const startedAt = Date.now();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DISCOVERY_COOLDOWN_MS = 10_000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
export const RETIRED_PAGES = new Set([
  '/calm', '/calm/', '/calm.html', '/calm.css', '/calm.js',
  '/light', '/light/', '/light.html', '/light.css',
  '/notes', '/notes/', '/notes.html', '/notes.css',
  '/minimal', '/minimal/', '/minimal.html', '/minimal.css',
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hostnameOf(authority) {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isTrustedHost(hostname, config) {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const bound = hostnameOf(String(config.host ?? ''));
  // A wildcard bind can still be reached by its LAN IP, but not by a DNS name
  // that an outside page could rebind to that IP.
  if (['0.0.0.0', '::'].includes(bound)) return isAllowedDiscoverySubnet(hostname);
  return Boolean(bound) && hostname === bound;
}

function isTrustedApiRequest(req, config) {
  const hostname = hostnameOf(req.headers.host ?? 'localhost');
  if (!isTrustedHost(hostname, config)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isTrustedHost(parsed.hostname, config)
      && parsed.host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseQuery(req) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new RequestError(400, 'Expected application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new RequestError(400, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new RequestError(400, 'Invalid JSON body');
  }
}

function serveStatic(res, pathname) {
  if (RETIRED_PAGES.has(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  let requested;
  try {
    requested = pathname === '/' ? 'index.html'
      : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  const filePath = path.resolve(webDir, requested);
  if (filePath !== webDir && !filePath.startsWith(webDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let target = filePath;
  let stat;
  try {
    stat = fs.statSync(target);
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
  } catch {
    if (path.extname(target)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    target = path.join(webDir, 'index.html');
    try {
      stat = fs.statSync(target);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  if (realTarget !== webDir && !realTarget.startsWith(webDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(realTarget)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  const stream = fs.createReadStream(realTarget);
  stream.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal server error');
  });
  stream.pipe(res);
}

function sendArt(res, load, errorMessage) {
  void load()
    .then((image) => {
      if (!image) {
        sendJson(res, 404, { error: errorMessage });
        return;
      }
      const { buffer, contentType, cached, stale } = image;
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
      sendJson(res, 404, { error: errorMessage });
    });
}

function defaultRestart() {
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}

export async function startServer({
  configPath = defaultConfigPath(),
  restart = defaultRestart,
  discoverDevices = discoverWiimDevices,
  discoveryCooldownMs = DISCOVERY_COOLDOWN_MS,
} = {}) {
  const config = loadConfig({ configPath });
  configureWiimTls(config);
  const db = openDb(config.dataDir);
  const art = createArtService(db, config.dataDir);
  const enricher = new Enricher(db, config);
  const tracker = new PlayTracker(db, {
    pollIntervalMs: config.pollIntervalMs,
    minPlayMs: config.minPlayMs,
    onPlayStarted: ({ track }) => enricher.enqueue(track),
  });
  const poller = new Poller({ config, db, tracker });
  let wiping = false;
  let discovering = false;
  let lastDiscoveryAt = 0;

  const server = http.createServer(async (req, res) => {
    const url = parseQuery(req);
    const route = url.pathname;

    try {
      if (route.startsWith('/api/') && !isTrustedApiRequest(req, config)) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }

      if (route === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          startedAt,
          uptimeMs: Date.now() - startedAt,
          now: Date.now(),
          devices: config.devices.length,
          poller: { running: poller.running, ticks: poller.ticks, pollIntervalMs: config.pollIntervalMs },
          enrichment: enricher.status(),
        });
        return;
      }

      if (route === '/api/devices' && req.method === 'POST') {
        const body = await readJson(req);
        const host = String(body.host ?? '')
          .trim()
          .replace(/^https?:\/\//, '')
          .replace(/\/$/, '');
        if (!host || !/^[\w.-]{1,128}$/.test(host)) {
          sendJson(res, 400, { error: 'Invalid device host' });
          return;
        }
        const existing = config.devices.find((device) => device.host === host);
        if (existing) {
          sendJson(res, 200, { added: false, device: existing });
          return;
        }
        const device = {
          id: deviceIdForHost(host),
          name: String(body.name ?? '').trim() || host,
          host,
        };
        poller.addDevice(device);
        saveConfig(config, configPath);
        console.log(`[devices] added ${device.name} (${device.host})`);
        sendJson(res, 201, { added: true, device });
        return;
      }

      if (route === '/api/devices' && req.method === 'DELETE') {
        const body = await readJson(req);
        const host = String(body.host ?? url.searchParams.get('host') ?? '').trim();
        const device = poller.removeDevice(host);
        if (!device) {
          sendJson(res, 404, { error: 'Device is not configured' });
          return;
        }
        saveConfig(config, configPath);
        console.log(`[devices] removed ${device.name} (${device.host})`);
        sendJson(res, 200, { removed: true, device });
        return;
      }

      if (route === '/api/devices') {
        sendJson(res, 200, { devices: poller.status() });
        return;
      }

      if (route === '/api/discover') {
        const subnet = url.searchParams.get('subnet');
        if (subnet && !isAllowedDiscoverySubnet(subnet)) {
          sendJson(res, 400, { error: 'Invalid subnet; use a private /24 network' });
          return;
        }
        if (discovering) {
          sendJson(res, 409, { error: 'Discovery is already running' });
          return;
        }
        const now = Date.now();
        if (now - lastDiscoveryAt < discoveryCooldownMs) {
          sendJson(res, 429, { error: 'Discovery was just run; please wait a moment' });
          return;
        }
        discovering = true;
        lastDiscoveryAt = now;
        try {
          let scanned = 0;
          let total = 0;
          const devices = await discoverDevices({
            subnets: subnet ? [subnet] : undefined,
            timeoutMs: 2000,
            requestTimeoutMs: 800,
            onProgress: (event) => {
              if (event.method !== 'scan') return;
              scanned = event.scanned ?? scanned;
              total = event.total ?? total;
            },
          });
          sendJson(res, 200, {
            devices,
            configured: config.devices.map((device) => device.host),
            scanned,
            total,
          });
        } finally {
          discovering = false;
        }
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
        sendArt(res, () => art.get(id), 'Cover unavailable');
        return;
      }

      if (route.startsWith('/api/artist-art/')) {
        let artist;
        try {
          artist = decodeURIComponent(route.slice('/api/artist-art/'.length));
        } catch {
          artist = '';
        }
        if (!artist || artist.length > 128) {
          sendJson(res, 400, { error: 'Invalid artist name' });
          return;
        }
        sendArt(res, () => art.getArtist(artist), 'Artist image unavailable');
        return;
      }

      if (route === '/api/data' && req.method === 'DELETE') {
        const body = await readJson(req);
        if (body.confirm !== 'DELETE ALL DATA') {
          sendJson(res, 400, { error: 'Type DELETE ALL DATA to confirm' });
          return;
        }
        if (wiping) {
          sendJson(res, 409, { error: 'Data deletion is already in progress' });
          return;
        }
        wiping = true;
        await poller.stop();
        try {
          try {
            db.close();
          } catch {
            // The database may already be closed; removal does not depend on it.
          }
          for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(path.join(config.dataDir, `melune.db${suffix}`), { force: true });
          }
          fs.rmSync(path.join(config.dataDir, 'art'), { recursive: true, force: true });
        } catch (error) {
          wiping = false;
          console.error('[data] deletion failed:', error.message);
          sendJson(res, 500, { error: 'Could not delete data' });
          return;
        }
        sendJson(res, 200, { deleted: true, restarting: true });
        // Restart after the response flushes, in a fresh process so no stale
        // in-memory play/art state survives.
        setTimeout(() => {
          let restarted = false;
          const doRestart = () => {
            if (restarted) return;
            restarted = true;
            restart();
          };
          server.close(doRestart);
          server.closeAllConnections?.();
          setTimeout(() => { if (!restarted) doRestart(); }, 3000).unref();
        }, 250);
        return;
      }

      if (route.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Unknown endpoint' });
        return;
      }

      serveStatic(res, route);
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error('[http]', error);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      console.log(`melune listening on http://${config.host}:${config.port}`);
      console.log(`devices configured: ${config.devices.length} — poll every ${config.pollIntervalMs}ms`);
      console.log(`database: ${path.join(config.dataDir, 'melune.db')}`);
      if (!config.devices.length) console.warn('Add a WiiM device to config.json to start recording.');
      resolve();
    });
  });

  // Startup maintenance runs only after the port is secured, so a second
  // instance fails immediately instead of touching the database.
  const localMoods = backfillLocalMoods(db);
  if (localMoods) console.log(`inferred ${localMoods} local moods from track metadata`);
  const merged = mergeDuplicatePlays(db);
  if (merged) console.log(`merged ${merged} duplicate play segments`);
  const skipped = removeShortPlays(db, config.minPlayMs);
  if (skipped) console.log(`removed ${skipped} skipped plays under ${config.minPlayMs}ms`);
  const backfilled = enricher.backfill();
  if (backfilled) console.log(`enriching ${backfilled} previously seen tracks with MusicBrainz tags`);
  poller.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await poller.stop();
    for (const row of db.prepare('SELECT id FROM plays WHERE ended_at IS NULL').all()) {
      endPlay(db, row.id, Date.now());
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  if (restart === defaultRestart) {
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  return { server, config, poller };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void startServer();
}
