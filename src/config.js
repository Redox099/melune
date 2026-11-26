import fs from 'node:fs';
import path from 'node:path';
import { deviceIdForHost } from './util.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  dataDir: './data',
  pollIntervalMs: 5000,
  requestTimeoutMs: 2500,
  minPlayMs: 30_000,
  // WiiM devices usually use self-signed certificates. Keep verification off
  // by default, but allow a CA file / strict mode for hardened networks.
  tlsRejectUnauthorized: false,
  tlsCaFile: null,
  devices: [],
};

const examplePath = () => path.resolve(process.cwd(), 'config.example.json');

export function defaultConfigPath() {
  return process.env.MELUNE_CONFIG || path.resolve(process.cwd(), 'config.json');
}

export function loadConfig({ configPath = defaultConfigPath(), createIfMissing = true } = {}) {
  let raw = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (createIfMissing && fs.existsSync(examplePath())) {
    fs.copyFileSync(examplePath(), configPath);
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`[config] Created ${configPath} from config.example.json — edit your device IP there.`);
  } else if (createIfMissing) {
    console.warn('[config] No config.json found; starting with no devices configured.');
  }

  const config = {
    ...DEFAULTS,
    ...raw,
  };

  config.port = Number(process.env.MELUNE_PORT || config.port);
  if (process.env.MELUNE_TLS_REJECT_UNAUTHORIZED !== undefined) {
    config.tlsRejectUnauthorized = /^(1|true|yes|on)$/i.test(process.env.MELUNE_TLS_REJECT_UNAUTHORIZED);
  }
  if (process.env.MELUNE_TLS_CA_FILE) config.tlsCaFile = process.env.MELUNE_TLS_CA_FILE;
  config.tlsRejectUnauthorized = Boolean(config.tlsRejectUnauthorized);
  config.tlsCaFile = config.tlsCaFile ? String(config.tlsCaFile) : null;

  config.dataDir = path.resolve(process.cwd(), config.dataDir);
  config.devices = (config.devices ?? [])
    .filter((device) => device && device.host)
    .map((device) => ({
      id: device.id || deviceIdForHost(device.host),
      name: device.name || device.host,
      host: String(device.host).replace(/^https?:\/\//, '').replace(/\/$/, ''),
    }));

  config.pollIntervalMs = Math.max(1000, Number(config.pollIntervalMs) || 5000);
  config.requestTimeoutMs = Math.max(500, Number(config.requestTimeoutMs) || 2500);
  const minPlay = Number(config.minPlayMs ?? DEFAULTS.minPlayMs);
  config.minPlayMs = Number.isFinite(minPlay) ? Math.max(0, minPlay) : DEFAULTS.minPlayMs;
  return config;
}

export function saveConfig(config, configPath = defaultConfigPath()) {
  const safe = {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    pollIntervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    minPlayMs: config.minPlayMs,
    tlsRejectUnauthorized: config.tlsRejectUnauthorized,
    tlsCaFile: config.tlsCaFile,
    devices: (config.devices ?? []).map(({ name, host }) => ({ name, host })),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(safe, null, 2)}\n`);
}
