import { endPlay, getOpenPlay, getOrCreateTrack, reopenPlay, startPlay, updatePlayTick } from './db.js';
import { fingerprint, nowMs } from './util.js';

const ACTIVE_STATES = new Set(['play', 'loading']);
const STOPPED_STATES = new Set(['stop', 'none', '']);
const RESTART_THRESHOLD_MS = 10_000;

function hasMetadata(track) {
  return Boolean(track?.title || track?.artist || track?.album);
}

/**
 * Turns a stream of WiiM status polls into discrete play events.
 * A new play starts on a metadata change, a source change, a position rewind,
 * or a long polling gap. Brief stop/start transitions on the same track are
 * merged back into the same play so one song is not counted twice.
 */
export class PlayTracker {
  constructor(db, { pollIntervalMs = 5000, onPlayStarted = () => {} } = {}) {
    this.db = db;
    this.onPlayStarted = onPlayStarted;
    this.maxTickMs = Math.max(pollIntervalMs * 2, 15_000);
    this.gapThresholdMs = Math.max(pollIntervalMs * 4, 60_000);
    this.resumeGapMs = Math.max(pollIntervalMs * 3, 15_000);
    this.states = new Map();
    this.startedCount = 0;
  }

  canResume(state, stateKey, source, positionMs, at) {
    const last = state.lastPlay;
    if (!last || last.key !== stateKey || last.source !== source) return false;
    if (at - (last.lastSeenAt ?? 0) > this.resumeGapMs) return false;
    if (
      positionMs !== null &&
      last.lastPosition !== null &&
      positionMs < last.lastPosition - RESTART_THRESHOLD_MS
    ) {
      return false;
    }
    return true;
  }

  attachOpenPlay(state, deviceId, track, stateKey, source, persistedTrackId, at) {
    if (state.resumeChecked || !persistedTrackId) return;
    state.resumeChecked = true;
    const open = getOpenPlay(this.db, deviceId);
    if (!open || open.track_id !== persistedTrackId) return;
    if ((open.source ?? 'unknown') !== source) return;
    state.playId = open.id;
    state.key = stateKey;
    state.source = source;
    state.trackId = open.track_id;
    state.lastPosition = open.position_end_ms ?? open.position_start_ms ?? null;
    state.lastTick = at;
    state.lastPlay = null;
  }

  observe(deviceId, observation = {}) {
    const at = observation.at ?? nowMs();
    const track = observation.track ?? {};
    const source = observation.source ?? 'unknown';
    const positionMs = Number.isFinite(observation.positionMs) ? observation.positionMs : null;
    const active = ACTIVE_STATES.has(observation.status);
    const stopped = STOPPED_STATES.has(observation.status);
    const state = { ...(this.states.get(deviceId) ?? {}) };
    const trackId = fingerprint(track);
    const stateKey = hasMetadata(track) ? trackId : `${trackId}:${source}`;
    // Persist metadata even when the player is stopped/paused so the UI can show
    // artwork for the track the device is still reporting.
    const persistedTrackId = hasMetadata(track) ? getOrCreateTrack(this.db, track) : null;

    let reason = null;
    if (active) {
      this.attachOpenPlay(state, deviceId, track, stateKey, source, persistedTrackId, at);
      if (!state.playId && this.canResume(state, stateKey, source, positionMs, at)) {
        const last = state.lastPlay;
        if (reopenPlay(this.db, last.playId)) {
          state.playId = last.playId;
          state.key = stateKey;
          state.source = source;
          state.trackId = last.trackId ?? persistedTrackId;
          state.lastPosition = last.lastPosition;
          state.lastTick = at;
          state.lastPlay = null;
        }
      }

      if (!state.playId) reason = 'no-open-play';
      else if (state.key !== stateKey) reason = 'track-changed';
      else if (state.source !== source) reason = 'source-changed';
      else if (
        state.lastPosition !== null &&
        positionMs !== null &&
        positionMs < state.lastPosition - RESTART_THRESHOLD_MS
      ) {
        reason = 'position-rewound';
      } else if (state.lastSeenAt && at - state.lastSeenAt > this.gapThresholdMs) {
        reason = 'poll-gap';
      }
    } else if (stopped && state.playId) {
      reason = 'stopped';
    }

    if (reason) {
      // On a track/source change the reported position belongs to the NEW
      // track, so keep the last position observed for the play being closed.
      const endedPosition =
        reason === 'stopped' ? positionMs ?? state.lastPosition : state.lastPosition;
      if (state.playId) {
        endPlay(this.db, state.playId, at, endedPosition);
        state.lastPlay = {
          playId: state.playId,
          key: state.key,
          source: state.source,
          trackId: state.trackId,
          lastPosition: endedPosition,
          lastSeenAt: at,
        };
      }
      state.playId = null;
      state.key = null;
      state.source = null;
      state.lastTick = null;

      if (active) {
        const playId = startPlay(this.db, {
          deviceId,
          trackId: persistedTrackId,
          startedAt: at,
          source,
          positionStartMs: positionMs,
        });
        state.playId = playId;
        state.key = stateKey;
        state.trackId = persistedTrackId;
        state.source = source;
        state.lastTick = at;
        state.lastPlay = null;
        state.resumeChecked = true;
        this.startedCount += 1;
        this.onPlayStarted({ playId, trackId: persistedTrackId, deviceId, track, source, startedAt: at, reason });
      }
    } else if (active && state.playId) {
      if (state.lastTick) {
        const delta = Math.min(at - state.lastTick, this.maxTickMs);
        updatePlayTick(this.db, state.playId, delta, positionMs);
      }
      // After a pause or a merged stop, the first playing poll re-establishes the clock.
      state.lastTick = at;
    }

    if (!active && state.playId) {
      state.lastTick = null;
    }

    state.lastPosition = positionMs;
    state.lastSeenAt = at;
    if (active) {
      state.track = track;
      state.status = observation.status;
    } else {
      state.status = observation.status;
    }
    this.states.set(deviceId, state);
    return { reason, playId: state.playId ?? null, status: observation.status };
  }

  getState(deviceId) {
    const state = this.states.get(deviceId) ?? {};
    return {
      playId: state.playId ?? null,
      status: state.status ?? null,
      track: state.track ?? null,
      reason: state.key ? 'playing' : 'idle',
      openPlays: getOpenPlay(this.db, deviceId)?.id ?? null,
      startedCount: state.startedCount ?? this.startedCount,
    };
  }
}
