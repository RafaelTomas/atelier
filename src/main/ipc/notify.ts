/**
 * Push do main para o renderer.
 *
 * Módulo separado (e sem imports do core) de propósito: qualquer camada pode
 * notificar a UI sem criar dependência circular com a janela.
 */
export type RendererEvent =
  | 'workspace:changed'
  | 'note:changed'
  | 'connection:status'
  | 'terminal:data'
  | 'terminal:exit'
  | 'terminal:status'
  | 'project:scan-progress'
  | 'project:scan-done'
  | 'project:changed'

/**
 * Import dinâmico do electron: fora do app (teste headless, CI) isto vira um
 * no-op silencioso em vez de quebrar a importação do núcleo inteiro.
 */
export function notifyRenderer(channel: RendererEvent, payload: unknown): void {
  void import('electron')
    .then(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
    })
    .catch(() => undefined)
}
