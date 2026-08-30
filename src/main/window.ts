import { join } from 'node:path'
import { BrowserWindow, nativeImage, shell } from 'electron'

// No Linux não existe Dock para setar o ícone (como faz o index.ts no macOS) —
// sem passar `icon` aqui direto pro BrowserWindow, a janela cai no ícone
// genérico do Electron na barra de tarefas/alt-tab, mesmo com o pacote
// (electron-builder) configurado certo.
const appIcon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#f5f5f7',
    icon: appIcon.isEmpty() ? undefined : appIcon,
    // Title bar embutida no macOS, como o .windowStyle(.hiddenTitleBar) do app nativo
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // o preload usa contextBridge; node-pty vive só no main
      webviewTag: true // necessário para os nós Portal (ver §4.1 do plano de migração)
    }
  })

  win.once('ready-to-show', () => win.show())

  // Links externos abrem no navegador do sistema, nunca dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
