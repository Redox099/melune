import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getTrack } from './db.js';

const execFileAsync = promisify(execFile);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONNECT_ERRORS = new Set([
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

function safeContentType(value, buffer) {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase();
  return /^image\/(jpeg|png|gif|webp)$/.test(type) ? type : detectImageType(buffer);
}

export function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return 'image/jpeg';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

async function defaultFetch(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'User-Agent': 'melune/0.1' },
    });
    if (!response.ok) {
      const error = new Error(`Art HTTP ${response.status}`);
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      contentType: safeContentType(response.headers.get('content-type'), buffer),
    };
  } catch (error) {
    if (!CONNECT_ERRORS.has(error.code)) throw error;
    const { stdout } = await execFileAsync(
      'curl',
      ['-L', '--silent', '--show-error', '--max-time', String(Math.ceil(timeoutMs / 1000)), url],
      { timeout: timeoutMs + 1000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
    );
    return { buffer: stdout, contentType: detectImageType(stdout) };
  }
}

/**
 * Fetches album art from the URI WiiM reported, caches it on disk, and serves
 * stale cache copies if the remote host is unavailable.
 */
export function createArtService(db, dataDir, { fetcher = defaultFetch, maxAgeMs = MAX_AGE_MS } = {}) {
  const cacheDir = path.join(dataDir, 'art');
  fs.mkdirSync(cacheDir, { recursive: true });
  const pending = new Map();

  function pathsFor(uri) {
    const key = createHash('sha256').update(uri).digest('hex');
    return {
      key,
      image: path.join(cacheDir, `${key}.img`),
      type: path.join(cacheDir, `${key}.type`),
    };
  }

  function readCached(paths) {
    if (!fs.existsSync(paths.image)) return null;
    const buffer = fs.readFileSync(paths.image);
    const contentType = fs.existsSync(paths.type)
      ? safeContentType(fs.readFileSync(paths.type, 'utf8'), buffer)
      : detectImageType(buffer);
    return { buffer, contentType };
  }

  function writeCached(paths, buffer, contentType) {
    const temp = `${paths.image}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, paths.image);
    fs.writeFileSync(paths.type, contentType);
  }

  async function get(trackId) {
    const track = getTrack(db, trackId);
    if (!track?.art_uri) return null;
    const paths = pathsFor(track.art_uri);
    const cached = readCached(paths);
    if (cached && Date.now() - fs.statSync(paths.image).mtimeMs < maxAgeMs) {
      return { ...cached, cached: true };
    }

    let task = pending.get(paths.key);
    if (!task) {
      task = fetcher(track.art_uri, 6000)
        .then(({ buffer, contentType }) => {
          const type = safeContentType(contentType, buffer);
          writeCached(paths, buffer, type);
          return { buffer, contentType: type, cached: false };
        })
        .catch((error) => {
          if (cached) return { ...cached, cached: true, stale: true };
          throw error;
        })
        .finally(() => pending.delete(paths.key));
      pending.set(paths.key, task);
    }
    return task;
  }

  return { get, cacheDir };
}
