'use strict';
// Mini-speler: compacte bediening van de groep die in het hoofdvenster gekozen is.

const $ = s => document.querySelector(s);
const app = window.sonosApp || { showMain() { location.href = '/'; }, hideMini() { window.close(); } };

let group = null;
let prog = { pos: 0, dur: 0, at: 0, playing: false };
let dragging = false;
const pending = new Map();

const isPlaying = g => g && (g.state === 'PLAYING' || g.state === 'TRANSITIONING');
function override(key, value, ms = 2500) { pending.set(key, { value, until: Date.now() + ms }); }
function current(key, value) {
  const p = pending.get(key);
  if (p && p.until > Date.now()) return p.value;
  pending.delete(key);
  return value;
}

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch('/api/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function act(path, body = {}) {
  try { await api(path, body); } catch (e) { $('#sub').textContent = e.message; }
  if (!sseOk) setTimeout(poll, 350);
}

function pickGroup(groups) {
  const sel = localStorage.getItem('sonos.group');
  return groups.find(g => g.id === sel)
    || groups.find(g => g.members.some(m => m.uuid === sel))
    || groups.find(isPlaying)
    || groups[0];
}

let lastGroups = [];
let sseOk = false;
function applyState(s) {
  lastGroups = s.groups;
  group = pickGroup(lastGroups);
  render();
}
async function poll() {
  try {
    applyState(await api('state'));
  } catch (e) {
    $('#title').textContent = 'Geen verbinding';
    $('#sub').textContent = e.message;
  }
}
// Live updates van de server; elke 2 s ophalen alleen als die verbinding wegvalt
const es = new EventSource('/api/events');
es.addEventListener('state', e => { sseOk = true; applyState(JSON.parse(e.data)); });
es.onopen = () => { sseOk = true; };
es.onerror = () => { sseOk = false; };
setInterval(() => { if (!sseOk && !document.hidden) poll(); }, 2000);
// Andere kamer gekozen in het hoofdvenster
window.addEventListener('storage', e => { if (e.key === 'sonos.group') { group = pickGroup(lastGroups); render(); } });

function render() {
  const g = group;
  if (!g) {
    $('#title').textContent = 'Geen speakers gevonden';
    $('#sub').textContent = '';
    return;
  }
  const t = g.track || {};
  const title = g.error ? 'Niet bereikbaar' : g.empty ? 'Niets aan het afspelen' : (t.title || 'Onbekend');
  $('#title').textContent = title;
  $('#title').title = title;
  $('#sub').textContent = [t.artist || t.album, g.name].filter(Boolean).join(' · ');

  const img = $('#art-img');
  if (t.art) {
    if (img.getAttribute('src') !== t.art) img.src = t.art;
    img.hidden = false;
    $('#art-ph').innerHTML = '';
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    $('#art-ph').innerHTML = g.source === 'radio' ? ICON.radio : g.source === 'tv' ? ICON.tv : ICON.note;
  }

  const live = g.source === 'radio' || g.source === 'tv';
  const playing = current('play', isPlaying(g));
  $('#play').innerHTML = playing ? (live ? ICON.stop : ICON.pause) : ICON.play;
  const queue = g.source === 'music' && !g.empty;
  $('#prev').disabled = !queue;
  $('#next').disabled = !queue;

  const muted = current('mute', g.mute);
  $('#mute').innerHTML = muted ? ICON.muted : ICON.vol;
  $('#mute').classList.toggle('on', !!muted);
  if (!dragging) setVol(current('vol', g.volume ?? 0));

  prog = { pos: t.position || 0, dur: t.duration || 0, at: Date.now(), playing: isPlaying(g) };
  tick();
}

function setVol(v) {
  const el = $('#volume');
  el.value = v;
  el.style.setProperty('--fill', v + '%');
  el.title = 'Volume ' + v;
}

function tick() {
  const pos = prog.pos + (prog.playing ? (Date.now() - prog.at) / 1000 : 0);
  $('#bar-fill').style.width = prog.dur ? Math.min(100, (pos / prog.dur) * 100) + '%' : '0';
}
setInterval(tick, 500);

// ---------------------------------------------------------------- events
const gid = () => encodeURIComponent(group.id);

$('#play').addEventListener('click', () => {
  if (!group) return;
  const playing = current('play', isPlaying(group));
  override('play', !playing, 2000);
  render();
  act(`group/${gid()}/${playing ? 'pause' : 'play'}`);
});
$('#next').addEventListener('click', () => group && act(`group/${gid()}/next`));
$('#prev').addEventListener('click', () => group && act(`group/${gid()}/previous`));
$('#mute').addEventListener('click', () => {
  if (!group) return;
  const v = !current('mute', group.mute);
  override('mute', v);
  render();
  act(`group/${gid()}/mute`, { mute: v });
});

(() => {
  const el = $('#volume');
  let timer = null;
  const send = () => {
    timer = null;
    if (!group) return;
    const v = +el.value;
    override('vol', v);
    act(`group/${gid()}/volume`, { volume: v });
  };
  el.addEventListener('pointerdown', () => { dragging = true; });
  el.addEventListener('input', () => { setVol(+el.value); if (!timer) timer = setTimeout(send, 160); });
  el.addEventListener('change', () => { clearTimeout(timer); send(); setTimeout(() => { dragging = false; }, 300); });
  // scrollwiel op de mini-speler = volume
  document.addEventListener('wheel', e => {
    if (!group) return;
    const v = Math.max(0, Math.min(100, +el.value + (e.deltaY < 0 ? 2 : -2)));
    setVol(v);
    clearTimeout(timer);
    timer = setTimeout(send, 160);
  }, { passive: true });
})();

$('#open').addEventListener('click', () => app.showMain());
$('#art').addEventListener('click', () => app.showMain());
$('#close').addEventListener('click', () => app.hideMini());


$('#prev').innerHTML = ICON.prev;
$('#next').innerHTML = ICON.next;
$('#open').innerHTML = ICON.open;
$('#close').innerHTML = ICON.close;
$('#play').innerHTML = ICON.play;
$('#mute').innerHTML = ICON.vol;
poll();
