const { app, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')

/**
 * Updates, which is one promise: what you push is what runs, without anyone
 * fetching anything. The feed is the GitHub release built by CI
 * (electron-builder's `publish` block writes the `latest*.yml` that this reads).
 *
 * Deliberately quiet. An update downloads in the background and says nothing
 * until it is ready, because a dialog that interrupts to announce a download is
 * a dialog that trains people to dismiss dialogs. The one question it asks is
 * the only one with an answer: restart now, or keep working.
 */

// Six hours. Long enough that a day of work sees one or two checks, short
// enough that a machine left running for a week is not a week behind.
const EVERY = 6 * 60 * 60 * 1000

let pending = null

function ask(win, info) {
  // Coalesced on purpose: with a check every six hours, a long-running window
  // can be offered the same build repeatedly, and each refusal should last.
  if (pending === info.version) return
  pending = info.version

  dialog
    .showMessageBox(win ?? undefined, {
      type: 'info',
      buttons: ['Redémarrer', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      message: 'Cockpit ' + info.version + ' est prête',
      detail:
        'La mise à jour est téléchargée. Redémarrer installe la nouvelle version ; ' +
        'elle s’installera de toute façon au prochain démarrage.\n\n' +
        'Le noyau tourne indépendamment de la fenêtre : ce qu’il exécute ne s’arrête pas ici.',
    })
    .then(({ response }) => {
      if (response !== 0) return
      // Not app.quit(): the whole point of quitAndInstall is that it runs the
      // installer after the app is gone rather than racing it.
      autoUpdater.quitAndInstall()
    })
}

function startUpdater(getWindow) {
  // Unpackaged there is no version to compare against and no installer to run;
  // electron-updater would only complain about a missing app-update.yml.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => ask(getWindow(), info))

  /**
   * Failures are logged and swallowed, never surfaced. Every one of them is a
   * condition the app can keep running under — offline, a release that has not
   * finished uploading, and on macOS an unsigned build, which Squirrel.Mac
   * refuses outright until there is a Developer ID to sign with. None of those
   * is a reason to put a dialog in front of someone.
   */
  autoUpdater.on('error', (err) => {
    console.error('[cockpit] update check failed: ' + (err?.message ?? err))
  })

  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  // Not at ready: launch is the one moment the app owes the person a window,
  // and a feed fetch on that path competes with it for nothing.
  setTimeout(check, 10_000)
  setInterval(check, EVERY)
}

module.exports = { startUpdater }
