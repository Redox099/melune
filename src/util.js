import { createHash } from 'node:crypto';

export function nowMs() {
  return Date.now();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toInt(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * WiiM often returns metadata as UTF-8 hex (e.g. "4D6F726E696E67204C69676874").
 * Only decode when the hex round-trips cleanly, so ordinary text like "deadbeef"
 * is not mistaken for encoded data.
 */
export function decodeMaybeHex(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  if (trimmed.length < 2 || trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const decoded = Buffer.from(trimmed, 'hex').toString('utf8');
    if (!decoded || decoded.includes('\uFFFD')) return trimmed;
    if (Buffer.from(decoded, 'utf8').toString('hex').toLowerCase() !== trimmed.toLowerCase()) {
      return trimmed;
    }
    return decoded;
  } catch {
    return trimmed;
  }
}

const MISSING_VALUES = new Set(['', 'unknown', 'unknow', 'n/a', 'na', 'null', 'undefined', '-']);

export function cleanMeta(value) {
  const decoded = decodeMaybeHex(value);
  if (decoded === null || decoded === undefined) return null;
  const cleaned = String(decoded).replace(/\s+/g, ' ').trim();
  if (MISSING_VALUES.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function fingerprint(track = {}) {
  const artist = normalizeText(track.artist);
  const title = normalizeText(track.title);
  const album = normalizeText(track.album);
  const key = [artist, title, album].filter(Boolean).join('\u0000') || 'unknown-track';
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

export function deviceIdForHost(host) {
  return createHash('sha256').update(String(host).trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

export function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(n ?? 0);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
