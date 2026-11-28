const state = { range: 'today', device: '', moods: {} };
const MOOD_FALLBACK = '#6b7280';
const ARTIST_LIMIT = 7;
const DISCOVERY_COOLDOWN_MS = 10_000;
let lastDiscoveryAt = 0;
let configuredHosts = new Set();
let configuredDevices = [];
let discoveredDevices = [];
const $ = (selector) => document.querySelector(selector);

// Refresh polls often, but most of that data is unchanged. Remember what was
// last painted so unchanged sections are left completely untouched — replacing
// innerHTML recreates every cover <img> and makes the page visibly flicker.
const painted = new Map();
const lastTrackIds = new Map();
const moodTokens = new Map();
const MOOD_VARS = ['--mood-color', '--mood-soft'];
function paint(key, value, draw) {
  const signature = JSON.stringify(value);
  if (painted.get(key) === signature) return false;
  painted.set(key, signature);
  draw(value);
  return true;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function number(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

function duration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${total}s`;
}

function relative(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function moodLabel(mood) {
  return state.moods?.[mood]?.label ?? (mood && mood !== 'unknown' ? String(mood) : 'Unknown');
}

function moodColor(mood, fallback) {
  return state.moods?.[mood]?.color ?? fallback ?? MOOD_FALLBACK;
}

function colorRgba(color, alpha) {
  const hex = String(color ?? MOOD_FALLBACK).replace('#', '');
  const safe = /^[\da-f]{6}$/i.test(hex) ? hex : MOOD_FALLBACK.slice(1);
  const r = parseInt(safe.slice(0, 2), 16);
  const g = parseInt(safe.slice(2, 4), 16);
  const b = parseInt(safe.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

function coverMarkup(src, modifier = '') {
  const extra = modifier ? ` ${modifier}` : '';
  const image = src
    ? `<img src="${src}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`
    : '';
  return `<span class="cover${extra}" aria-hidden="true"><span class="cover-mark"></span>${image}</span>`;
}

function cover(trackId, hasArt, modifier = '') {
  const src = trackId && hasArt ? `/api/art/${encodeURIComponent(trackId)}` : '';
  return coverMarkup(src, modifier);
}

function artistCover(artist) {
  return coverMarkup(`/api/artist-art/${encodeURIComponent(artist || '')}`, 'cover-artist');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    let message = `${response.status} from ${path}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  return response.json();
}

function renderHealth(health) {
  const running = Boolean(health?.poller?.running);
  const dot = $('#health-dot');
  if (dot) dot.className = `health-dot ${running ? 'online' : 'offline'}`;
  const devices = $('#health-devices');
  const poll = $('#health-poll');
  if (devices) {
    devices.textContent = running
      ? `${health.devices} device${health.devices === 1 ? '' : 's'}`
      : 'Poller stopped';
  }
  if (poll) {
    poll.textContent = running
      ? `polling every ${(health.poller.pollIntervalMs / 1000).toFixed(0)}s`
      : '';
  }
}

function renderDevices(devices) {
  const select = $('#device-select');
  paint('device-options', devices.map((device) => [device.id, device.name]), () => {
    select.innerHTML = `<option value="">All devices</option>${devices
      .map((device) => `<option value="${esc(device.id)}">${esc(device.name)}</option>`)
      .join('')}`;
    if ([...select.options].some((option) => option.value === state.device)) {
      select.value = state.device;
    } else {
      state.device = '';
      select.value = '';
    }
  });
  configuredHosts = new Set(devices.map((device) => device.host));
  configuredDevices = devices;
  renderNow(devices);
}

function moodVars(mood, colorByMood, fallbackColor) {
  if (!colorByMood) return {};
  const color = moodColor(mood, fallbackColor);
  if (!color) return {};
  return {
    '--mood-color': color,
    '--mood-soft': colorRgba(color, 0.1),
  };
}

function applyMoodVars(card, mood, colorByMood, fallbackColor) {
  const vars = moodVars(mood, colorByMood, fallbackColor);
  for (const name of MOOD_VARS) {
    if (vars[name]) card.style.setProperty(name, vars[name]);
    else card.style.removeProperty(name);
  }
}

function nowCard(device) {
  const current = device.current;
  const playing = current && ['play', 'loading'].includes(current.status);
  const status = playing ? 'playing' : device.online ? (current?.status || 'online') : 'offline';
  const title = current?.track?.title || (device.online ? 'Nothing reported' : 'Device offline');
  const artist = current?.track?.artist || (device.online ? `Source: ${current?.source ?? 'unknown'}` : (device.lastError || 'waiting for poll'));
  const progress = progressFor(current);
  const showProgress = playing || current?.status === 'pause';
  const mood = current?.mood ?? null;
  const fallbackColor = current?.color ?? null;
  const moodVar = Object.entries(moodVars(mood, playing, fallbackColor))
    .map(([name, value]) => `${name}:${esc(value)};`)
    .join('');
  return { playing, status, title, artist, progress, showProgress, mood, fallbackColor,
    html: `<article class="now-card ${playing ? 'playing' : ''}" style="${moodVar}">
      <div class="now-main">
        ${cover(current?.trackId, current?.hasArt, 'cover-lg')}
        <div class="now-copy">
          <div class="now-top">
            <span class="device-label">
              <span class="device-name">${esc(device.name)}</span>
              <span class="level-meter" aria-hidden="true"><i></i><i></i><i></i></span>
            </span>
            <span class="state-pill">${esc(status)}</span>
          </div>
          <div class="now-title" title="${esc(title)}">${esc(title)}</div>
          <div class="now-artist" title="${esc(artist)}">${esc(artist)}</div>
          <div class="progress"><span ${showProgress ? '' : 'hidden'} style="width:${progress.toFixed(1)}%"></span></div>
        </div>
      </div>
    </article>` };
}

function progressFor(current) {
  const position = Number(current?.positionMs) || 0;
  const length = Number(current?.durationMs) || 0;
  return length > 0 ? Math.min(100, (position / length) * 100) : 0;
}

// Independent small jumps read as a level meter rather than a repeating wave.
function animateLevelMeters() {
  if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const meter of document.querySelectorAll('.now-card.playing .level-meter')) {
    for (const bar of meter.children) {
      bar.style.height = `${Math.round(35 + Math.random() * 55)}%`;
    }
  }
}

function renderNow(devices) {
  const grid = $('#now-grid');
  if (!devices.length) {
    paint('now-empty', true, () => {
      grid.innerHTML = empty('No devices configured. Use Devices to add one.');
    });
    return;
  }
  painted.delete('now-empty');
  for (const stale of [...grid.children]) {
    if (!stale.classList.contains('now-card')) stale.remove();
  }
  const cards = new Map([...grid.querySelectorAll('.now-card')].map((el) => [el.dataset.deviceId, el]));
  devices.forEach((device, index) => {
    const view = nowCard(device);
    const trackId = device.current?.trackId ?? '';
    const trackChanged = lastTrackIds.has(device.id) && lastTrackIds.get(device.id) !== trackId;
    lastTrackIds.set(device.id, trackId);
    // The mutable part of a card is just the progress width. Everything else
    // (especially covers) is kept alive unless the underlying info changed.
    // Playing state, status pill and mood are patched in place so their colors
    // can transition instead of the whole card being rebuilt.
    const signature = JSON.stringify({
      name: device.name, title: view.title, artist: view.artist,
      trackId: device.current?.trackId, hasArt: device.current?.hasArt,
      online: device.online, source: device.current?.source,
      lastError: device.lastError,
    });
    let card = cards.get(device.id);
    let rebuilt = false;
    if (!card || card.dataset.signature !== signature) {
      const template = document.createElement('template');
      template.innerHTML = view.html;
      const fresh = template.content.firstElementChild;
      fresh.dataset.deviceId = device.id;
      fresh.dataset.signature = signature;
      if (card) {
        // A track change rebuilds the card. Carry the old mood colors into the
        // new element so the next paint can fade them to the new mood.
        for (const name of MOOD_VARS) {
          const previous = card.style.getPropertyValue(name);
          if (previous) fresh.style.setProperty(name, previous);
        }
        grid.replaceChild(fresh, card);
        rebuilt = true;
      } else grid.appendChild(fresh);
      card = fresh;
    }
    card.classList.toggle('playing', view.playing);
    const pill = card.querySelector('.state-pill');
    if (pill.textContent !== view.status) pill.textContent = view.status;
    const token = (moodTokens.get(device.id) ?? 0) + 1;
    moodTokens.set(device.id, token);
    if (rebuilt) {
      // Commit the carried-over colors first, then switch to the new mood so
      // the transition animates instead of snapping on a rebuilt card.
      void card.offsetWidth;
      requestAnimationFrame(() => {
        if (moodTokens.get(device.id) === token && card.isConnected) {
          applyMoodVars(card, view.mood, view.playing, view.fallbackColor);
        }
      });
    } else {
      applyMoodVars(card, view.mood, view.playing, view.fallbackColor);
    }
    const progressEl = card.querySelector('.progress');
    const bar = progressEl.querySelector('span');
    bar.hidden = !view.showProgress;
    const width = trackChanged ? '0%' : `${view.progress.toFixed(1)}%`;
    if (trackChanged) {
      // Snap to zero on a new track instead of animating from the old one.
      bar.style.transition = 'none';
      bar.style.width = '0%';
      void bar.offsetWidth;
      bar.style.transition = '';
    } else if (bar.style.width !== width) {
      bar.style.width = width;
    }
    const targetIndex = [...grid.children].indexOf(card);
    if (targetIndex !== index) grid.insertBefore(card, grid.children[index] || null);
  });
  for (const [id, card] of cards) {
    if (!devices.some((device) => device.id === id)) {
      card.remove();
      lastTrackIds.delete(id);
      moodTokens.delete(id);
    }
  }
}

function renderKpis(data) {
  const totals = data.totals ?? {};
  $('#kpi-plays').textContent = number(totals.plays);
  $('#kpi-tracks').textContent = number(totals.uniqueTracks);
  $('#kpi-time').textContent = duration(totals.playedMs);
  $('#kpi-days').textContent = `${number(totals.activeDays)} active day${totals.activeDays === 1 ? '' : 's'}`;
}

function renderTracks(tracks) {
  const target = $('#top-tracks');
  if (!tracks.length) {
    target.innerHTML = empty('No plays yet. Start playing music on a WiiM device.');
    return;
  }
  target.innerHTML = tracks.map((track) => {
    const subtitle = track.artist || 'Unknown artist';
    return `<li class="rank-item">
      ${cover(track.id, track.hasArt, 'cover-rank')}
      <div class="rank-main">
        <div class="rank-title" title="${esc(track.title)}">${esc(track.title || 'Unknown track')}</div>
        <div class="rank-sub">${esc(subtitle)}</div>
      </div>
      <div class="rank-value"><strong>${number(track.plays)}</strong></div>
    </li>`;
  }).join('');
}

function renderMoods(moods) {
  const target = $('#moods');
  const known = (moods ?? [])
    .filter((row) => row.mood && row.mood !== 'unknown')
    .sort((a, b) => b.plays - a.plays);
  if (!known.length) {
    target.innerHTML = empty('Moods appear once tracks are tagged');
    return;
  }
  const total = known.reduce((sum, row) => sum + row.plays, 0);
  const max = Math.max(1, ...known.map((row) => row.plays));
  target.innerHTML = known.map((row) => {
    const percent = total ? (row.plays / total) * 100 : 0;
    const width = Math.max(3, (row.plays / max) * 100);
    return `<div class="mood-row" data-mood="${esc(row.mood)}">
      <span class="mood-name">${esc(moodLabel(row.mood))}</span>
      <span class="bar"><span style="width:${width.toFixed(1)}%;background:${esc(moodColor(row.mood))}"></span></span>
      <span class="mood-value">${Math.round(percent)}%</span>
    </div>`;
  }).join('');
}

function renderArtists(artists) {
  const target = $('#artists');
  const items = (artists ?? []).slice(0, ARTIST_LIMIT);
  if (!items.length) {
    target.innerHTML = empty('No artists yet.');
    return;
  }
  target.innerHTML = items.map((artist) => `<div class="artist">
    ${artistCover(artist.artist)}
    <div class="artist-copy">
      <strong title="${esc(artist.artist)}">${esc(artist.artist)}</strong>
      <span>${number(artist.plays)} plays · ${number(artist.tracks)} tracks</span>
    </div>
  </div>`).join('');
}

function renderTimeline(timeline) {
  const target = $('#timeline');
  const items = (timeline ?? []).slice(-21);
  if (!items.length) {
    target.innerHTML = empty('No activity yet.');
    return;
  }
  const max = Math.max(1, ...items.map((item) => item.plays));
  target.innerHTML = items.map((item) => {
    const height = Math.max(5, (item.plays / max) * 100);
    const mood = item.mood && item.mood !== 'unknown' ? item.mood : null;
    const color = mood ? (item.color ?? moodColor(mood)) : 'var(--accent)';
    const mix = (item.moodMix ?? []).filter((entry) => entry.mood && entry.mood !== 'unknown' && Number(entry.plays) > 0);
    const taggedPlays = mix.reduce((sum, entry) => sum + Number(entry.plays), 0);
    const segments = mix.length
      ? mix.map((entry) => {
          const share = (Number(entry.plays) / taggedPlays) * 100;
          const segmentColor = entry.color ?? moodColor(entry.mood, color);
          return `<span style="height:${share.toFixed(2)}%;background:${esc(segmentColor)}" aria-hidden="true"></span>`;
        }).join('')
      : `<span style="height:100%;background:${esc(color)}" aria-hidden="true"></span>`;
    const mixLabel = mix.map((entry) => `${moodLabel(entry.mood)} ${entry.plays}`).join(' · ');
    const label = mixLabel ? ` · ${esc(mixLabel)}` : '';
    return `<div class="timeline-bar" title="${esc(item.day)}: ${item.plays} plays${label}">
      <b class="timeline-count">${number(item.plays)}</b>
      <i class="activity-fill" style="height:${height.toFixed(1)}%">${segments}</i>
      <span class="timeline-date">${esc(String(item.day).slice(5))}</span>
    </div>`;
  }).join('');
}

function renderPlays(plays) {
  const target = $('#recent-plays');
  if (!plays.length) {
    paint('plays-empty', true, () => {
      target.innerHTML = `<tr><td colspan="5">${empty('No plays in this period.')}</td></tr>`;
    });
    return;
  }
  painted.delete('plays-empty');
  for (const stale of [...target.children]) {
    if (!stale.dataset.playId) stale.remove();
  }
  const rows = new Map([...target.querySelectorAll('tr[data-play-id]')]
    .map((el) => [el.dataset.playId, el]));
  plays.forEach((play, index) => {
    // Duration is the only volatile field; everything else keeps the row alive.
    const signature = JSON.stringify({
      started_at: play.started_at, track_id: play.track_id, title: play.title,
      artist: play.artist, hasArt: play.hasArt, device_name: play.device_name,
      source: play.source,
    });
    let row = rows.get(String(play.id));
    if (!row || row.dataset.signature !== signature) {
      const template = document.createElement('template');
      template.innerHTML = `<tr>
        <td class="muted when">${esc(relative(play.started_at))}</td>
        <td class="track-cell">
          <span class="track-cell-main">
            ${cover(play.track_id, play.hasArt, 'cover-row')}
            <span class="track-cell-copy">${esc(play.title || 'Unknown track')}<small>${esc(play.artist || 'Unknown artist')}</small></span>
          </span>
        </td>
        <td class="muted">${esc(play.device_name)}</td>
        <td><span class="source-tag">${esc(play.source || 'unknown')}</span></td>
        <td class="muted duration"></td>
      </tr>`;
      const fresh = template.content.firstElementChild;
      fresh.dataset.playId = String(play.id);
      fresh.dataset.signature = signature;
      if (row) target.replaceChild(fresh, row);
      else target.appendChild(fresh);
      row = fresh;
    }
    const cell = row.querySelector('.duration');
    const text = duration(play.played_ms);
    if (cell.textContent !== text) cell.textContent = text;
    const when = row.querySelector('.when');
    const whenText = relative(play.started_at);
    if (when.textContent !== whenText) when.textContent = whenText;
    const targetIndex = [...target.children].indexOf(row);
    if (targetIndex !== index) target.insertBefore(row, target.children[index] || null);
  });
  for (const [id, row] of rows) {
    if (!plays.some((play) => String(play.id) === id)) row.remove();
  }
}

async function refresh() {
  const query = `range=${encodeURIComponent(state.range)}&device=${encodeURIComponent(state.device)}`;
  const [health, devices, stats, plays] = await Promise.allSettled([
    api('/api/health'),
    api('/api/devices'),
    api(`/api/stats?${query}`),
    api(`/api/plays?${query}&limit=30`),
  ]);
  if (health.status === 'fulfilled') renderHealth(health.value);
  if (devices.status === 'fulfilled') renderDevices(devices.value.devices ?? []);
  if (stats.status === 'fulfilled') {
    const data = stats.value;
    paint('kpis', [data.totals], () => renderKpis(data));
    // playedMs grows every poll but is not shown in these sections — using it
    // in the signature would rebuild covers constantly.
    paint('tracks', (data.topTracks ?? []).map((t) => [t.id, t.title, t.artist, t.mood, t.plays, t.hasArt]),
      () => renderTracks(data.topTracks ?? []));
    paint('moods', (data.moods ?? []).map((m) => [m.mood, m.plays]),
      () => renderMoods(data.moods ?? []));
    const topArtists = (data.topArtists ?? []).slice(0, ARTIST_LIMIT);
    paint('artists', topArtists, () => renderArtists(topArtists));
    paint('timeline', data.timeline ?? [], () => renderTimeline(data.timeline ?? []));
  }
  if (plays.status === 'fulfilled') renderPlays(plays.value.plays ?? []);
}

function discoveryStatus(message) {
  $('#discover-status').textContent = message;
}

function renderDiscovery(discovered = discoveredDevices) {
  discoveredDevices = discovered;
  const target = $('#discover-results');
  const byHost = new Map();
  for (const device of configuredDevices) {
    byHost.set(device.host, { ...device, configured: true });
  }
  for (const device of discovered) {
    const existing = byHost.get(device.host);
    byHost.set(device.host, {
      ...existing,
      ...device,
      name: device.name || existing?.name || device.host,
      configured: configuredHosts.has(device.host) || Boolean(existing?.configured),
    });
  }
  const rows = [...byHost.values()].sort((a, b) =>
    Number(b.configured) - Number(a.configured)
    || a.host.localeCompare(b.host, undefined, { numeric: true }));
  if (!rows.length) {
    target.innerHTML = '<div class="discover-empty">No WiiM devices found. Press Scan to look for them.</div>';
    return;
  }
  target.innerHTML = rows.map((device) => {
    const { host, configured } = device;
    const name = device.name || host;
    const detail = device.model ? `${host} · ${device.model}` : host;
    const action = configured
      ? `<button type="button" class="discover-remove" data-host="${esc(host)}" data-name="${esc(name)}">Remove</button>`
      : `<button type="button" class="discover-add" data-host="${esc(host)}" data-name="${esc(name)}">Add</button>`;
    return `<div class="discover-row">
      <div class="discover-copy"><strong>${esc(name)}</strong><span>${esc(detail)}</span></div>
      ${action}
    </div>`;
  }).join('');
}

async function openDiscovery() {
  const dialog = $('#discover-dialog');
  if (!dialog.open) dialog.showModal();
  renderDiscovery();
  discoveryStatus('Press Scan to look for WiiM devices on your network.');
  try {
    const result = await api('/api/devices');
    configuredHosts = new Set((result.devices ?? []).map((device) => device.host));
    configuredDevices = result.devices ?? [];
    renderDiscovery();
  } catch {
    // Keep whatever rows are already visible.
  }
}

async function runDiscovery() {
  const scan = $('#discover-scan');
  const dialog = $('#discover-dialog');
  if (!dialog.open) dialog.showModal();
  if (Date.now() - lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) {
    discoveryStatus('Please wait a few seconds before scanning again.');
    return;
  }
  lastDiscoveryAt = Date.now();
  $('#scan-spinner').hidden = false;
  if (configuredDevices.length) {
    renderDiscovery();
    discoveryStatus('Devices already added are shown below. Scanning for more…');
  } else {
    discoveryStatus('Scanning the local network… this can take a few seconds.');
  }
  scan.disabled = true;
  scan.textContent = 'Scanning…';
  try {
    const result = await api('/api/discover');
    configuredHosts = new Set(result.configured ?? [...configuredHosts]);
    const devices = result.devices ?? [];
    renderDiscovery(devices);
    const scanDetail = result.total ? ` (scanned ${result.scanned}/${result.total} hosts)` : '';
    discoveryStatus(`Found ${devices.length} device${devices.length === 1 ? '' : 's'}${scanDetail}. Add the ones you want to track.`);
  } catch (error) {
    discoveryStatus(`Discovery failed: ${error.message}`);
  } finally {
    $('#scan-spinner').hidden = true;
    scan.disabled = false;
    scan.textContent = 'Scan';
  }
}

async function addDiscoveredDevice(button) {
  const { host, name } = button.dataset;
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const result = await api('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ host, name }),
    });
    configuredHosts.add(host);
    configuredDevices = [...configuredDevices, { host, name: result.device?.name || name }];
    renderDiscovery();
    discoveryStatus(`${name || host} is now being tracked.`);
    await refresh();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Add';
    discoveryStatus(`Could not add ${host}: ${error.message}`);
  }
}

async function removeDevice(host, name) {
  try {
    await api('/api/devices', {
      method: 'DELETE',
      body: JSON.stringify({ host }),
    });
    configuredHosts.delete(host);
    configuredDevices = configuredDevices.filter((device) => device.host !== host);
    renderDiscovery();
    discoveryStatus(`${name || host} removed. Past listening history is kept.`);
    await refresh();
  } catch (error) {
    discoveryStatus(`Could not remove ${host}: ${error.message}`);
  }
}

function bind() {
  $('#range-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    state.range = button.dataset.range;
    for (const item of document.querySelectorAll('#range-tabs button')) {
      item.classList.toggle('active', item === button);
    }
    void refresh();
  });
  $('#device-select').addEventListener('change', (event) => {
    state.device = event.target.value;
    void refresh();
  });
  $('#discover-button').addEventListener('click', () => void openDiscovery());
  $('#discover-scan').addEventListener('click', () => void runDiscovery());
  $('#discover-results').addEventListener('click', (event) => {
    const add = event.target.closest('.discover-add');
    if (add && !add.disabled) {
      void addDiscoveredDevice(add);
      return;
    }
    const remove = event.target.closest('.discover-remove');
    if (remove) void removeDevice(remove.dataset.host, remove.dataset.name);
  });
  $('#delete-data').addEventListener('click', () => {
    $('#delete-dialog').showModal();
    $('#delete-status').textContent = '';
    $('#delete-confirm').disabled = false;
  });
  $('#delete-confirm').addEventListener('click', () => void deleteAllData());
}

async function waitForRestart(previous) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await api('/api/health');
      if (previous?.pid && previous?.startedAt
        && (health.pid !== previous.pid || health.startedAt !== previous.startedAt)) return true;
    } catch {
      // The old server is closing; wait for the new one.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function deleteAllData() {
  const button = $('#delete-confirm');
  const status = $('#delete-status');
  button.disabled = true;
  status.textContent = 'Deleting data and restarting…';
  try {
    const before = await api('/api/health');
    await api('/api/data', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'DELETE ALL DATA' }),
    });
    status.textContent = 'Done. Reloading…';
    if (!await waitForRestart(before)) {
      status.textContent = 'Data deleted. Refresh the page when the server is back.';
      button.disabled = false;
    }
  } catch (error) {
    status.textContent = `Could not delete data: ${error.message}`;
    button.disabled = false;
  }
}

async function init() {
  try {
    const meta = await api('/api/meta');
    state.moods = meta.moods ?? {};
  } catch {
    // UI still works with fallback mood labels.
  }
  bind();
  await refresh();
  animateLevelMeters();
  setInterval(animateLevelMeters, 220);
  setInterval(() => void refresh(), 15_000);
}

void init();
