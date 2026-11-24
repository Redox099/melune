import dgram from 'node:dgram';
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

async function validate(ip, timeoutMs) {
  try {
    const status = await getStatusEx(ip, { timeoutMs });
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
    if (!status.ssid && !status.uuid && !status.firmware && !status.project) return null;
    return { host: ip, ...deviceInfoFromStatus(status) };
  } catch {
    return null;
  }
}

export function discoverWiimDevices(timeoutMs = 5000) {
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
          // Multicast may be blocked; validation below still handles any replies.
        }
      };
      send();
      const interval = setInterval(send, 1000);
      setTimeout(async () => {
        clearInterval(interval);
        try {
          socket.close();
        } catch {
          // already closed
        }
        const config = loadConfig({ createIfMissing: false });
        const found = await Promise.all(
          [...addresses].map((address) => validate(address, config.requestTimeoutMs)),
        );
        resolve(found.filter(Boolean));
      }, timeoutMs);
    });
  });
}

async function main() {
  console.log('Searching for WiiM devices on the local network...');
  const devices = await discoverWiimDevices();
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
