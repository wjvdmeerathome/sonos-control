'use strict';
// Sonos Control — lokale server die Sonos-speakers vindt (SSDP / subnet-scan)
// en via UPnP/SOAP op poort 1400 aanstuurt. Geen externe dependencies.

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const PORT = +process.env.PORT || 8420;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* optioneel */ }

// ---------------------------------------------------------------- XML helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (s == null) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return ENT[e.toLowerCase()];
  });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Inhoud van het eerste element met deze naam (namespace-prefix optioneel)
function tag(xml, name) {
  if (!xml) return null;
  const re = new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '>');
  const m = xml.match(re);
  return m ? m[1] : null;
}
function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:.-]+)="([^"]*)"/g)) o[m[1]] = decode(m[2]);
  return o;
}
const toSec = t => {
  if (!t || !/^\d+:\d+:\d+/.test(t)) return 0;
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const toHms = sec => {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- HTTP / SOAP
function httpGet(url, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 200000) req.destroy(); });
      res.on('end', () => (res.statusCode === 200 ? resolve(data) : reject(new Error('HTTP ' + res.statusCode))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const SERVICES = {
  AVTransport: ['/MediaRenderer/AVTransport/Control', 'urn:schemas-upnp-org:service:AVTransport:1'],
  RenderingControl: ['/MediaRenderer/RenderingControl/Control', 'urn:schemas-upnp-org:service:RenderingControl:1'],
  GroupRenderingControl: ['/MediaRenderer/GroupRenderingControl/Control', 'urn:schemas-upnp-org:service:GroupRenderingControl:1'],
  ContentDirectory: ['/MediaServer/ContentDirectory/Control', 'urn:schemas-upnp-org:service:ContentDirectory:1'],
  ZoneGroupTopology: ['/ZoneGroupTopology/Control', 'urn:schemas-upnp-org:service:ZoneGroupTopology:1'],
  AlarmClock: ['/AlarmClock/Control', 'urn:schemas-upnp-org:service:AlarmClock:1'],
};

const UPNP_ERRORS = {
  701: 'Niet beschikbaar voor deze bron',
  711: 'Niet beschikbaar voor deze bron',
  712: 'Afspeelmodus niet ondersteund door deze bron',
  714: 'Ongeldig mediaformaat',
  800: 'Speaker is onderdeel van een groep',
};

function soap(ip, svc, action, args = {}, timeout = 4000) {
  const [p, urn] = SERVICES[svc];
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const body = '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${urn}">${inner}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: ip, port: 1400, path: p, method: 'POST', timeout,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${urn}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve(data);
        const code = tag(data, 'errorCode');
        const e = new Error(UPNP_ERRORS[code] || `${action} mislukt (HTTP ${res.statusCode}${code ? ', UPnP ' + code : ''})`);
        e.upnp = code;
        reject(e);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${action}: speaker ${ip} reageert niet`)));
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------- Discovery
function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a);
    }
  }
  return out;
}

const SSDP_MSG = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\n' +
  'ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');

async function ssdp(timeout = 2000) {
  const found = new Set();
  await Promise.all(localIPv4().map(ifc => new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    let closed = false;
    const done = () => { if (!closed) { closed = true; try { sock.close(); } catch { } } resolve(); };
    sock.on('error', done);
    sock.on('message', (m, r) => { if (/Sonos|ZonePlayer/i.test(m.toString())) found.add(r.address); });
    sock.bind(0, ifc.address, () => {
      sock.send(SSDP_MSG, 1900, '239.255.255.250');
      setTimeout(() => { if (!closed) sock.send(SSDP_MSG, 1900, '239.255.255.250'); }, 400);
      setTimeout(done, timeout);
    });
  })));
  return [...found];
}

// Terugval als multicast geblokkeerd is: /24 van elke netwerkkaart afscannen.
async function scanSubnets() {
  const ips = new Set();
  for (const ifc of localIPv4()) {
    const base = ifc.address.split('.').slice(0, 3).join('.');
    for (let i = 1; i < 255; i++) ips.add(`${base}.${i}`);
  }
  const queue = [...ips];
  const found = [];
  await Promise.all(Array.from({ length: 64 }, async () => {
    while (queue.length) {
      const ip = queue.shift();
      try {
        const xml = await httpGet(`http://${ip}:1400/xml/device_description.xml`, 800);
        if (/Sonos/i.test(xml)) found.push(ip);
      } catch { /* geen Sonos */ }
    }
  }));
  return found;
}

let seedIPs = [];
async function discover() {
  let ips = Array.isArray(config.speakers) ? [...config.speakers] : [];
  let how = 'config.json';
  if (!ips.length) { ips = await ssdp(); how = 'SSDP'; }
  if (!ips.length) { ips = await scanSubnets(); how = 'netwerkscan'; }
  seedIPs = ips;
  console.log(ips.length ? `Sonos gevonden via ${how}: ${ips.join(', ')}` : 'Geen Sonos-speakers gevonden.');
}

// ---------------------------------------------------------------- Topology
let topo = { groups: [], players: {}, at: 0 };
let topoPromise = null;

function refreshTopology(force = false) {
  if (!force && topo.groups.length && Date.now() - topo.at < 15000) return Promise.resolve(topo);
  if (!topoPromise) topoPromise = loadTopology().finally(() => { topoPromise = null; });
  return topoPromise;
}

async function loadTopology() {
  if (!seedIPs.length) await discover();
  const candidates = [...new Set([...Object.values(topo.players).map(p => p.ip), ...seedIPs])];
  let xml, lastErr;
  for (const ip of candidates) {
    try { xml = await soap(ip, 'ZoneGroupTopology', 'GetZoneGroupState', {}, 3000); break; } catch (e) { lastErr = e; }
  }
  if (!xml) {
    seedIPs = [];
    topo = { groups: [], players: {}, at: 0 };
    throw new Error(lastErr ? 'Sonos niet bereikbaar: ' + lastErr.message : 'Geen Sonos-speakers gevonden op het netwerk');
  }
  const state = decode(tag(xml, 'ZoneGroupState')) || '';
  const groups = [];
  const players = {};
  for (const g of state.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const ga = attrs(g[1]);
    const members = [];
    for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (a.Invisible === '1' || a.IsZoneBridge === '1') continue;
      const ip = ((a.Location || '').match(/\/\/([^:/]+)/) || [])[1];
      if (!ip) continue;
      const p = { uuid: a.UUID, name: a.ZoneName, ip, isCoordinator: a.UUID === ga.Coordinator };
      members.push(p);
      players[p.uuid] = p;
    }
    if (!members.length) continue;
    members.sort((a, b) => (b.isCoordinator - a.isCoordinator) || a.name.localeCompare(b.name));
    const coordinator = players[ga.Coordinator] || members[0];
    groups.push({ id: coordinator.uuid, coordinator, members });
  }
  groups.sort((a, b) => a.coordinator.name.localeCompare(b.coordinator.name));
  topo = { groups, players, at: Date.now() };
  syncSubscriptions().catch(e => console.log('Abonneren mislukt:', e.message));
  return topo;
}

async function getGroup(id) {
  let t = await refreshTopology();
  let g = t.groups.find(x => x.id === id);
  if (!g) { t = await refreshTopology(true); g = t.groups.find(x => x.id === id); }
  if (!g) throw Object.assign(new Error('Groep niet gevonden'), { status: 404 });
  return g;
}
async function getPlayer(uuid) {
  let t = await refreshTopology();
  if (!t.players[uuid]) t = await refreshTopology(true);
  const p = t.players[uuid];
  if (!p) throw Object.assign(new Error('Speaker niet gevonden'), { status: 404 });
  return p;
}

// ---------------------------------------------------------------- State
const STREAM_RE = /^(x-sonosapi-stream|x-sonosapi-radio|x-rincon-mp3radio|x-sonosapi-hls|aac:|hls-radio|pndrradio)/i;
const PLAYMODES = {
  NORMAL: [false, 'none'], REPEAT_ALL: [false, 'all'], REPEAT_ONE: [false, 'one'],
  SHUFFLE_NOREPEAT: [true, 'none'], SHUFFLE: [true, 'all'], SHUFFLE_REPEAT_ONE: [true, 'one'],
};
const absArt = (art, ip) => (art && art.startsWith('/') ? `http://${ip}:1400${art}` : art || null);

async function memberState(m) {
  try {
    const [v, mu] = await Promise.all([
      soap(m.ip, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }, 2500),
      soap(m.ip, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' }, 2500),
    ]);
    return { uuid: m.uuid, name: m.name, volume: +tag(v, 'CurrentVolume'), mute: tag(mu, 'CurrentMute') === '1' };
  } catch (e) {
    return { uuid: m.uuid, name: m.name, volume: 0, mute: false, error: e.message };
  }
}

async function groupState(g) {
  const ip = g.coordinator.ip;
  const base = { id: g.id, name: g.members.map(m => m.name).join(' + '), coordinator: g.coordinator.uuid };
  try {
    const [ti, pi, mi, ts, gv, gm, sl, members] = await Promise.all([
      soap(ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }, 2500),
      soap(ip, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }, 2500),
      soap(ip, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 }, 2500),
      soap(ip, 'AVTransport', 'GetTransportSettings', { InstanceID: 0 }, 2500).catch(() => null),
      soap(ip, 'GroupRenderingControl', 'GetGroupVolume', { InstanceID: 0 }, 2500).catch(() => null),
      soap(ip, 'GroupRenderingControl', 'GetGroupMute', { InstanceID: 0 }, 2500).catch(() => null),
      soap(ip, 'AVTransport', 'GetRemainingSleepTimerDuration', { InstanceID: 0 }, 2500).catch(() => null),
      Promise.all(g.members.map(memberState)),
    ]);

    const uri = decode(tag(pi, 'TrackURI')) || '';
    const mediaUri = decode(tag(mi, 'CurrentURI')) || '';
    const meta = decode(tag(pi, 'TrackMetaData'));
    const mediaMeta = decode(tag(mi, 'CurrentURIMetaData'));
    const val = (xml, name) => decode(tag(xml, name)) || '';

    let title = val(meta, 'title');
    let artist = val(meta, 'creator');
    let album = val(meta, 'album');
    let art = absArt(val(meta, 'albumArtURI'), ip);
    let source = 'music';
    const station = val(mediaMeta, 'title');
    const isStream = STREAM_RE.test(mediaUri) || STREAM_RE.test(uri);

    if (isStream) {
      source = 'radio';
      const sc = val(meta, 'streamContent');
      if (sc && !/^(ZPSTR_|TYPE=)/.test(sc)) {
        const i = sc.indexOf(' - ');
        if (i > 0) { artist = sc.slice(0, i); title = sc.slice(i + 3); } else { title = sc; artist = ''; }
      } else if (station) {
        // Zonder 'nu speelt'-info bevat dc:title vaak de technische streamnaam
        title = station; artist = '';
      }
      if (station && station !== title) album = station;
      if (!art) art = absArt(val(mediaMeta, 'albumArtURI'), ip);
    } else if (/^x-rincon-stream:/.test(mediaUri)) {
      source = 'linein'; title = title || 'Line-in'; artist = artist || '';
    } else if (/^x-sonos-htastream:/.test(mediaUri)) {
      source = 'tv'; title = 'TV'; artist = '';
    }

    const pm = PLAYMODES[tag(ts, 'PlayMode')] || [false, 'none'];
    const volume = gv ? +tag(gv, 'CurrentVolume') : Math.round(members.reduce((s, m) => s + m.volume, 0) / members.length);
    return {
      ...base,
      state: tag(ti, 'CurrentTransportState') || 'STOPPED',
      source,
      track: {
        title, artist, album, art,
        duration: toSec(tag(pi, 'TrackDuration')),
        position: toSec(tag(pi, 'RelTime')),
        number: +tag(pi, 'Track') || 0,
      },
      empty: !mediaUri && !uri,
      queueActive: mediaUri.startsWith('x-rincon-queue:'),
      sleep: sl ? toSec(tag(sl, 'RemainingSleepTimerDuration')) : 0,
      shuffle: pm[0], repeat: pm[1],
      volume, mute: gm ? tag(gm, 'CurrentMute') === '1' : members.every(m => m.mute),
      members,
    };
  } catch (e) {
    topo.at = 0; // volgende keer topologie opnieuw laden
    return { ...base, error: e.message, members: g.members.map(m => ({ uuid: m.uuid, name: m.name, volume: 0, mute: false })) };
  }
}

// ---------------------------------------------------------------- Favorites
let favCache = [];
async function loadFavorites() {
  const t = await refreshTopology();
  const ip = t.groups[0] && t.groups[0].coordinator.ip;
  if (!ip) return [];
  const r = await soap(ip, 'ContentDirectory', 'Browse', {
    ObjectID: 'FV:2', BrowseFlag: 'BrowseDirectChildren', Filter: '*',
    StartingIndex: 0, RequestedCount: 200, SortCriteria: '',
  });
  const didl = decode(tag(r, 'Result')) || '';
  favCache = [];
  for (const it of didl.matchAll(/<item\s([^>]*)>([\s\S]*?)<\/item>/g)) {
    const a = attrs(it[1]);
    const body = it[2];
    favCache.push({
      id: a.id,
      title: decode(tag(body, 'title')) || '',
      description: decode(tag(body, 'description')) || '',
      art: absArt(decode(tag(body, 'albumArtURI')), ip),
      uri: decode(tag(body, 'res')) || '',
      meta: decode(tag(body, 'resMD')) || '',
    });
  }
  return favCache;
}

const SLOW = 30000;
async function playFavorite(g, favId) {
  if (!favCache.length) await loadFavorites();
  const f = favCache.find(x => x.id === favId);
  if (!f) throw Object.assign(new Error('Favoriet niet gevonden'), { status: 404 });
  const ip = g.coordinator.ip;
  const I = { InstanceID: 0 };
  const isStream = STREAM_RE.test(f.uri) || /audioBroadcast/.test(f.meta);
  if (isStream || !f.uri.match(/^(x-rincon-cpcontainer|x-rincon-playlist|file:|x-sonos-spotify|x-sonos-http|x-sonosprog-http|x-file-cifs|http)/i)) {
    await soap(ip, 'AVTransport', 'SetAVTransportURI', { ...I, CurrentURI: f.uri, CurrentURIMetaData: f.meta }, SLOW);
  } else {
    await soap(ip, 'AVTransport', 'RemoveAllTracksFromQueue', I);
    await soap(ip, 'AVTransport', 'AddURIToQueue', {
      ...I, EnqueuedURI: f.uri, EnqueuedURIMetaData: f.meta, DesiredFirstTrackNumberEnqueued: 0, EnqueueAsNext: 0,
    }, SLOW); // playlists ophalen bij een streamingdienst kan even duren
    await soap(ip, 'AVTransport', 'SetAVTransportURI', { ...I, CurrentURI: `x-rincon-queue:${g.coordinator.uuid}#0`, CurrentURIMetaData: '' });
  }
  await soap(ip, 'AVTransport', 'Play', { ...I, Speed: 1 }, SLOW);
}

// ---------------------------------------------------------------- Actions
const clamp = v => Math.max(0, Math.min(100, Math.round(+v || 0)));
const MODE_OF = (sh, rep) => Object.keys(PLAYMODES).find(k => PLAYMODES[k][0] === sh && PLAYMODES[k][1] === rep);

async function groupAction(id, action, body) {
  const g = await getGroup(id);
  const ip = g.coordinator.ip;
  const I = { InstanceID: 0 };
  switch (action) {
    case 'play': return soap(ip, 'AVTransport', 'Play', { ...I, Speed: 1 });
    case 'pause':
      return soap(ip, 'AVTransport', 'Pause', I).catch(e => {
        if (e.upnp === '701') return soap(ip, 'AVTransport', 'Stop', I); // radio kan soms alleen stoppen
        throw e;
      });
    case 'next': return soap(ip, 'AVTransport', 'Next', I);
    case 'previous': return soap(ip, 'AVTransport', 'Previous', I);
    case 'seek': return soap(ip, 'AVTransport', 'Seek', { ...I, Unit: 'REL_TIME', Target: toHms(body.position) });
    case 'volume':
      await soap(ip, 'GroupRenderingControl', 'SnapshotGroupVolume', I).catch(() => { });
      return soap(ip, 'GroupRenderingControl', 'SetGroupVolume', { ...I, DesiredVolume: clamp(body.volume) });
    case 'mute': return soap(ip, 'GroupRenderingControl', 'SetGroupMute', { ...I, DesiredMute: body.mute ? 1 : 0 });
    case 'playmode': {
      const ts = await soap(ip, 'AVTransport', 'GetTransportSettings', I);
      const [sh, rep] = PLAYMODES[tag(ts, 'PlayMode')] || [false, 'none'];
      const mode = MODE_OF(body.shuffle ?? sh, body.repeat ?? rep);
      return soap(ip, 'AVTransport', 'SetPlayMode', { ...I, NewPlayMode: mode });
    }
    case 'favorite': return playFavorite(g, body.id);
    case 'sleep':
      return soap(ip, 'AVTransport', 'ConfigureSleepTimer', {
        ...I, NewSleepTimerDuration: +body.minutes > 0 ? toHms(+body.minutes * 60) : '',
      });
    case 'queue-play': {
      const mi = await soap(ip, 'AVTransport', 'GetMediaInfo', I);
      if (!(decode(tag(mi, 'CurrentURI')) || '').startsWith('x-rincon-queue:')) {
        await soap(ip, 'AVTransport', 'SetAVTransportURI', { ...I, CurrentURI: `x-rincon-queue:${g.coordinator.uuid}#0`, CurrentURIMetaData: '' });
      }
      await soap(ip, 'AVTransport', 'Seek', { ...I, Unit: 'TRACK_NR', Target: String(Math.max(1, Math.floor(+body.n) || 1)) });
      return soap(ip, 'AVTransport', 'Play', { ...I, Speed: 1 });
    }
    case 'queue-remove':
      return soap(ip, 'AVTransport', 'RemoveTrackFromQueue', { ...I, ObjectID: `Q:0/${Math.floor(+body.n) || 0}`, UpdateID: 0 });
    case 'queue-clear': return soap(ip, 'AVTransport', 'RemoveAllTracksFromQueue', I);
    default: throw Object.assign(new Error('Onbekende actie'), { status: 400 });
  }
}

async function playerAction(uuid, action, body) {
  const p = await getPlayer(uuid);
  const I = { InstanceID: 0 };
  switch (action) {
    case 'volume': return soap(p.ip, 'RenderingControl', 'SetVolume', { ...I, Channel: 'Master', DesiredVolume: clamp(body.volume) });
    case 'mute': return soap(p.ip, 'RenderingControl', 'SetMute', { ...I, Channel: 'Master', DesiredMute: body.mute ? 1 : 0 });
    case 'join': {
      const target = await getPlayer(body.coordinator);
      await soap(p.ip, 'AVTransport', 'SetAVTransportURI', { ...I, CurrentURI: `x-rincon:${target.uuid}`, CurrentURIMetaData: '' });
      return refreshTopology(true);
    }
    case 'leave':
      await soap(p.ip, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', I);
      return refreshTopology(true);
    case 'eq': {
      const eq = v => Math.max(-10, Math.min(10, Math.round(+v || 0)));
      if ('bass' in body) await soap(p.ip, 'RenderingControl', 'SetBass', { ...I, DesiredBass: eq(body.bass) });
      if ('treble' in body) await soap(p.ip, 'RenderingControl', 'SetTreble', { ...I, DesiredTreble: eq(body.treble) });
      if ('loudness' in body) await soap(p.ip, 'RenderingControl', 'SetLoudness', { ...I, Channel: 'Master', DesiredLoudness: body.loudness ? 1 : 0 });
      if ('nightMode' in body) await soap(p.ip, 'RenderingControl', 'SetEQ', { ...I, EQType: 'NightMode', DesiredValue: body.nightMode ? 1 : 0 });
      if ('speech' in body) await soap(p.ip, 'RenderingControl', 'SetEQ', { ...I, EQType: 'DialogLevel', DesiredValue: body.speech ? 1 : 0 });
      return null;
    }
    default: throw Object.assign(new Error('Onbekende actie'), { status: 400 });
  }
}

// ---------------------------------------------------------------- Wachtrij
async function getQueue(id) {
  const g = await getGroup(id);
  const ip = g.coordinator.ip;
  const r = await soap(ip, 'ContentDirectory', 'Browse', {
    ObjectID: 'Q:0', BrowseFlag: 'BrowseDirectChildren', Filter: '*',
    StartingIndex: 0, RequestedCount: 500, SortCriteria: '',
  }, 10000);
  const didl = decode(tag(r, 'Result')) || '';
  const items = [];
  for (const it of didl.matchAll(/<item\s([^>]*)>([\s\S]*?)<\/item>/g)) {
    const m = (attrs(it[1]).id || '').match(/Q:0\/(\d+)/);
    const b = it[2];
    items.push({
      n: m ? +m[1] : items.length + 1,
      title: decode(tag(b, 'title')) || '',
      artist: decode(tag(b, 'creator')) || '',
      album: decode(tag(b, 'album')) || '',
      art: absArt(decode(tag(b, 'albumArtURI')), ip),
    });
  }
  return { items, total: +tag(r, 'TotalMatches') || items.length };
}

// ---------------------------------------------------------------- Klank
async function getEq(uuid) {
  const p = await getPlayer(uuid);
  const I = { InstanceID: 0 };
  const [b, t, l, nm, dl] = await Promise.all([
    soap(p.ip, 'RenderingControl', 'GetBass', I),
    soap(p.ip, 'RenderingControl', 'GetTreble', I),
    soap(p.ip, 'RenderingControl', 'GetLoudness', { ...I, Channel: 'Master' }),
    soap(p.ip, 'RenderingControl', 'GetEQ', { ...I, EQType: 'NightMode' }).catch(() => null),
    soap(p.ip, 'RenderingControl', 'GetEQ', { ...I, EQType: 'DialogLevel' }).catch(() => null),
  ]);
  return {
    bass: +tag(b, 'CurrentBass') || 0,
    treble: +tag(t, 'CurrentTreble') || 0,
    loudness: tag(l, 'CurrentLoudness') === '1',
    nightMode: nm ? tag(nm, 'CurrentValue') === '1' : null, // null = geen soundbar
    speech: dl ? tag(dl, 'CurrentValue') === '1' : null,
  };
}

// ---------------------------------------------------------------- Wekkers
let alarmCache = [];
const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
function recurrenceText(r = '') {
  if (r === 'DAILY') return 'Elke dag';
  if (r === 'WEEKDAYS') return 'Ma t/m vr';
  if (r === 'WEEKENDS') return 'Za en zo';
  if (r === 'ONCE') return 'Eenmalig';
  const m = r.match(/^ON_(\d+)$/);
  if (!m) return r;
  const set = new Set(m[1].split('').map(Number));
  return [1, 2, 3, 4, 5, 6, 0].filter(d => set.has(d)).map(d => DAYS[d]).join(', ');
}
function alarmSource(a) {
  if (/^x-rincon-buzzer:/.test(a.ProgramURI || '')) return 'Sonos-geluid';
  return decode(tag(a.ProgramMetaData || '', 'title')) || 'Muziek';
}
function anyPlayerIp() {
  const p = Object.values(topo.players)[0];
  return p && p.ip;
}
async function listAlarms() {
  const t = await refreshTopology();
  const ip = anyPlayerIp();
  if (!ip) return [];
  const r = await soap(ip, 'AlarmClock', 'ListAlarms', {});
  const xml = decode(tag(r, 'CurrentAlarmList')) || '';
  alarmCache = [...xml.matchAll(/<Alarm\s([^>]*?)\/?>/g)].map(m => attrs(m[1]));
  return alarmCache.map(a => ({
    id: a.ID,
    time: (a.StartTime || '').slice(0, 5),
    days: recurrenceText(a.Recurrence),
    enabled: a.Enabled === '1',
    room: (t.players[a.RoomUUID] && t.players[a.RoomUUID].name) || 'Onbekende kamer',
    source: alarmSource(a),
    volume: +a.Volume || 0,
  })).sort((x, y) => x.time.localeCompare(y.time));
}
async function setAlarmEnabled(id, enabled) {
  if (!alarmCache.some(a => a.ID === id)) await listAlarms();
  const a = alarmCache.find(x => x.ID === id);
  if (!a) throw Object.assign(new Error('Wekker niet gevonden'), { status: 404 });
  await soap(anyPlayerIp(), 'AlarmClock', 'UpdateAlarm', {
    ID: a.ID, StartLocalTime: a.StartTime, Duration: a.Duration, Recurrence: a.Recurrence,
    Enabled: enabled ? 1 : 0, RoomUUID: a.RoomUUID, ProgramURI: a.ProgramURI, ProgramMetaData: a.ProgramMetaData,
    PlayMode: a.PlayMode, Volume: a.Volume, IncludeLinkedZones: a.IncludeLinkedZones,
  });
  a.Enabled = enabled ? '1' : '0';
}

// ---------------------------------------------------------------- Systeeminformatie
// Combineert de apparaatbeschrijving met de diagnosepagina /support/review van elke speaker.
const fmtBytes = n => {
  if (!n) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`;
};

async function playerInfo(p) {
  const base = `http://${p.ip}:1400`;
  const [desc, review] = await Promise.all([
    httpGet(`${base}/xml/device_description.xml`, 4000).catch(() => ''),
    httpGet(`${base}/support/review`, 6000).catch(() => ''),
  ]);
  const t = (xml, name) => decode(tag(xml, name)) || null;
  const zp = tag(review, 'ZPInfo') || '';
  const wifi = tag(review, 'WirelessInfo') || '';
  const radio = (review.match(/<File name='\/proc\/ath_rincon\/status'>([\s\S]*?)<\/File>/) || [])[1] || '';
  const ifc = (review.match(/<Command cmdline='\/sbin\/ifconfig'>([\s\S]*?)<\/Command>/) || [])[1] || '';
  const br = (ifc.split(/\n(?=\S)/).find(b => b.startsWith('br0')) || ifc);
  const rx = +((br.match(/RX bytes:(\d+)/) || [])[1] || 0);
  const tx = +((br.match(/TX bytes:(\d+)/) || [])[1] || 0);
  const channel = +((radio.match(/IEEE channel:\s*(\d+)/) || [])[1] || 0);
  const noise = (radio.match(/Noise Floor:\s*(-\d+) dBm/) || [])[1];
  const connection = t(wifi, 'ConnectionTypeString') || (/eth\d.*\n.*inet addr/.test(ifc) ? 'Ethernet' : null);
  const swGen = t(desc, 'swGen') || t(zp, 'SWGen');
  return {
    uuid: p.uuid,
    room: p.name,
    model: t(desc, 'modelName') || t(desc, 'displayName'),
    modelNumber: t(desc, 'modelNumber'),
    ip: p.ip,
    mac: t(desc, 'MACAddress') || t(zp, 'MACAddress'),
    serial: t(desc, 'serialNum') || t(zp, 'SerialNumber'),
    version: t(desc, 'displayVersion'),
    software: t(desc, 'softwareVersion') || t(zp, 'SoftwareVersion'),
    softwareDate: (t(zp, 'SoftwareDate') || '').slice(0, 10) || null,
    hardware: t(desc, 'hardwareVersion') || t(zp, 'HardwareVersion'),
    generation: swGen ? `S${swGen}` : null,
    connection: connection === 'WiFi' ? 'Wifi' : connection,
    wifiChannel: channel || null,
    wifiBand: channel ? (channel > 14 ? '5 GHz' : '2,4 GHz') : null,
    noiseFloor: noise ? +noise : null,
    sonosNet: t(wifi, 'SonosNetDisabled') === '0' ? 'aan' : t(wifi, 'SonosNetDisabled') === '1' ? 'uit' : null,
    received: fmtBytes(rx),
    sent: fmtBytes(tx),
    supportUrl: `${base}/support/review`,
    error: !desc && !review ? 'Speaker reageert niet' : null,
  };
}

async function systemInfo() {
  const t = await refreshTopology();
  const players = Object.values(t.players).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(players.map(playerInfo));
}

// ---------------------------------------------------------------- Live updates
// De server abonneert zich op UPnP-events van de speakers. Bij elke melding wordt
// de status opnieuw opgehaald en via Server-Sent Events naar alle vensters gestuurd.
// Komen er geen events binnen (bijv. door de firewall), dan haalt hij elke 2 s op.
const bus = new EventEmitter();
const sseClients = new Set();
let lastState = null;
let lastStateJson = '';
let lastPush = 0;
let pushTimer = null;
let computing = null;
let pushAgain = false;
let eventsOk = false;
let selectedGroup = null;

function broadcast(event, data) {
  for (const res of sseClients) res.write(`event: ${event}\ndata: ${data}\n\n`);
}

async function computeState() {
  const t = await refreshTopology();
  const groups = await Promise.all(t.groups.map(groupState));
  return { groups, live: eventsOk };
}

function pushState() {
  if (computing) { pushAgain = true; return computing; }
  computing = (async () => {
    try {
      const s = await computeState();
      lastState = s;
      const json = JSON.stringify(s);
      if (json !== lastStateJson) {
        lastStateJson = json;
        broadcast('state', json);
        bus.emit('state', s);
      }
    } catch (e) {
      broadcast('failure', JSON.stringify({ error: e.message }));
    } finally {
      lastPush = Date.now();
    }
  })().finally(() => {
    computing = null;
    if (pushAgain) { pushAgain = false; scheduleStatePush(100); }
  });
  return computing;
}
function scheduleStatePush(ms = 150) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushState, ms);
}

let pingAt = 0;
setInterval(() => {
  if (!sseClients.size && !bus.listenerCount('state')) return;
  if (Date.now() - lastPush > (eventsOk ? 5000 : 2000)) pushState(); // vangnet naast de events
  if (Date.now() - pingAt > 25000) { pingAt = Date.now(); for (const r of sseClients) r.write(': ping\n\n'); }
}, 1000).unref();

// --- UPnP-abonnementen
let notifyServer = null;
let notifyPort = 0;
const subs = new Map();     // sleutel -> { key, ip, path, sid, timer }
const sidIndex = new Map(); // SID -> sleutel
// Kort houden: een abonnement van een afgesloten app blijft anders lang hangen, en
// de speaker wacht dan bij elke melding op een time-out voor hij de rest bedient.
const SUB_SECONDS = 300;

// Een vaste poort zorgt dat abonnementen van een vorige sessie bij ons uitkomen
// (en dan netjes geweigerd worden) in plaats van te verdwijnen in de firewall.
function startNotifyServer(preferredPort = 0) {
  return new Promise(resolve => {
    notifyServer = http.createServer((req, res) => {
      if (req.method !== 'NOTIFY') { res.writeHead(404); return res.end(); }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 4e6) req.destroy(); });
      req.on('end', () => {
        const sid = req.headers.sid;
        // Onbekend abonnement (bijv. van een eerdere sessie): weigeren, dan stopt de speaker ermee.
        // Tijdens het abonneren kan de eerste melding eerder binnenkomen dan het antwoord; die accepteren we.
        if (sid && !sidIndex.has(sid) && !pendingSubs.size) { res.writeHead(412); return res.end(); }
        res.writeHead(200);
        res.end();
        onNotify(sid, body);
      });
    });
    let port = preferredPort;
    notifyServer.on('error', e => {
      if (e.code === 'EADDRINUSE' && port !== 0) { port = 0; return notifyServer.listen(0, '0.0.0.0'); }
      console.log('Live updates niet beschikbaar:', e.message);
      notifyServer = null;
      resolve(false);
    });
    notifyServer.on('listening', () => { notifyPort = notifyServer.address().port; resolve(true); });
    notifyServer.listen(port, '0.0.0.0');
  });
}

function callbackIp(speakerIp) {
  const ifs = localIPv4();
  const toInt = ip => ip.split('.').reduce((n, x) => ((n << 8) + (+x)) >>> 0, 0);
  const match = ifs.find(i => ((toInt(i.address) & toInt(i.netmask)) >>> 0) === ((toInt(speakerIp) & toInt(i.netmask)) >>> 0));
  return (match || ifs[0] || { address: '127.0.0.1' }).address;
}

function upnpRequest(ip, method, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port: 1400, path: p, method, headers, timeout: 4000 }, res => {
      res.resume();
      res.on('end', () => (res.statusCode === 200 ? resolve(res.headers) : reject(new Error(`${method} ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function subscribe(key, ip, p) {
  const h = await upnpRequest(ip, 'SUBSCRIBE', p, {
    CALLBACK: `<http://${callbackIp(ip)}:${notifyPort}/notify>`, NT: 'upnp:event', TIMEOUT: `Second-${SUB_SECONDS}`,
  });
  const s = { key, ip, path: p, sid: h.sid };
  subs.set(key, s);
  sidIndex.set(s.sid, key);
  s.timer = setTimeout(() => renew(s), (SUB_SECONDS - 60) * 1000);
  s.timer.unref();
}
async function renew(s) {
  try {
    await upnpRequest(s.ip, 'SUBSCRIBE', s.path, { SID: s.sid, TIMEOUT: `Second-${SUB_SECONDS}` });
    s.timer = setTimeout(() => renew(s), (SUB_SECONDS - 60) * 1000);
    s.timer.unref();
  } catch {
    subs.delete(s.key);
    sidIndex.delete(s.sid);
    subscribe(s.key, s.ip, s.path).catch(() => { });
  }
}
function unsubscribe(s) {
  clearTimeout(s.timer);
  subs.delete(s.key);
  sidIndex.delete(s.sid);
  return upnpRequest(s.ip, 'UNSUBSCRIBE', s.path, { SID: s.sid }).catch(() => { });
}

const pendingSubs = new Set();
async function syncSubscriptions() {
  if (!notifyPort) return;
  const want = new Map();
  const players = Object.values(topo.players);
  for (const p of players) want.set(`${p.uuid}|rc`, [p.ip, '/MediaRenderer/RenderingControl/Event']);
  for (const g of topo.groups) {
    const c = g.coordinator;
    want.set(`${c.uuid}|av`, [c.ip, '/MediaRenderer/AVTransport/Event']);
    want.set(`${c.uuid}|grc`, [c.ip, '/MediaRenderer/GroupRenderingControl/Event']);
    want.set(`${c.uuid}|cd`, [c.ip, '/MediaServer/ContentDirectory/Event']);
  }
  if (players[0]) {
    want.set('topo', [players[0].ip, '/ZoneGroupTopology/Event']);
    want.set('alarm', [players[0].ip, '/AlarmClock/Event']);
  }
  for (const [key, s] of subs) {
    const w = want.get(key);
    if (!w || w[0] !== s.ip) unsubscribe(s);
  }
  await Promise.all([...want].filter(([k]) => !subs.has(k) && !pendingSubs.has(k)).map(([k, [ip, p]]) => {
    pendingSubs.add(k);
    return subscribe(k, ip, p)
      .catch(e => console.log(`Abonneren op ${k} mislukt:`, e.message))
      .finally(() => pendingSubs.delete(k));
  }));
}

const DEBUG = !!process.env.SONOS_DEBUG;
function onNotify(sid, body) {
  eventsOk = true;
  const key = sidIndex.get(sid) || '';
  if (DEBUG) console.log(new Date().toISOString(), 'NOTIFY', key || sid, (decode(body).match(/TransportState val="([A-Z_]+)"/) || [])[1] || '');
  if (body.includes('ZoneGroupState')) {
    refreshTopology(true).then(() => scheduleStatePush(100)).catch(() => { });
    return;
  }
  if (key.endsWith('|cd') || body.includes('ContainerUpdateIDs')) {
    if (/ContainerUpdateIDs>[^<]*Q:0/.test(body)) broadcast('queue', JSON.stringify({ group: key.split('|')[0] }));
    if (body.includes('FavoritesUpdateID')) { favCache = []; broadcast('favorites', '{}'); }
    return;
  }
  if (key === 'alarm' || body.includes('AlarmListVersion')) { broadcast('alarms', '{}'); return; }
  scheduleStatePush(150);
}

function shutdown() {
  return Promise.all([...subs.values()].map(unsubscribe));
}

// ---------------------------------------------------------------- Web server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // na 'api'
  try {
    if (req.method === 'GET' && parts[0] === 'state') {
      return send(res, 200, await computeState());
    }
    if (req.method === 'GET' && parts[0] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      if (lastState) res.write(`event: state\ndata: ${lastStateJson}\n\n`);
      pushState();
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'GET' && parts[0] === 'group' && parts[2] === 'queue') {
      return send(res, 200, await getQueue(parts[1]));
    }
    if (req.method === 'GET' && parts[0] === 'player' && parts[2] === 'eq') {
      return send(res, 200, await getEq(parts[1]));
    }
    if (req.method === 'GET' && parts[0] === 'sysinfo') {
      return send(res, 200, await systemInfo());
    }
    if (req.method === 'GET' && parts[0] === 'alarms') {
      return send(res, 200, await listAlarms());
    }
    if (req.method === 'POST' && parts[0] === 'alarms' && parts[1]) {
      await setAlarmEnabled(parts[1], !!(await readBody(req)).enabled);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[0] === 'selected') {
      selectedGroup = (await readBody(req)).id || null;
      bus.emit('selected', selectedGroup);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && parts[0] === 'favorites') {
      return send(res, 200, (await loadFavorites()).map(({ uri, meta, ...f }) => f));
    }
    if (req.method === 'POST' && parts[0] === 'rescan') {
      seedIPs = [];
      topo.players = {};
      await refreshTopology(true);
      return send(res, 200, { ok: true, speakers: Object.keys(topo.players).length });
    }
    if (req.method === 'POST' && parts.length === 3 && (parts[0] === 'group' || parts[0] === 'player')) {
      const body = await readBody(req);
      await (parts[0] === 'group' ? groupAction : playerAction)(parts[1], parts[2], body);
      scheduleStatePush(250);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Niet gevonden' });
  } catch (e) {
    send(res, e.status || 502, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// Start de server. Geeft de daadwerkelijke poort terug.
// Met fallbackPort (bijv. 0 = willekeurig) wordt die gebruikt als de gewenste poort bezet is.
function start({ port = PORT, host = HOST, fallbackPort = null, configFile = null } = {}) {
  if (configFile) {
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* optioneel */ }
  }
  const notify = startNotifyServer(port ? port + 10 : 0);
  return new Promise((resolve, reject) => {
    const onError = e => {
      if (e.code === 'EADDRINUSE' && fallbackPort !== null && port !== fallbackPort) {
        port = fallbackPort;
        return server.listen(port, host);
      }
      reject(e);
    };
    server.on('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      notify.then(() => refreshTopology()).catch(e => console.log(e.message));
      resolve(server.address().port);
    });
  });
}

// Kies de groep die in de app geselecteerd is (of een logische terugval)
function pickGroup(state = lastState) {
  const groups = (state && state.groups) || [];
  return groups.find(g => g.id === selectedGroup)
    || groups.find(g => g.members.some(m => m.uuid === selectedGroup))
    || groups.find(g => g.state === 'PLAYING')
    || groups[0] || null;
}

module.exports = {
  start, shutdown, bus, groupAction, playerAction, pushState, pickGroup,
  getState: () => lastState,
};

if (require.main === module) {
  const stop = () => { shutdown().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  start().then(port => {
    console.log(`Sonos Control: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
  }).catch(e => {
    if (e.code === 'EADDRINUSE') { console.log(`Sonos Control draait al op poort ${PORT}.`); process.exit(0); }
    throw e;
  });
}
