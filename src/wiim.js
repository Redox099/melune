import { execFile } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';
import { cleanMeta, toInt } from './util.js';

const execFileAsync = promisify(execFile);
const CONNECT_ERRORS = new Set([
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'ENETRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

function nativeHttpsText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, timeout: timeoutMs, headers: { Connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`WiiM HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on('timeout', () => {
      const error = new Error('WiiM request timed out');
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    req.on('error', reject);
  });
}

/**
 * Some hardened local runtimes allow system curl to reach LAN hosts while
 * blocking direct sockets from the Node process. Curl is only used as a
 * fallback for connection-level failures.
 */
async function curlText(url, timeoutMs) {
  const { stdout } = await execFileAsync(
    'curl',
    [
      '--insecure',
      '--silent',
      '--show-error',
      '--max-time',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      url.toString(),
    ],
    { timeout: timeoutMs + 1000, maxBuffer: 2 * 1024 * 1024 },
  );
  return stdout;
}

async function httpsText(url, { timeoutMs = 2500 } = {}) {
  try {
    return await nativeHttpsText(url, timeoutMs);
  } catch (error) {
    if (!CONNECT_ERRORS.has(error.code)) throw error;
    try {
      return await curlText(url, timeoutMs);
    } catch (curlError) {
      if (curlError.code === 'ENOENT') throw error;
      throw curlError;
    }
  }
}

function parseWiiM(text) {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[{[]/);
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // fall through
      }
    }
    return trimmed;
  }
}

export async function callDevice(host, command, { timeoutMs = 2500 } = {}) {
  const url = new URL(`https://${host}/httpapi.asp`);
  url.searchParams.set('command', command);
  return parseWiiM(await httpsText(url, { timeoutMs }));
}

export async function getStatusEx(host, options) {
  return callDevice(host, 'getStatusEx', options);
}

export async function getPlayerStatus(host, options) {
  return callDevice(host, 'getPlayerStatus', options);
}

export async function getMetaInfo(host, options) {
  return callDevice(host, 'getMetaInfo', options);
}

const SOURCES = new Map([
  [1, 'airplay'],
  [2, 'dlna'],
  [31, 'spotify'],
  [32, 'tidal'],
  [40, 'aux-in'],
  [41, 'bluetooth'],
  [42, 'storage'],
  [43, 'optical'],
  [50, 'mirror'],
  [99, 'slave'],
]);

export function sourceName(mode) {
  const value = toInt(mode, -1);
  if (value === 0) return 'none';
  if (SOURCES.has(value)) return SOURCES.get(value);
  if (value >= 10 && value <= 19) return 'wiim';
  if (value >= 20 && value <= 29) return 'http';
  if (value >= 30 && value <= 39) return 'streaming';
  return `mode-${value}`;
}

export function deviceInfoFromStatus(status = {}) {
  if (typeof status !== 'object') return {};
  return {
    name: cleanMeta(status.DeviceName) || cleanMeta(status.ssid) || null,
    model: cleanMeta(status.project) || null,
    firmware: cleanMeta(status.firmware) || null,
    uuid: cleanMeta(status.uuid) || null,
  };
}

export function normalizeObservation(player = {}, meta = {}, at = Date.now()) {
  const p = typeof player === 'object' && player !== null ? player : {};
  const m = typeof meta === 'object' && meta !== null ? meta : {};
  const metaData = typeof m.metaData === 'object' && m.metaData !== null ? m.metaData : {};
  const track = {
    title: cleanMeta(metaData.title) || cleanMeta(p.Title),
    artist: cleanMeta(metaData.artist) || cleanMeta(p.Artist),
    album: cleanMeta(metaData.album) || cleanMeta(p.Album),
    artUri: cleanMeta(metaData.albumArtURI) || null,
  };
  return {
    at,
    status: String(p.status ?? '').trim().toLowerCase(),
    source: sourceName(p.mode),
    positionMs: toInt(p.curpos ?? p.offset_pts),
    durationMs: toInt(p.totlen),
    plicurr: toInt(p.plicurr),
    plicount: toInt(p.plicount),
    track,
    sampleRate: metaData.sampleRate ?? null,
    bitDepth: metaData.bitDepth ?? null,
  };
}

export async function fetchObservation(device, { timeoutMs = 2500 } = {}) {
  const [playerResult, metaResult] = await Promise.allSettled([
    getPlayerStatus(device.host, { timeoutMs }),
    getMetaInfo(device.host, { timeoutMs }),
  ]);
  if (playerResult.status === 'rejected') throw playerResult.reason;
  const meta = metaResult.status === 'fulfilled' ? metaResult.value : {};
  return normalizeObservation(playerResult.value, meta, Date.now());
}
