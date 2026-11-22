'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

let groups = [];
let selected = localStorage.getItem('sonos.group');
let favorites = null;
let queue = null;          // { group, items, total }
let alarms = null;
let eqRoom = null;
let sseOk = false;
let prog = { pos: 0, dur: 0, at: 0, playing: false };
let sleepInfo = { sec: 0, at: 0 };
const dragging = new Set(); // sliders die de gebruiker vasthoudt
const pending = new Map();  // optimistische waarden: key -> { value, until }

// ------------------------------------------------------------------ API
async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch('/api/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// Acties: de server stuurt na afloop zelf de nieuwe status via de live-verbinding.
async function act(path, body = {}) {
  try {
    await api(path, body);
  } catch (e) {
    toast(e.message);
  }
  if (!sseOk) setTimeout(poll, 350);
}

function applyState(s) {
  groups = s.groups;
  setStatus(null);
  render();
}

// Terugval als de live-verbinding wegvalt
async function poll() {
  try {
    applyState(await api('state'));
  } catch (e) {
    setStatus('Geen verbinding: ' + e.message);
  }
}
setInterval(() => { if (!sseOk && !document.hidden) poll(); }, 2000);

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', e => { sseOk = true; applyState(JSON.parse(e.data)); });
  es.addEventListener('failure', e => setStatus('Sonos niet bereikbaar: ' + JSON.parse(e.data).error));
  es.addEventListener('queue', e => { const d = JSON.parse(e.data); if (!d.group || d.group === selected) loadQueue(); });
  es.addEventListener('alarms', () => loadAlarms());
  es.addEventListener('favorites', () => loadFavorites());
  es.onopen = () => { sseOk = true; };
  es.onerror = () => { sseOk = false; };
}

async function loadFavorites() {
  try {
    favorites = await api('favorites');
  } catch (e) {
    favorites = [];
    toast('Favorieten laden mislukt: ' + e.message);
  }
  renderFavorites();
}

async function loadQueue() {
  const id = selected;
  if (!id) return;
  try {
    const q = await api(`group/${enc(id)}/queue`);
    if (id !== selected) return;
    queue = { group: id, ...q };
  } catch (e) {
    queue = { group: id, items: [], total: 0, error: e.message };
  }
  renderQueue();
}

async function loadAlarms() {
  try {
    alarms = await api('alarms');
  } catch (e) {
    alarms = { error: e.message };
  }
  renderAlarms();
}

async function loadEq() {
  const g = currentGroup();
  if (!g) return;
  if (!g.members.some(m => m.uuid === eqRoom)) eqRoom = g.members[0].uuid;
  const room = eqRoom;
  try {
    const eq = await api(`player/${enc(room)}/eq`);
    if (room === eqRoom) renderEq(eq);
  } catch (e) {
    $('#eq').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

// ------------------------------------------------------------------ Helpers
const fmt = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const isPlaying = g => g && (g.state === 'PLAYING' || g.state === 'TRANSITIONING');

function override(key, value, ms = 2500) { pending.set(key, { value, until: Date.now() + ms }); }
function current(key, value) {
  const p = pending.get(key);
  if (p && p.until > Date.now()) return p.value;
  pending.delete(key);
  return value;
}

function select(id) {
  if (!id) return;
  const changed = id !== selected;
  selected = id;
  localStorage.setItem('sonos.group', id);
  api('selected', { id }).catch(() => { });
  if (changed) {
    membersSig = '';
    queue = null;
    renderQueue();
    loadQueue();
    loadEq();
  }
}

function currentGroup() {
  let g = groups.find(x => x.id === selected);
  if (!g && selected) g = groups.find(x => x.members.some(m => m.uuid === selected)); // speaker zit nu in andere groep
  if (!g) g = groups.find(isPlaying) || groups[0];
  if (g && g.id !== selected) select(g.id);
  return g;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
function setStatus(msg) {
  const s = $('#status');
  s.hidden = !msg;
  s.textContent = msg || '';
}

function fillOf(el, v) {
  const min = +el.min || 0, max = +el.max || 100;
  return ((v - min) / (max - min || 1)) * 100 + '%';
}
function setSlider(el, value, key) {
  if (dragging.has(el)) return;
  const v = key ? current(key, value) : value;
  if (+el.value !== v) el.value = v;
  el.style.setProperty('--fill', fillOf(el, v));
}

// ------------------------------------------------------------------ Render
function sourceIcon(g) {
  return g.source === 'radio' ? ICON.radio : g.source === 'tv' ? ICON.tv : ICON.note;
}

function renderRooms() {
  $('#rooms').innerHTML = groups.map(g => {
    const playing = isPlaying(g);
    const sub = g.error ? 'Niet bereikbaar'
      : g.empty ? 'Niets in de wachtrij'
      : [g.track.title, g.track.artist].filter(Boolean).join(' · ');
    return `<div class="room ${g.id === selected ? 'active' : ''}" data-group="${esc(g.id)}" role="button" tabindex="0">
      <div class="room-art">${g.track && g.track.art ? `<img src="${esc(g.track.art)}" alt="" loading="lazy">` : sourceIcon(g)}</div>
      <div class="room-text">
        <div class="room-name">${playing ? '<span class="eq-anim"><i></i><i></i><i></i></span>' : ''}${esc(g.name)}</div>
        <div class="room-sub">${esc(sub)}</div>
      </div>
      <button class="icon-btn small" data-quick="${esc(g.id)}" aria-label="${playing ? 'Pauzeren' : 'Afspelen'}">${playing ? (g.source === 'radio' || g.source === 'tv' ? ICON.stop : ICON.pause) : ICON.play}</button>
    </div>`;
  }).join('');
}

let membersSig = '';
function renderPlayer(g) {
  $('#empty').hidden = true;
  $('#player').hidden = false;
  $('#group-name').innerHTML = `${sourceIcon(g)}<span>${esc(g.name)}</span>`;

  if (g.error) {
    $('#title').textContent = 'Niet bereikbaar';
    $('#artist').textContent = g.error;
    $('#album').textContent = '';
  } else {
    $('#title').textContent = g.empty ? 'Niets aan het afspelen' : (g.track.title || 'Onbekend');
    $('#artist').textContent = g.track.artist || '';
    $('#album').textContent = g.track.album || '';
  }
  document.title = g.track && g.track.title ? `${g.track.title} — Sonos` : 'Sonos Control';

  const art = $('#art');
  const src = g.track && g.track.art;
  if (src) {
    if (art.getAttribute('src') !== src) art.src = src;
    art.hidden = false;
  } else {
    art.removeAttribute('src');
    art.hidden = true;
  }
  $('#art-ph').innerHTML = sourceIcon(g);

  const playing = current('play:' + g.id, isPlaying(g));
  const pp = $('#playpause');
  pp.innerHTML = playing ? (g.source === 'radio' || g.source === 'tv' ? ICON.stop : ICON.pause) : ICON.play;
  pp.setAttribute('aria-label', playing ? 'Pauzeren' : 'Afspelen');

  const isQueue = g.source === 'music' && !g.empty;
  $('#prev').disabled = !isQueue;
  $('#next').disabled = !isQueue;
  $('#shuffle').disabled = !isQueue;
  $('#repeat').disabled = !isQueue;
  const shuffle = current('shuffle:' + g.id, g.shuffle);
  const repeat = current('repeat:' + g.id, g.repeat);
  $('#shuffle').classList.toggle('on', !!shuffle);
  $('#repeat').classList.toggle('on', repeat !== 'none');
  $('#repeat').innerHTML = repeat === 'one' ? ICON.repeatOne : ICON.repeat;

  // slaaptimer
  sleepInfo = { sec: current('sleep:' + g.id, g.sleep || 0), at: Date.now() };

  // voortgang
  const dur = g.track ? g.track.duration : 0;
  $('#progress-wrap').classList.toggle('live', !dur);
  prog = { pos: g.track ? g.track.position : 0, dur, at: Date.now(), playing: isPlaying(g) };
  tick();

  // groepsvolume
  setSlider($('#volume'), g.volume ?? 0, 'gvol:' + g.id);
  $('#volume-val').textContent = current('gvol:' + g.id, g.volume ?? 0);
  const muted = current('gmute:' + g.id, g.mute);
  $('#mute').innerHTML = muted ? ICON.muted : ICON.vol;
  $('#mute').classList.toggle('on', !!muted);

  renderMembers(g);
  renderGrouping(g);
  renderQueueHighlight(g);
  renderEqRooms(g);
}

function renderMembers(g) {
  const card = $('#members-card');
  const wrap = $('#members');
  card.hidden = g.members.length < 2;
  const sig = g.id + '|' + g.members.map(m => m.uuid).join(',');
  if (sig !== membersSig) {
    membersSig = sig;
    wrap.innerHTML = g.members.map(m => `
      <div class="member" data-player="${esc(m.uuid)}">
        <span class="member-name">${esc(m.name)}</span>
        <div class="volume">
          <button class="icon-btn small" data-pmute="${esc(m.uuid)}" aria-label="Dempen ${esc(m.name)}"></button>
          <input type="range" min="0" max="100" data-pvol="${esc(m.uuid)}" aria-label="Volume ${esc(m.name)}">
          <span class="vol-val"></span>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('[data-pvol]').forEach(el => bindSlider(el, v => {
      override('pvol:' + el.dataset.pvol, v);
      act(`player/${enc(el.dataset.pvol)}/volume`, { volume: v });
    }));
  }
  for (const m of g.members) {
    const row = wrap.querySelector(`[data-player="${CSS.escape(m.uuid)}"]`);
    if (!row) continue;
    setSlider(row.querySelector('input'), m.volume, 'pvol:' + m.uuid);
    row.querySelector('.vol-val').textContent = current('pvol:' + m.uuid, m.volume);
    const mu = current('pmute:' + m.uuid, m.mute);
    const btn = row.querySelector('[data-pmute]');
    btn.innerHTML = mu ? ICON.muted : ICON.vol;
    btn.classList.toggle('on', !!mu);
    btn.dataset.muted = mu ? '1' : '';
  }
}

function renderGrouping(g) {
  const all = groups.flatMap(x => x.members.map(m => ({ ...m, groupId: x.id })))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#grouping-card').hidden = all.length < 2;
  if (all.length < 2) return;
  $('#grouping').innerHTML = all.map(p => {
    const inGroup = p.groupId === g.id;
    const isCoord = p.uuid === g.coordinator;
    return `<button class="chip ${inGroup ? 'on' : ''}" data-member="${esc(p.uuid)}" data-in="${inGroup ? 1 : ''}" ${isCoord && g.members.length > 1 ? 'title="Hoofdspeaker van deze groep"' : ''}>
      <span class="check">${inGroup ? '✓' : '+'}</span>${esc(p.name)}</button>`;
  }).join('');
}

function renderFavorites() {
  const el = $('#favorites');
  if (favorites === null) { el.innerHTML = '<p class="muted">Laden…</p>'; return; }
  if (!favorites.length) { el.innerHTML = '<p class="muted">Geen Sonos-favorieten gevonden. Voeg ze toe in de Sonos-app.</p>'; return; }
  el.innerHTML = favorites.map(f => `
    <button class="fav" data-fav="${esc(f.id)}" title="Afspelen: ${esc(f.title)}">
      <div class="fav-art">${f.art ? `<img src="${esc(f.art)}" alt="" loading="lazy">` : ICON.note}</div>
      <div class="fav-title">${esc(f.title)}</div>
      <div class="fav-desc">${esc(f.description)}</div>
    </button>`).join('');
}

// --- wachtrij
function renderQueue() {
  const el = $('#queue');
  if (!queue || queue.group !== selected) { el.innerHTML = '<p class="muted">Laden…</p>'; $('#queue-count').textContent = ''; return; }
  if (queue.error) { el.innerHTML = `<p class="muted">${esc(queue.error)}</p>`; return; }
  $('#queue-count').textContent = queue.total ? `${queue.total} ${queue.total === 1 ? 'nummer' : 'nummers'}` : '';
  $('#queue-clear').hidden = !queue.total;
  if (!queue.items.length) {
    el.innerHTML = '<p class="muted">De wachtrij is leeg. Start een playlist of album via je favorieten.</p>';
    return;
  }
  el.innerHTML = queue.items.map(t => `
    <div class="q-row" data-n="${t.n}" role="button" tabindex="0" title="Afspelen">
      <span class="q-n">${t.n}</span>
      <div class="q-art">${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : ICON.note}</div>
      <div class="q-text"><div class="q-title">${esc(t.title)}</div><div class="q-sub">${esc([t.artist, t.album].filter(Boolean).join(' · '))}</div></div>
      <button class="icon-btn small q-del" data-del="${t.n}" title="Uit wachtrij verwijderen" aria-label="Verwijderen">${ICON.trash}</button>
    </div>`).join('') + (queue.total > queue.items.length ? `<p class="muted">… en nog ${queue.total - queue.items.length} nummers</p>` : '');
  renderQueueHighlight(currentGroup());
}

function renderQueueHighlight(g) {
  const n = g && g.queueActive ? g.track.number : -1;
  document.querySelectorAll('.q-row').forEach(r => {
    const on = +r.dataset.n === n;
    r.classList.toggle('current', on);
    r.querySelector('.q-n').innerHTML = on && isPlaying(g) ? '<span class="eq-anim"><i></i><i></i><i></i></span>' : r.dataset.n;
  });
}

// --- klank
function renderEqRooms(g) {
  const sel = $('#eq-room');
  sel.hidden = g.members.length < 2;
  const sig = g.members.map(m => m.uuid).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = g.members.map(m => `<option value="${esc(m.uuid)}">${esc(m.name)}</option>`).join('');
  }
  if (eqRoom && g.members.some(m => m.uuid === eqRoom)) sel.value = eqRoom;
}

function renderEq(eq) {
  const toggle = (key, label, hint, on) => `
    <label class="switch-row compact"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <input type="checkbox" class="switch" data-eq="${key}" ${on ? 'checked' : ''}></label>`;
  $('#eq').innerHTML = `
    <div class="eq-row"><span>Lage tonen</span><input type="range" min="-10" max="10" step="1" data-eq="bass" aria-label="Lage tonen"><span class="vol-val"></span></div>
    <div class="eq-row"><span>Hoge tonen</span><input type="range" min="-10" max="10" step="1" data-eq="treble" aria-label="Hoge tonen"><span class="vol-val"></span></div>
    ${toggle('loudness', 'Loudness', 'Meer laag en hoog bij zacht volume', eq.loudness)}
    ${eq.nightMode !== null ? toggle('nightMode', 'Nachtmodus', 'Harde geluiden zachter', eq.nightMode) : ''}
    ${eq.speech !== null ? toggle('speech', 'Spraakverbetering', 'Dialogen beter verstaanbaar', eq.speech) : ''}
    <button class="link-btn eq-reset" type="button">Lage en hoge tonen op 0 zetten</button>`;
  for (const k of ['bass', 'treble']) {
    const el = $(`#eq input[data-eq="${k}"]`);
    el.value = eq[k];
    el.style.setProperty('--fill', fillOf(el, eq[k]));
    el.nextElementSibling.textContent = fmtEq(eq[k]);
    bindSlider(el, v => act(`player/${enc(eqRoom)}/eq`, { [k]: v }), fmtEq);
  }
}
const fmtEq = v => (v > 0 ? '+' : '') + v;

// --- wekkers
function renderAlarms() {
  const el = $('#alarms');
  if (alarms === null) { el.innerHTML = '<p class="muted">Laden…</p>'; return; }
  if (alarms.error) { el.innerHTML = `<p class="muted">${esc(alarms.error)}</p>`; return; }
  if (!alarms.length) { el.innerHTML = '<p class="muted">Geen wekkers. Je maakt ze aan in de Sonos-app.</p>'; return; }
  el.innerHTML = alarms.map(a => `
    <label class="alarm ${a.enabled ? '' : 'off'}">
      <div class="alarm-time">${esc(a.time)}</div>
      <div class="alarm-text">
        <div>${esc(a.days)} · ${esc(a.room)}</div>
        <div class="muted">${esc(a.source)} · volume ${a.volume}</div>
      </div>
      <input type="checkbox" class="switch" data-alarm="${esc(a.id)}" ${a.enabled ? 'checked' : ''} aria-label="Wekker ${esc(a.time)} aan/uit">
    </label>`).join('');
}

function render() {
  if (!groups.length) {
    $('#rooms').innerHTML = '';
    $('#player').hidden = true;
    $('#empty').hidden = false;
    $('#empty').textContent = 'Geen Sonos-speakers gevonden. Controleer of deze pc op hetzelfde netwerk zit.';
    return;
  }
  const g = currentGroup();
  renderRooms();
  renderPlayer(g);
}

function tick() {
  const el = $('#progress');
  const pos = Math.min(prog.dur || Infinity, prog.pos + (prog.playing ? (Date.now() - prog.at) / 1000 : 0));
  $('#pos').textContent = fmt(pos);
  $('#dur').textContent = prog.dur ? fmt(prog.dur) : 'Live';
  el.max = prog.dur || 1;
  el.disabled = !prog.dur;
  if (!dragging.has(el)) {
    el.value = prog.dur ? pos : 0;
    el.style.setProperty('--fill', (prog.dur ? (pos / prog.dur) * 100 : 0) + '%');
  }
  // slaaptimer aftellen
  const left = Math.max(0, sleepInfo.sec - (Date.now() - sleepInfo.at) / 1000);
  const badge = $('#sleep-badge');
  badge.hidden = !left;
  badge.textContent = left >= 3600 ? `${Math.floor(left / 3600)}u${String(Math.ceil((left % 3600) / 60)).padStart(2, '0')}` : `${Math.ceil(left / 60)}m`;
  $('#sleep').classList.toggle('on', !!left);
  $('#sleep').title = left ? `Slaaptimer: stopt over ${fmt(left)}` : 'Slaaptimer';
  $('#sleep-off').hidden = !left;
}
setInterval(tick, 500);

// ------------------------------------------------------------------ Slider-gedrag
// Tijdens slepen live versturen, maar maximaal ~6x per seconde.
function bindSlider(el, onValue, label = v => v) {
  let timer = null, last = null;
  const flush = () => { timer = null; if (last !== null) { onValue(last); last = null; } };
  const start = () => dragging.add(el);
  const end = () => setTimeout(() => dragging.delete(el), 300);
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('input', () => {
    el.style.setProperty('--fill', fillOf(el, +el.value));
    last = +el.value;
    if (el.nextElementSibling && el.nextElementSibling.classList.contains('vol-val')) el.nextElementSibling.textContent = label(+el.value);
    if (!timer) timer = setTimeout(flush, 160);
  });
  el.addEventListener('change', () => { clearTimeout(timer); timer = null; last = +el.value; flush(); end(); });
}

// ------------------------------------------------------------------ Events
function togglePlay(g) {
  const playing = isPlaying(g);
  override('play:' + g.id, !playing, 2000);
  if (g.id === selected) renderPlayer(g);
  act(`group/${enc(g.id)}/${playing ? 'pause' : 'play'}`);
}

$('#rooms').addEventListener('click', e => {
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const g = groups.find(x => x.id === quick.dataset.quick);
    if (g) togglePlay(g);
    return;
  }
  const room = e.target.closest('[data-group]');
  if (room) { select(room.dataset.group); render(); }
});
$('#rooms').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-group]')) { e.preventDefault(); e.target.click(); }
});

$('#playpause').addEventListener('click', () => { const g = currentGroup(); if (g) togglePlay(g); });
$('#next').addEventListener('click', () => act(`group/${enc(selected)}/next`));
$('#prev').addEventListener('click', () => act(`group/${enc(selected)}/previous`));
$('#shuffle').addEventListener('click', () => {
  const g = currentGroup();
  const v = !current('shuffle:' + g.id, g.shuffle);
  override('shuffle:' + g.id, v);
  renderPlayer(g);
  act(`group/${enc(g.id)}/playmode`, { shuffle: v });
});
$('#repeat').addEventListener('click', () => {
  const g = currentGroup();
  const order = ['none', 'all', 'one'];
  const v = order[(order.indexOf(current('repeat:' + g.id, g.repeat)) + 1) % 3];
  override('repeat:' + g.id, v);
  renderPlayer(g);
  act(`group/${enc(g.id)}/playmode`, { repeat: v });
});
$('#mute').addEventListener('click', () => {
  const g = currentGroup();
  const v = !current('gmute:' + g.id, g.mute);
  override('gmute:' + g.id, v);
  renderPlayer(g);
  act(`group/${enc(g.id)}/mute`, { mute: v });
});

// slaaptimer
$('#sleep').addEventListener('click', e => {
  e.stopPropagation();
  $('#sleep-menu').hidden = !$('#sleep-menu').hidden;
});
$('#sleep-menu').addEventListener('click', e => {
  const b = e.target.closest('[data-min]');
  if (!b) return;
  const min = +b.dataset.min;
  $('#sleep-menu').hidden = true;
  override('sleep:' + selected, min * 60, 3000);
  sleepInfo = { sec: min * 60, at: Date.now() };
  tick();
  act(`group/${enc(selected)}/sleep`, { minutes: min });
  toast(min ? `Muziek stopt over ${b.textContent}` : 'Slaaptimer uitgezet');
});
document.addEventListener('click', e => { if (!e.target.closest('.sleep-wrap')) $('#sleep-menu').hidden = true; });

bindSlider($('#volume'), v => {
  override('gvol:' + selected, v);
  act(`group/${enc(selected)}/volume`, { volume: v });
});
bindSlider($('#progress'), v => act(`group/${enc(selected)}/seek`, { position: v }));

$('#members').addEventListener('click', e => {
  const b = e.target.closest('[data-pmute]');
  if (!b) return;
  const v = !b.dataset.muted;
  override('pmute:' + b.dataset.pmute, v);
  act(`player/${enc(b.dataset.pmute)}/mute`, { mute: v });
  b.dataset.muted = v ? '1' : '';
  b.innerHTML = v ? ICON.muted : ICON.vol;
  b.classList.toggle('on', v);
});

$('#grouping').addEventListener('click', e => {
  const b = e.target.closest('[data-member]');
  if (!b) return;
  const g = currentGroup();
  const uuid = b.dataset.member;
  b.disabled = true;
  if (b.dataset.in) {
    if (g.members.length < 2) { b.disabled = false; return toast('Een groep moet minstens één kamer hebben.'); }
    act(`player/${enc(uuid)}/leave`);
  } else {
    act(`player/${enc(uuid)}/join`, { coordinator: g.coordinator });
  }
});

$('#favorites').addEventListener('click', e => {
  const b = e.target.closest('[data-fav]');
  if (!b) return;
  b.classList.add('loading');
  api(`group/${enc(selected)}/favorite`, { id: b.dataset.fav })
    .catch(err => toast(err.message))
    .finally(() => { b.classList.remove('loading'); loadQueue(); if (!sseOk) poll(); });
});
$('#fav-refresh').addEventListener('click', () => { favorites = null; renderFavorites(); loadFavorites(); });

// wachtrij
$('#queue').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    del.closest('.q-row').classList.add('removing');
    await act(`group/${enc(selected)}/queue-remove`, { n: +del.dataset.del });
    loadQueue();
    return;
  }
  const row = e.target.closest('.q-row');
  if (row) act(`group/${enc(selected)}/queue-play`, { n: +row.dataset.n });
});
$('#queue').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.q-row')) { e.preventDefault(); e.target.click(); }
});
$('#queue-clear').addEventListener('click', async () => {
  if (!confirm('De hele wachtrij wissen?')) return;
  await act(`group/${enc(selected)}/queue-clear`);
  loadQueue();
});

// klank
$('#eq-room').addEventListener('change', e => { eqRoom = e.target.value; loadEq(); });
$('#eq').addEventListener('change', e => {
  const t = e.target;
  if (t.matches('input[type=checkbox][data-eq]')) act(`player/${enc(eqRoom)}/eq`, { [t.dataset.eq]: t.checked });
});
$('#eq').addEventListener('click', async e => {
  if (!e.target.closest('.eq-reset')) return;
  await act(`player/${enc(eqRoom)}/eq`, { bass: 0, treble: 0 });
  loadEq();
});

// wekkers
$('#alarms').addEventListener('change', async e => {
  const t = e.target;
  if (!t.matches('[data-alarm]')) return;
  t.closest('.alarm').classList.toggle('off', !t.checked);
  try {
    await api(`alarms/${enc(t.dataset.alarm)}`, { enabled: t.checked });
  } catch (err) {
    toast(err.message);
    t.checked = !t.checked;
    t.closest('.alarm').classList.toggle('off', !t.checked);
  }
});

// systeeminformatie
async function loadSysinfo() {
  const body = $('#sysinfo-body');
  body.innerHTML = '<p class="muted">Gegevens ophalen bij de speakers…</p>';
  try {
    const list = await api('sysinfo');
    if (!list.length) { body.innerHTML = '<p class="muted">Geen speakers gevonden.</p>'; return; }
    const row = (k, v) => (v === null || v === undefined || v === '' ? '' : `<dt>${k}</dt><dd>${esc(v)}</dd>`);
    body.innerHTML = list.map(i => `
      <section class="sys">
        <h3>${esc(i.room)} <span class="muted">${esc(i.model || '')}</span></h3>
        ${i.error ? `<p class="muted">${esc(i.error)}</p>` : `
        <dl>
          ${row('Sonos-versie', [i.version, i.generation].filter(Boolean).join(' · '))}
          ${row('Software', [i.software, i.softwareDate && `(${i.softwareDate})`].filter(Boolean).join(' '))}
          ${row('Hardware', i.hardware)}
          ${row('Verbinding', [i.connection, i.wifiBand, i.wifiChannel && `kanaal ${i.wifiChannel}`].filter(Boolean).join(' · '))}
          ${row('Ruisvloer', i.noiseFloor !== null ? `${i.noiseFloor} dBm` : null)}
          ${row('SonosNet', i.sonosNet)}
          ${row('IP-adres', i.ip)}
          ${row('MAC-adres', i.mac)}
          ${row('Serienummer', i.serial)}
          ${row('Dataverkeer', i.received && `${i.received} ontvangen · ${i.sent} verzonden`)}
        </dl>
        <a href="${esc(i.supportUrl)}" target="_blank" rel="noopener" class="link-btn">Volledige diagnosepagina openen</a>`}
      </section>`).join('');
  } catch (e) {
    body.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
$('#info-btn').innerHTML = ICON.info;
$('#info-btn').addEventListener('click', () => { $('#sysinfo').showModal(); loadSysinfo(); });
$('#sysinfo-refresh').addEventListener('click', loadSysinfo);

$('#rescan').innerHTML = ICON.refresh;
$('#rescan').addEventListener('click', async () => {
  const b = $('#rescan');
  b.classList.add('spin');
  try {
    const r = await api('rescan', {});
    toast(`${r.speakers} speaker(s) gevonden`);
    favorites = null;
    loadFavorites();
    loadAlarms();
  } catch (err) { toast(err.message); }
  b.classList.remove('spin');
  poll();
});

// Sneltoetsen: spatie = play/pauze, pijltjes = volume
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, button, select, [role=button]') && (e.key === ' ' || e.key === 'Enter')) return;
  if ($('#settings').open || $('#sysinfo').open) return;
  const g = currentGroup();
  if (!g) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(g); }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.matches('input, select')) {
    e.preventDefault();
    const v = Math.max(0, Math.min(100, current('gvol:' + g.id, g.volume) + (e.key === 'ArrowUp' ? 2 : -2)));
    override('gvol:' + g.id, v);
    renderPlayer(g);
    act(`group/${enc(g.id)}/volume`, { volume: v });
  }
});

// Iconen voor statische knoppen
$('#prev').innerHTML = ICON.prev;
$('#next').innerHTML = ICON.next;
$('#shuffle').innerHTML = ICON.shuffle;
$('#sleep').innerHTML = ICON.moon;

// ------------------------------------------------------------------ Windows-app
if (window.sonosApp) {
  const app = window.sonosApp;
  const btn = $('#settings-btn');
  btn.innerHTML = ICON.gear;
  btn.hidden = false;

  const fill = s => {
    document.querySelectorAll('[data-setting]').forEach(el => { el.checked = !!s[el.dataset.setting]; });
  };
  btn.addEventListener('click', async () => {
    fill(await app.getSettings());
    $('#version').textContent = 'versie ' + (await app.getVersion());
    $('#settings').showModal();
  });
  $('#settings').addEventListener('change', async e => {
    const el = e.target;
    if (!el.matches('[data-setting]')) return;
    const r = await app.setSetting(el.dataset.setting, el.checked);
    fill(r.settings);
    if (r.message) toast(r.message);
  });

  const showUpdate = u => {
    $('#update-status').textContent = u.text || '';
    if (u.state === 'downloaded') {
      $('#update-text').textContent = `Versie ${u.version} is gedownload.`;
      $('#update-bar').hidden = false;
    }
  };
  app.onUpdateStatus(showUpdate);
  app.getUpdateStatus().then(showUpdate);
  $('#check-updates').addEventListener('click', () => {
    $('#update-status').textContent = 'Controleren…';
    app.checkForUpdates();
  });
  $('#update-install').addEventListener('click', () => app.installUpdate());
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { });
}

// ------------------------------------------------------------------ Start
renderFavorites();
renderAlarms();
connect();
poll().then(() => { if (selected) { api('selected', { id: selected }).catch(() => { }); loadQueue(); loadEq(); } });
loadFavorites();
loadAlarms();
