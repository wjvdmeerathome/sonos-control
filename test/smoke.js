'use strict';
// Rooktest: start de echte app en controleert hoofdvenster, live verbinding, instellingen,
// mini-speler en sluiten naar het systeemvak. Bewaart schermafbeeldingen.
// Gebruik: npx electron test/smoke.js [--out=map]
// Let op: gebruikt de echte instellingen van de app (userData) en zet ze na afloop terug.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.resolve(process.argv.find(a => a.startsWith('--out='))?.slice(6) || path.join(__dirname, 'out'));
fs.mkdirSync(out, { recursive: true });

require('../electron/main.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const find = part => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(part));
const log = (...a) => console.log('[smoke]', ...a);

app.whenReady().then(async () => {
  let ok = true;
  const check = (cond, msg) => { log(cond ? 'OK  ' : 'FOUT', msg); if (!cond) ok = false; };
  const js = (w, code) => w.webContents.executeJavaScript(code);
  try {
    await wait(7000);
    const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('mini.html'));
    check(main && main.isVisible(), 'hoofdvenster zichtbaar');
    fs.writeFileSync(path.join(out, 'main.png'), (await main.capturePage()).toPNG());
    check(await js(main, 'sseOk'), 'live verbinding (server-sent events) actief');
    const title = await js(main, 'document.querySelector("#title").textContent');
    check(!!title, 'hoofdvenster toont: ' + title);
    check(await js(main, '!document.querySelector("#settings-btn").hidden'), 'instellingenknop zichtbaar in app');
    check(await js(main, 'document.querySelectorAll(".q-row").length >= 0 && !!document.querySelector("#alarms .alarm, #alarms p")'), 'wekkers geladen');

    // instellingen via de echte IPC-brug
    const before = await js(main, 'window.sonosApp.getSettings()');
    log('instellingen', JSON.stringify(before));
    await js(main, 'document.querySelector("#settings-btn").click()');
    await wait(800);
    fs.writeFileSync(path.join(out, 'settings.png'), (await main.capturePage()).toPNG());
    check(await js(main, 'document.querySelector("#settings").open'), 'instellingenvenster opent');
    const version = await js(main, 'document.querySelector("#version").textContent');
    check(/versie \d/.test(version), 'versie getoond: ' + version);
    await js(main, 'document.querySelector("#settings").close()');
    const r = await js(main, 'window.sonosApp.setSetting("miniEnabled", false)');
    check(r.settings.miniEnabled === false, 'instelling wijzigen werkt');
    await js(main, `window.sonosApp.setSetting("miniEnabled", ${!!before.miniEnabled})`);

    // mini-speler
    await js(main, 'window.sonosApp.setSetting("miniEnabled", true)');
    main.minimize();
    await wait(4000);
    const mini = find('mini.html');
    check(mini && mini.isVisible(), 'mini-speler verschijnt na minimaliseren');
    if (mini) {
      fs.writeFileSync(path.join(out, 'mini.png'), (await mini.capturePage()).toPNG());
      const t = await js(mini, 'document.querySelector("#title").textContent');
      check(t && !t.startsWith('Laden'), 'mini-speler toont: ' + t);
      check(await js(mini, 'sseOk'), 'mini-speler heeft live verbinding');
      await js(mini, 'document.querySelector("#open").click()');
      await wait(1500);
      check(!main.isMinimized() && main.isVisible(), 'openen-knop herstelt hoofdvenster');
      check(!mini.isVisible(), 'mini-speler verdwijnt na herstellen');
    }
    await js(main, `window.sonosApp.setSetting("miniEnabled", ${!!before.miniEnabled})`);

    // sluiten naar systeemvak
    await js(main, 'window.sonosApp.setSetting("closeToTray", true)');
    main.close();
    await wait(1000);
    check(!main.isDestroyed() && !main.isVisible(), 'kruisje verbergt de app (draait door in systeemvak)');
    await js(main, `window.sonosApp.setSetting("closeToTray", ${!!before.closeToTray})`);
  } catch (e) {
    log('FOUT', e.stack);
    ok = false;
  }
  log(ok ? 'GESLAAGD' : 'MISLUKT', '— schermafbeeldingen in', out);
  app.exit(ok ? 0 : 1);
});
