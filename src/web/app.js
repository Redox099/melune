const state = { range: 'week', device: '', moods: {} };
const $ = (selector) => document.querySelector(selector);

// Refresh polls often, but most of that data is unchanged. Remember what was
// last painted so unchanged sections are left completely untouched — replacing
// innerHTML recreates every cover <img> and makes the page visibly flicker.
const painted = new Map();
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

function moodColor(mood) {
  return state.moods?.[mood]?.color ?? '#6cc8ff';
}

function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

function cover(trackId, hasArt, modifier = '') {
  const extra = modifier ? ` ${modifier}` : '';
  const image = trackId && hasArt
    ? `<img src="/api/art/${encodeURIComponent(trackId)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`
    : '';
  return `<span class="cover${extra}" aria-hidden="true"><span class="cover-mark">♪</span>${image}</span>`;
}

async function api(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} from ${path}`);
  return response.json();
}

function renderHealth(health) {
  const dot = $('#health-dot');
  const running = Boolean(health?.poller?.running);
  dot.className = `health-dot ${running ? 'online' : 'offline'}`;
  $('#health-text').textContent = running
    ? `${health.devices} device${health.devices === 1 ? '' : 's'} · polling every ${(health.poller.pollIntervalMs / 1000).toFixed(0)}s`
    : 'Poller stopped';
  const enrichment = health?.enrichment;
  if (enrichment) {
    const sources = Object.entries(enrichment.configured ?? {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    $('#footer-status').textContent = sources.length
      ? `mood tags: ${sources.join(' + ')} · ${enrichment.enriched} enriched`
      : 'mood tags: not configured';
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
  renderNow(devices);
}

function nowCard(device) {
  const current = device.current;
  const playing = current && ['play', 'loading'].includes(current.status);
  const status = playing ? 'playing' : device.online ? (current?.status || 'online') : 'offline';
  const title = current?.track?.title || (device.online ? 'Nothing reported' : 'Device offline');
  const artist = current?.track?.artist || (device.online ? `Source: ${current?.source ?? 'unknown'}` : (device.lastError || 'waiting for poll'));
  const progress = progressFor(current);
  const mood = current?.mood ?? null;
  const barColor = playing && mood ? `background:${esc(moodColor(mood))};` : '';
  return { playing, status, title, artist, progress, mood,
    html: `<article class="now-card ${playing ? 'playing' : ''}">
      <div class="now-top">
        <span class="device-name">${esc(device.name)}</span>
        <span class="state-pill ${playing ? 'playing' : ''}">${esc(status)}</span>
      </div>
      <div class="now-main">
        ${cover(current?.trackId, current?.hasArt, 'cover-lg')}
        <div class="now-copy">
          <div class="now-title" title="${esc(title)}">${esc(title)}</div>
          <div class="now-artist" title="${esc(artist)}">${esc(artist)}</div>
        </div>
      </div>
      <div class="progress"><span style="width:${progress.toFixed(1)}%;${barColor}"></span></div>
    </article>` };
}

function progressFor(current) {
  const position = Number(current?.positionMs) || 0;
  const length = Number(current?.durationMs) || 0;
  return length > 0 ? Math.min(100, (position / length) * 100) : 0;
}

function renderNow(devices) {
  const grid = $('#now-grid');
  if (!devices.length) {
    paint('now-empty', true, () => {
      grid.innerHTML = empty('No devices configured. Add one in config.json to start recording.');
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
    // The mutable part of a card is just the progress width. Everything else
    // (especially covers) is kept alive unless the underlying info changed.
    const signature = JSON.stringify({
      name: device.name, playing: view.playing, status: view.status,
      title: view.title, artist: view.artist, trackId: device.current?.trackId,
      mood: view.mood, hasArt: device.current?.hasArt, online: device.online,
      source: device.current?.source, lastError: device.lastError,
    });
    let card = cards.get(device.id);
    if (!card || card.dataset.signature !== signature) {
      const template = document.createElement('template');
      template.innerHTML = view.html;
      const fresh = template.content.firstElementChild;
      fresh.dataset.deviceId = device.id;
      fresh.dataset.signature = signature;
      if (card) grid.replaceChild(fresh, card);
      else grid.appendChild(fresh);
      card = fresh;
    }
    const bar = card.querySelector('.progress span');
    const width = `${view.progress.toFixed(1)}%`;
    if (bar.style.width !== width) bar.style.width = width;
    const targetIndex = [...grid.children].indexOf(card);
    if (targetIndex !== index) grid.insertBefore(card, grid.children[index] || null);
  });
  for (const [id, card] of cards) {
    if (!devices.some((device) => device.id === id)) card.remove();
  }
}

function renderKpis(data) {
  const totals = data.totals ?? {};
  $('#kpi-plays').textContent = number(totals.plays);
  $('#kpi-tracks').textContent = number(totals.uniqueTracks);
  $('#kpi-time').textContent = duration(totals.playedMs);
  $('#kpi-days').textContent = `${number(totals.activeDays)} active day${totals.activeDays === 1 ? '' : 's'}`;

  const ranked = (data.moods ?? [])
    .filter((row) => row.mood && row.mood !== 'unknown')
    .sort((a, b) => b.plays - a.plays);
  const top = ranked[0];
  const total = ranked.reduce((sum, row) => sum + row.plays, 0);
  $('#kpi-mood').textContent = top ? moodLabel(top.mood) : '—';
  $('#kpi-mood-sub').textContent = top
    ? `${top.plays} plays · ${Math.round((top.plays / total) * 100)}% of tagged plays`
    : 'add metadata keys to enable moods';
}

function renderTracks(tracks) {
  const target = $('#top-tracks');
  $('#tracks-hint').textContent = `${number(tracks.length)} tracks`;
  if (!tracks.length) {
    target.innerHTML = empty('No plays yet. Start playing music on a WiiM device.');
    return;
  }
  const max = Math.max(1, ...tracks.map((track) => track.plays));
  target.innerHTML = tracks.map((track, index) => {
    const width = Math.max(3, (track.plays / max) * 100);
    const subtitle = track.artist || 'Unknown artist';
    return `<li class="rank-item">
      <span class="rank">${index + 1}</span>
      ${cover(track.id, track.hasArt, 'cover-rank')}
      <div class="rank-main">
        <div class="rank-title" title="${esc(track.title)}">${esc(track.title || 'Unknown track')}</div>
        <div class="rank-sub">${esc(subtitle)}</div>
      </div>
      <div class="bar"><span style="width:${width.toFixed(1)}%"></span></div>
      <div class="rank-value"><strong>${number(track.plays)}</strong><span>plays</span></div>
    </li>`;
  }).join('');
}

function renderMoods(moods) {
  const target = $('#moods');
  const known = (moods ?? [])
    .filter((row) => row.mood && row.mood !== 'unknown')
    .sort((a, b) => b.plays - a.plays);
  if (!known.length) {
    target.innerHTML = empty('No mood tags yet. Add a Last.fm API key to config.json.');
    return;
  }
  const total = known.reduce((sum, row) => sum + row.plays, 0);
  const max = Math.max(1, ...known.map((row) => row.plays));
  target.innerHTML = known.map((row) => {
    const percent = total ? (row.plays / total) * 100 : 0;
    const width = Math.max(3, (row.plays / max) * 100);
    return `<div class="mood-row">
      <span class="mood-name"><i class="mood-dot" style="background:${esc(moodColor(row.mood))}"></i>${esc(moodLabel(row.mood))}</span>
      <span class="bar"><span style="width:${width.toFixed(1)}%;background:${esc(moodColor(row.mood))}"></span></span>
      <span class="mood-value">${Math.round(percent)}%</span>
    </div>`;
  }).join('');
}

function renderArtists(artists) {
  const target = $('#artists');
  if (!artists?.length) {
    target.innerHTML = empty('No artists yet.');
    return;
  }
  target.innerHTML = artists.map((artist) => `<div class="artist">
    <strong title="${esc(artist.artist)}">${esc(artist.artist)}</strong>
    <span>${number(artist.plays)} plays · ${number(artist.tracks)} tracks</span>
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
    return `<div class="timeline-bar" title="${esc(item.day)}: ${item.plays} plays">
      <i style="height:${height.toFixed(1)}%"></i>
      <span>${esc(String(item.day).slice(5))}</span>
    </div>`;
  }).join('');
}

function renderPlays(plays) {
  const target = $('#recent-plays');
  $('#plays-hint').textContent = `${number(plays.length)} most recent`;
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
        <td class="muted">${esc(relative(play.started_at))}</td>
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
    paint('kpis', [data.totals, data.moods], () => renderKpis(data));
    // playedMs grows every poll but is not shown in these sections — using it
    // in the signature would rebuild covers constantly.
    paint('tracks', (data.topTracks ?? []).map((t) => [t.id, t.title, t.artist, t.mood, t.plays, t.hasArt]),
      () => renderTracks(data.topTracks ?? []));
    paint('moods', (data.moods ?? []).map((m) => [m.mood, m.plays]),
      () => renderMoods(data.moods ?? []));
    paint('artists', data.topArtists, () => renderArtists(data.topArtists ?? []));
    paint('timeline', data.timeline, () => renderTimeline(data.timeline ?? []));
  }
  if (plays.status === 'fulfilled') renderPlays(plays.value.plays ?? []);
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
  setInterval(() => void refresh(), 15_000);
}

void init();
