import { execFile } from 'node:child_process';
import fs from 'node:fs';
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

let tlsOptions = { rejectUnauthorized: false, caFile: null };
let caCache = { path: null, data: undefined };

/** WiiM devices commonly use self-signed certs; strict mode is opt-in. */
export function configureWiimTls(config = {}) {
  tlsOptions = {
    rejectUnauthorized: config.tlsRejectUnauthorized === undefined
      ? tlsOptions.rejectUnauthorized
      : Boolean(config.tlsRejectUnauthorized),
    caFile: config.tlsCaFile ? String(config.tlsCaFile) : null,
  };
  caCache = { path: null, data: undefined };
}

export function wiimTlsOptions() {
  return { ...tlsOptions };
}

function caContents() {
  if (!tlsOptions.caFile) return undefined;
  if (caCache.path === tlsOptions.caFile) return caCache.data;
  const data = fs.readFileSync(tlsOptions.caFile);
  caCache = { path: tlsOptions.caFile, data };
  return data;
}

function nativeHttpsText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        rejectUnauthorized: tlsOptions.rejectUnauthorized,
        ca: caContents(),
        timeout: timeoutMs,
        headers: { Connection: 'close' },
      },
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
  const args = [];
  if (!tlsOptions.rejectUnauthorized) args.push('--insecure');
  if (tlsOptions.caFile) args.push('--cacert', tlsOptions.caFile);
  args.push(
    '--silent',
    '--show-error',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    url.toString(),
  );
  const { stdout } = await execFileAsync(
    'curl',
    args,
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

async function callDevice(host, command, { timeoutMs = 2500 } = {}) {
  const url = new URL(`https://${host}/httpapi.asp`);
  url.searchParams.set('command', command);
  return parseWiiM(await httpsText(url, { timeoutMs }));
}

export async function getStatusEx(host, options) {
  return callDevice(host, 'getStatusEx', options);
}

async function getPlayerStatus(host, options) {
  return callDevice(host, 'getPlayerStatus', options);
}

async function getMetaInfo(host, options) {
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

// Physical inputs are identified by mode even when the device reports a vendor.
const PHYSICAL_MODES = new Set([1, 2, 40, 41, 42, 43, 50, 99]);
const RADIO_VENDORS = new Set(['vtuner', 'v-tuner', 'radio', 'internet-radio', 'iheartradio', 'tunein']);

function sourceFromVendor(vendor) {
  const name = cleanMeta(vendor);
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return null;
  return RADIO_VENDORS.has(slug) ? 'radio' : slug;
}

export function sourceName(mode, vendor) {
  const value = toInt(mode, -1);
  const fromVendor = sourceFromVendor(vendor);
  if (fromVendor && !PHYSICAL_MODES.has(value)) return fromVendor;
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
    source: sourceName(p.mode, p.vendor),
    positionMs: toInt(p.curpos ?? p.offset_pts),
    durationMs: toInt(p.totlen),
    track,
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
