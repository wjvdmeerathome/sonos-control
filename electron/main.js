'use strict';
// Sonos Control — Windows-app. Start de lokale Sonos-server in hetzelfde proces,
// toont de webinterface in een eigen venster, een mini-speler bij minimaliseren,
// een icoon in het systeemvak, mediatoetsen en automatische updates.

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const sonos = require('../server');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const MINI = { width: 380, height: 104, margin: 16 };
const START_HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('nl.wjvdmeer.sonos-control');

let base = null;
let mainWin = null;
let miniWin = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------- instellingen en vensterpositie
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const DEFAULTS = { miniEnabled: true, mediaKeys: true, volumeKeys: false, autoStart: false, closeToTray: true };
let winState = {};
function loadState() {
  try { winState = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { winState = {}; }
  winState.settings = { ...DEFAULTS, ...(winState.settings || {}) };
  if (winState.miniDisabled) { winState.settings.miniEnabled = false; delete winState.miniDisabled; } // oude versie
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(stateFile(), JSON.stringify(winState, null, 2)); } catch { /* niet erg */ }
  }, 300);
}
const settings = () => winState.settings;
function onScreen(b) {
  return b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x >= a.x - 50 && b.y >= a.y - 10 && b.x + Math.min(b.width, 200) <= a.x + a.width + 50 && b.y + 40 <= a.y + a.height;
  });
}

// ---------------------------------------------------------------- hoofdvenster
function createMain(show = true) {
  const bounds = onScreen(winState.main) ? winState.main : { width: 1180, height: 820 };
  mainWin = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 520,
    title: 'Sonos Control',
    icon: ICON,
    backgroundColor: '#0f1012',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: PRELOAD },
  });
  mainWin.removeMenu();
  if (winState.maximized) mainWin.maximize();
  mainWin.loadURL(base + '/');
  if (show) mainWin.once('ready-to-show', () => mainWin.show());

  mainWin.on('minimize', showMini);
  mainWin.on('restore', hideMini);
  mainWin.on('show', hideMini);
  mainWin.on('focus', hideMini);

  const remember = () => {
    if (mainWin.isMinimized()) return;
    winState.maximized = mainWin.isMaximized();
    if (!winState.maximized) winState.main = mainWin.getBounds();
    saveState();
  };
  mainWin.on('resize', remember);
  mainWin.on('move', remember);

  mainWin.on('close', e => {
    if (quitting || !settings().closeToTray) return;
    e.preventDefault();
    mainWin.hide();
    if (!winState.trayHintShown && tray) {
      winState.trayHintShown = true;
      saveState();
      tray.displayBalloon({
        iconType: 'info',
        title: 'Sonos Control draait verder',
        content: 'Je vindt de app bij de klok. Afsluiten kan via het icoon (rechtermuisknop).',
      });
    }
  });
  mainWin.on('closed', () => { mainWin = null; if (!quitting) app.quit(); });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showMainWindow() {
  if (!mainWin) return createMain(true);
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// ---------------------------------------------------------------- mini-speler
function miniPosition() {
  const saved = winState.mini && { ...winState.mini, ...MINI };
  if (onScreen(saved)) return { x: saved.x, y: saved.y };
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - MINI.width - MINI.margin, y: a.y + a.height - MINI.height - MINI.margin };
}

function createMini() {
  miniWin = new BrowserWindow({
    width: MINI.width,
    height: MINI.height,
    ...miniPosition(),
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Sonos mini-speler',
    icon: ICON,
    backgroundColor: '#17181b',
    webPreferences: { preload: PRELOAD },
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.loadURL(base + '/mini.html');
  miniWin.on('moved', () => {
    const [x, y] = miniWin.getPosition();
    winState.mini = { x, y };
    saveState();
  });
  miniWin.on('closed', () => { miniWin = null; });
}

function showMini(force = false) {
  if (!settings().miniEnabled && force !== true) return;
  if (!miniWin) {
    createMini();
    miniWin.once('ready-to-show', () => miniWin && miniWin.showInactive());
  } else {
    miniWin.showInactive();
  }
}
function hideMini() {
  if (miniWin && miniWin.isVisible()) miniWin.hide();
}

// ---------------------------------------------------------------- Sonos-bediening vanuit het hoofdproces
const isPlaying = g => g && (g.state === 'PLAYING' || g.state === 'TRANSITIONING');
const queueSource = g => g && g.source === 'music' && !g.empty;

async function control(action, body = {}) {
  const g = sonos.pickGroup();
  if (!g) return;
  try {
    await sonos.groupAction(g.id, action, body);
  } catch (e) {
    console.log('Bediening mislukt:', e.message);
  }
  setTimeout(() => sonos.pushState(), 250);
}
const togglePlay = () => { const g = sonos.pickGroup(); if (g) control(isPlaying(g) ? 'pause' : 'play'); };

// Volumetoetsen: bij snel achter elkaar drukken verder tellen vanaf de laatst gezette waarde
let volTarget = null;
function nudgeVolume(delta) {
  const g = sonos.pickGroup();
  if (!g) return;
  const baseVol = volTarget && Date.now() - volTarget.at < 2000 && volTarget.id === g.id ? volTarget.v : g.volume;
  const v = Math.max(0, Math.min(100, baseVol + delta));
  volTarget = { id: g.id, v, at: Date.now() };
  control('volume', { volume: v });
}

// ---------------------------------------------------------------- mediatoetsen
function applyShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  const reg = (key, fn) => { if (!globalShortcut.register(key, fn)) failed.push(key); };
  if (settings().mediaKeys) {
    reg('MediaPlayPause', togglePlay);
    reg('MediaNextTrack', () => control('next'));
    reg('MediaPreviousTrack', () => control('previous'));
    reg('MediaStop', () => control('pause'));
  }
  if (settings().volumeKeys) {
    reg('VolumeUp', () => nudgeVolume(2));
    reg('VolumeDown', () => nudgeVolume(-2));
    reg('VolumeMute', () => { const g = sonos.pickGroup(); if (g) control('mute', { mute: !g.mute }); });
  }
  return failed;
}

// ---------------------------------------------------------------- starten met Windows
function applyAutoStart() {
  if (!app.isPackaged) return 'Starten met Windows werkt alleen in de geïnstalleerde app.';
  app.setLoginItemSettings({ openAtLogin: !!settings().autoStart, args: ['--hidden'] });
  return null;
}

// ---------------------------------------------------------------- systeemvak
let traySig = '';
function trayImage() {
  return nativeImage.createFromPath(ICON).resize({ width: 32, height: 32, quality: 'best' });
}

function updateTray(force = false) {
  if (!tray) return;
  const g = sonos.pickGroup();
  const playing = isPlaying(g);
  const t = g && g.track ? g.track : {};
  const now = g ? (g.empty ? 'Niets aan het afspelen' : [t.title, t.artist].filter(Boolean).join(' — ')) : 'Geen speakers gevonden';
  const s = settings();
  const sig = JSON.stringify([g && g.id, g && g.name, now, playing, queueSource(g), s, updateStatus.state]);
  if (!force && sig === traySig) return;
  traySig = sig;

  tray.setToolTip(`Sonos Control\n${g ? g.name + ': ' : ''}${now}`.slice(0, 127));
  const live = g && (g.source === 'radio' || g.source === 'tv');
  const toggle = (label, key, apply) => ({
    label, type: 'checkbox', checked: !!s[key],
    click: item => { setSetting(key, item.checked); if (apply) apply(); },
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: (g ? `${g.name}: ${now}` : now).slice(0, 60), enabled: false },
    { type: 'separator' },
    { label: playing ? (live ? 'Stoppen' : 'Pauzeren') : 'Afspelen', enabled: !!g, click: togglePlay },
    { label: 'Volgende', enabled: queueSource(g), click: () => control('next') },
    { label: 'Vorige', enabled: queueSource(g), click: () => control('previous') },
    { type: 'separator' },
    { label: 'Sonos Control openen', click: showMainWindow },
    { label: 'Mini-speler tonen', click: () => { if (mainWin && mainWin.isVisible() && !mainWin.isMinimized()) mainWin.minimize(); showMini(true); } },
    { type: 'separator' },
    toggle('Mini-speler bij minimaliseren', 'miniEnabled'),
    toggle('Mediatoetsen bedienen Sonos', 'mediaKeys'),
    toggle('Volumetoetsen bedienen Sonos', 'volumeKeys'),
    toggle('Starten met Windows', 'autoStart'),
    toggle('Sluiten naar systeemvak', 'closeToTray'),
    { type: 'separator' },
    ...(updateStatus.state === 'downloaded'
      ? [{ label: `Update naar ${updateStatus.version} installeren`, click: installUpdate }]
      : [{ label: 'Controleren op updates', click: checkForUpdates }]),
    { label: 'Afsluiten', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', () => {
    if (mainWin && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused()) mainWin.hide();
    else showMainWindow();
  });
  updateTray(true);
}

// ---------------------------------------------------------------- instellingen wijzigen
function setSetting(key, value) {
  if (!(key in DEFAULTS)) return { settings: settings() };
  settings()[key] = !!value;
  let message = null;
  if (key === 'mediaKeys' || key === 'volumeKeys') {
    const failed = applyShortcuts();
    if (failed.length) {
      settings()[key] = false;
      applyShortcuts();
      message = 'Deze toetsen zijn al in gebruik door een ander programma.';
    } else if (key === 'volumeKeys' && value) {
      message = 'De volumetoetsen regelen nu Sonos in plaats van je pc.';
    }
  }
  if (key === 'autoStart') {
    message = applyAutoStart();
    if (message) settings().autoStart = false;
  }
  if (key === 'miniEnabled' && !value) hideMini();
  saveState();
  updateTray(true);
  return { settings: settings(), message };
}

// ---------------------------------------------------------------- automatische updates
let updateStatus = { state: 'idle', text: '' };
let autoUpdater = null;
function setUpdate(s) {
  updateStatus = s;
  if (mainWin) mainWin.webContents.send('update-status', s);
  if (s.state === 'downloaded' && tray) {
    tray.displayBalloon({ iconType: 'info', title: 'Update klaar', content: `Versie ${s.version} wordt geïnstalleerd zodra je de app afsluit.` });
  }
  updateTray(true);
}
function initUpdater() {
  if (!app.isPackaged) return;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking', text: 'Controleren op updates…' }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'none', text: 'Je hebt de nieuwste versie.' }));
  autoUpdater.on('update-available', i => setUpdate({ state: 'downloading', version: i.version, text: `Versie ${i.version} wordt gedownload…` }));
  autoUpdater.on('download-progress', p => setUpdate({ ...updateStatus, text: `Versie ${updateStatus.version || ''} wordt gedownload… ${Math.round(p.percent)}%` }));
  autoUpdater.on('update-downloaded', i => setUpdate({ state: 'downloaded', version: i.version, text: `Versie ${i.version} staat klaar om te installeren.` }));
  autoUpdater.on('error', e => setUpdate({ state: 'error', text: 'Controleren op updates mislukt: ' + String(e && e.message || e).split('\n')[0].slice(0, 120) }));
  setTimeout(checkForUpdates, 10000);
  setInterval(checkForUpdates, 6 * 3600 * 1000).unref();
}
function checkForUpdates() {
  if (!autoUpdater) return setUpdate({ state: 'dev', text: 'Updates werken alleen in de geïnstalleerde app.' });
  if (updateStatus.state === 'downloading' || updateStatus.state === 'downloaded') return setUpdate(updateStatus);
  autoUpdater.checkForUpdates().catch(() => { /* afgehandeld via 'error' */ });
}
function installUpdate() {
  if (!autoUpdater || updateStatus.state !== 'downloaded') return;
  quitting = true;
  sonos.shutdown().finally(() => autoUpdater.quitAndInstall(true, true));
}

// ---------------------------------------------------------------- IPC
ipcMain.on('show-main', showMainWindow);
ipcMain.on('hide-mini', hideMini);
ipcMain.handle('get-settings', () => settings());
ipcMain.handle('set-setting', (e, key, value) => setSetting(key, value));
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('get-update-status', () => updateStatus);
ipcMain.on('check-updates', checkForUpdates);
ipcMain.on('install-update', installUpdate);

// ---------------------------------------------------------------- start en afsluiten
app.on('second-instance', showMainWindow);
app.on('window-all-closed', () => { /* blijft draaien in het systeemvak */ });

let cleanedUp = false;
app.on('before-quit', e => {
  quitting = true;
  if (cleanedUp) return;
  // Speakers netjes laten weten dat we geen meldingen meer willen
  e.preventDefault();
  cleanedUp = true;
  globalShortcut.unregisterAll();
  Promise.race([sonos.shutdown(), new Promise(r => setTimeout(r, 1500))]).finally(() => app.quit());
});

app.whenReady().then(async () => {
  loadState();
  const port = await sonos.start({
    port: 8421,
    host: '127.0.0.1',
    fallbackPort: 0,
    configFile: path.join(app.getPath('userData'), 'config.json'),
  });
  base = `http://127.0.0.1:${port}`;
  sonos.bus.on('state', () => updateTray());
  sonos.bus.on('selected', () => updateTray());
  createTray();
  createMain(!START_HIDDEN);
  const failed = applyShortcuts();
  if (failed.length) console.log('Sneltoetsen niet beschikbaar:', failed.join(', '));
  if (app.isPackaged && settings().autoStart) applyAutoStart();
  initUpdater();
  sonos.pushState();
});
