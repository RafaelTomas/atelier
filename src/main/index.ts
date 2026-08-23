/**
 * Entrada do processo main — porte de OpenMaestriApp.swift + AppDelegate.swift.
 *
 * A ORDEM DE BOOT É FIXA, pelos mesmos motivos do app nativo:
 *
 *   1. Servidor IPC  — antes de qualquer terminal existir, senão há corrida
 *                      com port = 0 e o atelier nasce sem endereço
 *   2. CLI + skill   — idempotente, em paralelo, não bloqueia
 *   3. AppState      — lê os três JSON raiz em paralelo
 *   4. Janela        — só depois que o estado está em memória
 */
import { app, BrowserWindow } from 'electron'
import { log } from './core/logger'
import { installCLI } from './core/interagent/cli-install'
import { interAgentServer } from './core/interagent/server'
import { installSkillsIfNeeded } from './core/connection/skill-injector'
import { appState } from './core/state/app-state'
import { terminals } from './core/terminal/terminal-manager'
import { registerIPC } from './ipc/bridge'
import { createMainWindow } from './window'

// Instância única: dois processos disputando o mesmo socket IPC quebram o CLI
if (!app.requestSingleInstanceLock()) {
  log.warn('boot', 'outra instância já está rodando — encerrando esta')
  app.quit()
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

async function boot(): Promise<void> {
  const started = Date.now()

  // 1. IPC primeiro, sempre
  try {
    await interAgentServer.start()
    terminals.setServerPort(interAgentServer.port)
  } catch (err) {
    log.error('boot', 'InterAgentServer não subiu — o atelier ficará indisponível', err)
  }

  // 2. CLI e skill em background (não bloqueiam o boot)
  void installCLI()
  void installSkillsIfNeeded()

  // 3. Estado
  await appState.loadOnLaunch()
  appState.startAutosave()

  // 4. UI
  registerIPC()
  createMainWindow()

  log.info('boot', `pronto em ${Date.now() - started}ms`)
}

app.whenReady().then(boot).catch((err) => {
  log.error('boot', 'falha fatal no boot', err)
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.on('window-all-closed', () => {
  // No macOS o app segue vivo sem janela; nos outros, encerra
  if (process.platform !== 'darwin') app.quit()
})

// ─── Shutdown gracioso ────────────────────────────────────────────────────────
// Espelha applicationShouldTerminate: adia a saída, grava tudo, então sai.

let shuttingDown = false

app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true

  void (async () => {
    try {
      interAgentServer.stop()
      terminals.killAll()
      await appState.shutdown()
    } catch (err) {
      log.error('boot', 'erro no shutdown', err)
    } finally {
      app.exit(0)
    }
  })()
})
