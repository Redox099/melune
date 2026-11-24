import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { deviceInfoFromStatus, getStatusEx } from './wiim.js';

const SEARCH = Buffer.from(
  [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 2',
    'ST: upnp:rootdevice',
    '',
    '',
  ].join('\r\n'),
);

const PRIVATE_V4 = [
  /^10\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function intToIp(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

/** Parse `192.168.2.0/24`, `192.168.2`, or a host IP as its /24 subnet. */
export function parseSubnet(value) {
  let text = String(value ?? '').trim();
  if (/^\d+\.\d+\.\d+$/.test(text)) text += '.0/24';
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) text += '/24';

  const [address, prefix = '24'] = text.split('/');
  const ip = ipToInt(address);
  if (ip === null || Number(prefix) !== 24) return null;
  const base = (ip & 0xffffff00) >>> 0;
  return { base: intToIp(base), baseInt: base, prefix: 24 };
}

/** Return the usable host addresses of a /24 subnet. */
export function hostsFor(subnet) {
  const parsed = parseSubnet(subnet);
  if (!parsed) throw new Error(`Unsupported subnet: ${subnet}`);
  return Array.from({ length: 254 }, (_, index) => intToIp(parsed.baseInt + index + 1));
}

/** Detect private /24 networks on the local machine. */
export function localSubnets() {
  const found = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!PRIVATE_V4.some((pattern) => pattern.test(address.address))) continue;
      const parsed = parseSubnet(address.address);
      if (parsed) found.add(`${parsed.base}/24`);
    }
  }
  return [...found];
}

async function mapWithConcurrency(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function validate(host, timeoutMs) {
  try {
    const status = await getStatusEx(host, { timeoutMs });
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
    if (!status.ssid && !status.uuid && !status.firmware && !status.project) return null;
    return { host, ...deviceInfoFromStatus(status) };
  } catch {
    return null;
  }
}

function ssdpSearch(timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const addresses = new Set();
    socket.on('message', (_message, info) => {
      if (info?.address) addresses.add(info.address);
    });
    socket.on('error', () => {});
    socket.bind(0, () => {
      const send = () => {
        try {
          socket.send(SEARCH, 1900, '239.255.255.250');
        } catch {
          // Multicast may be blocked; the subnet scan below still runs.
        }
      };
      send();
      const interval = setInterval(send, 1000);
      setTimeout(() => {
        clearInterval(interval);
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve([...addresses]);
      }, timeoutMs);
    });
  });
}

function cliSubnets() {
  const args = process.argv.slice(2);
  if (args.includes('--no-scan')) return [];
  const explicit = args.find((arg) => !arg.startsWith('--'))
    || process.env.MELUNE_DISCOVER_SUBNET;
  if (explicit) return [explicit];
  return localSubnets();
}

/**
 * Find WiiM devices with SSDP first, then by probing the local subnet(s) with
 * getStatusEx. Multicast is often blocked on home and container networks, so
 * the scan fallback is what makes discovery reliable here.
 */
export async function discoverWiimDevices(options = {}) {
  const opts = typeof options === 'number' ? { timeoutMs: options } : options;
  const config = loadConfig({ createIfMissing: false });
  const timeoutMs = opts.timeoutMs ?? 3000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? Math.min(1000, config.requestTimeoutMs);
  const concurrency = opts.concurrency ?? 16;
  const subnets = opts.subnets ?? cliSubnets();
  const check = (host) => validate(host, requestTimeoutMs);

  const ssdpHosts = await ssdpSearch(timeoutMs);
  const ssdpDevices = (await Promise.all(ssdpHosts.map(check))).filter(Boolean);
  opts.onProgress?.({ method: 'ssdp', found: ssdpDevices.length });

  const hosts = [...new Set(subnets.flatMap((subnet) => hostsFor(subnet)))];
  let scanned = 0;
  const scannedDevices = await mapWithConcurrency(hosts, async (host) => {
    const device = await check(host);
    scanned += 1;
    opts.onProgress?.({ method: 'scan', scanned, total: hosts.length, found: Boolean(device) });
    return device;
  }, concurrency);

  const byHost = new Map();
  for (const device of [...ssdpDevices, ...scannedDevices.filter(Boolean)]) {
    byHost.set(device.host, device);
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

async function main() {
  const args = process.argv.slice(2);
  const explicit = args.find((arg) => !arg.startsWith('--'));
  const subnets = explicit ? [explicit] : undefined;
  console.log('Searching for WiiM devices on the local network...');

  let lastPercent = -1;
  const devices = await discoverWiimDevices({
    subnets,
    onProgress: (event) => {
      if (event.method !== 'scan' || !event.total) return;
      const percent = Math.floor((event.scanned / event.total) * 100);
      if (percent < lastPercent + 20 && percent !== 100) return;
      lastPercent = percent;
      console.log(`  scanned ${event.scanned}/${event.total} hosts`);
    },
  });

  if (devices.length === 0) {
    console.log('No devices found. You can set the IP manually in config.json.');
    return;
  }
  console.log('Found:');
  for (const device of devices) {
    console.log(`  ${device.host}  ${device.name ?? 'WiiM'}  ${device.model ?? ''}`.trimEnd());
  }
  console.log('\nAdd entries like this to config.json:');
  console.log(JSON.stringify(devices.map(({ host, name }) => ({ name: name || host, host })), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
