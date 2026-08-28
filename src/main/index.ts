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
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, safeStorage } from 'electron'
import { log } from './core/logger'
import { Constants } from './core/constants'
import { persistence } from './core/persistence/persistence-manager'
import { dataDir, isOverriddenHome } from './core/persistence/paths'
import { installCLI } from './core/interagent/cli-install'
import { interAgentServer } from './core/interagent/server'
import { installSkillsIfNeeded } from './core/connection/skill-injector'
import { appState } from './core/state/app-state'
import { scanOnLaunch } from './core/projects/scan-controller'
import { terminals } from './core/terminal/terminal-manager'
import { fileWatcher } from './core/projects/file-watcher'
import { armPopupHandling } from './core/portal/portal-popup'
import { armPortalZoom } from './core/portal/portal-zoom'
import { armPortalCDP } from './core/portal/portal-cdp'
import { useSafeStorage } from './core/vault/crypto'
import { registerIPC } from './ipc/bridge'
import { createMainWindow } from './window'

/**
 * Antes de qualquer coisa: é este nome que aparece no menu do macOS e que o
 * Electron usa para o diretório de perfil do Chromium. O nome do app
 * EMPACOTADO vem do productName do electron-builder; em dev o Dock mostra o
 * bundle do node_modules, renomeado por scripts/fix-native-deps.mjs.
 */
app.setName('Atelier')

/**
 * O UA que o Chromium do Electron manda de fábrica carrega dois tokens que
 * navegador nenhum tem: o nome/versão do app (`Atelier/0.1.0`) e
 * `Electron/31.7.7`. Sites que fazem sniffing de browser — WhatsApp Web é o
 * caso que apareceu — não reconhecem essa string e mandam "atualize para o
 * Chrome 100 ou posterior", mesmo rodando sobre um Chromium bem mais novo que
 * isso. Tirar os dois tokens deixa um UA de Chrome legítimo, com a versão real
 * do Chromium embutido.
 *
 * `userAgentFallback` vale para TODAS as sessões, inclusive as partitions dos
 * <webview> dos Portais, que é onde isso importa. Precisa ser setado antes de
 * qualquer webContents nascer.
 */
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/[\d.]+/, '')
  .replace(new RegExp(` ${app.getName()}\\/[\\d.]+`, 'i'), '')

/**
 * Dev e produção lado a lado: o lock de instância única do Electron é indexado
 * pelo diretório `userData`, então sem separá-lo a instância de `npm run dev`
 * (que roda sobre um `ATELIER_HOME`) bate de frente com a produção e uma das
 * duas fecha no boot. Apontar o `userData` para dentro do próprio `ATELIER_HOME`
 * dá a cada instância a sua trava e o seu perfil do Chromium. Precisa vir antes
 * de `requestSingleInstanceLock()`, e não muda nada para quem roda no caminho
 * padrão. O named pipe do IPC recebe o mesmo tratamento em paths.ts.
 */
if (isOverriddenHome()) {
  app.setPath('userData', join(dataDir(), 'chromium'))
}

// Em dev o ícone do Dock é o do bundle do Electron; se o postinstall não
// conseguiu trocá-lo (máquina sem sips/iconutil, por exemplo), este é o plano B.
if (!app.isPackaged && process.platform === 'darwin') {
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

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

/** Tempo depois da janela abrir. Não é precisão, é cortesia com o primeiro paint. */
const LAUNCH_SCAN_DELAY_MS = 2000

async function boot(): Promise<void> {
  const started = Date.now()

  // 0. A cripto do cofre. Injetada em vez de importada lá dentro: o núcleo é
  //    bundlado sem Electron nos testes headless, e um import de `electron` no
  //    persistence-manager quebraria o bundle inteiro. Sem chaveiro do SO isto
  //    continua sendo chamado — e `vaultEncryptionAvailable()` responde false,
  //    que é o estado bloqueado do nó.
  useSafeStorage(safeStorage)

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

  // Colagens de imagem no terminal viram arquivo temporário; varre as antigas.
  void persistence
    .cleanTempDir(Constants.imageTmpMaxAgeMs)
    .catch((err) => log.warn('boot', 'limpeza de tmp falhou', err))

  // 4. UI
  registerIPC()
  // Popup de dentro de um portal vira nó no canvas. Antes da janela: o handler
  // é armado quando o guest se registra, e isso pode acontecer no primeiro paint.
  armPopupHandling()
  // Ctrl+roda dentro da página do portal dá zoom no canvas, não na página.
  armPortalZoom()
  // Nó desmontado pelo culling leva a sessão CDP junto — sem isso o controle
  // ficaria pendurado num webContents morto (Decisão D do controle de portal).
  armPortalCDP()
  createMainWindow()

  log.info('boot', `pronto em ${Date.now() - started}ms`)

  // 5. Procurar projetos novos — depois da janela, e sem bloquear nada. O
  //    atraso é para a varredura não disputar disco com o primeiro paint e com
  //    a leitura dos scrollbacks; ela leva dezenas de ms, mas o boot é o pior
  //    momento possível para tirar I/O de quem está desenhando a tela.
  if (appState.preferences.autoScanOnLaunch) {
    setTimeout(() => {
      void scanOnLaunch().catch((err) => log.error('scan', 'varredura de boot falhou', err))
    }, LAUNCH_SCAN_DELAY_MS)
  }
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
      await fileWatcher.closeAll()
      await appState.shutdown()
    } catch (err) {
      log.error('boot', 'erro no shutdown', err)
    } finally {
      app.exit(0)
    }
  })()
})
