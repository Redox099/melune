import { getDevices, getTrackMood, markDevicePolled, mergeDuplicatePlays, upsertDevice } from './db.js';
import { moodColor } from './mood.js';
import { fingerprint } from './util.js';
import { deviceInfoFromStatus, fetchObservation, getStatusEx } from './wiim.js';

export class Poller {
  constructor({ config, db, tracker }) {
    this.config = config;
    this.db = db;
    this.tracker = tracker;
    this.current = new Map();
    this.errors = new Map();
    this.running = false;
    this.stopping = false;
    this.timer = null;
    this.ticks = 0;
    this.inFlight = new Set();
  }

  track(task) {
    const promise = Promise.resolve(task);
    this.inFlight.add(promise);
    promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }

  start() {
    if (this.running) return;
    this.stopping = false;
    this.running = true;
    for (const device of this.config.devices) void this.track(this.refreshDeviceInfo(device));
    void this.track(this.loop());
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  async loop() {
    if (!this.running) return;
    try {
      await this.tick();
    } catch (error) {
      console.error('[poll] unexpected tick error:', error.message);
    }
    if (!this.stopping && this.running) {
      this.timer = setTimeout(() => void this.loop(), this.config.pollIntervalMs);
    }
  }

  hasDevice(device) {
    return this.config.devices.some((configured) => configured.id === device.id);
  }

  async refreshDeviceInfo(device) {
    try {
      const status = await getStatusEx(device.host, { timeoutMs: this.config.requestTimeoutMs });
      if (this.stopping || !this.hasDevice(device)) return;
      upsertDevice(this.db, device, deviceInfoFromStatus(status));
    } catch {
      // Device info is cosmetic; offline devices are reported by the normal poll.
    }
  }

  async pollDevice(device) {
    try {
      const observation = await fetchObservation(device, { timeoutMs: this.config.requestTimeoutMs });
      if (this.stopping || !this.hasDevice(device)) return;
      upsertDevice(this.db, device, {}, observation.at);
      markDevicePolled(this.db, device.id, observation.at, null);
      this.current.set(device.id, observation);
      this.errors.delete(device.id);
      this.tracker.observe(device.id, observation);
    } catch (error) {
      if (this.stopping || !this.hasDevice(device)) return;
      markDevicePolled(this.db, device.id, Date.now(), error.message);
      this.errors.set(device.id, error.message);
    }
  }

  async tick() {
    this.ticks += 1;
    for (const device of [...this.config.devices]) {
      if (!this.hasDevice(device)) continue;
      await this.pollDevice(device);
    }
    if (this.stopping) return;
    // The tracker merges most split plays live; this also catches brief
    // metadata glitches that briefly look like a new track.
    mergeDuplicatePlays(this.db);
  }

  addDevice(device) {
    if (this.config.devices.some((existing) => existing.host === device.host)) return false;
    this.config.devices.push(device);
    void this.track(this.refreshDeviceInfo(device));
    void this.track(this.pollDevice(device));
    return true;
  }

  removeDevice(host) {
    const index = this.config.devices.findIndex((device) => device.host === host);
    if (index < 0) return null;
    const [device] = this.config.devices.splice(index, 1);
    this.tracker.forget(device.id);
    this.current.delete(device.id);
    this.errors.delete(device.id);
    return device;
  }

  getCurrent(deviceId) {
    return this.current.get(deviceId) ?? null;
  }

  status() {
    const rows = new Map(getDevices(this.db).map((row) => [row.id, row]));
    return this.config.devices.map((device) => {
      const row = rows.get(device.id);
      const current = this.current.get(device.id) ?? null;
      const lastError = row?.last_error || this.errors.get(device.id) || null;
      const online = Boolean(
        row?.last_poll_at &&
        !lastError &&
        Date.now() - row.last_poll_at < Math.max(this.config.pollIntervalMs * 3, 15_000),
      );
      const trackId = current?.track?.title || current?.track?.artist || current?.track?.album
        ? fingerprint(current.track)
        : null;
      const mood = trackId ? getTrackMood(this.db, trackId) : null;
      const color = moodColor(mood);
      return {
        id: device.id,
        name: row?.name || device.name,
        host: device.host,
        online,
        lastPollAt: row?.last_poll_at ?? null,
        lastError,
        current: current
          ? {
              status: current.status,
              source: current.source,
              track: current.track,
              trackId,
              mood,
              color,
              hasArt: Boolean(current.track?.artUri),
              positionMs: current.positionMs,
              durationMs: current.durationMs,
              seenAt: current.at,
            }
          : null,
      };
    });
  }
}
