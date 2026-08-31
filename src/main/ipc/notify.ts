/**
 * Push do main para o renderer.
 *
 * Módulo separado (e sem imports do core) de propósito: qualquer camada pode
 * notificar a UI sem criar dependência circular com a janela.
 */
export type RendererEvent =
  | 'workspace:changed'
  | 'note:changed'
  | 'table:changed'
  // O quadro de TODO mudou POR FORA — pelo `atelier todo` de um agente. Sem
  // este empurrão o nó mostraria o quadro de antes até alguém mexer nele, e o
  // ponto da feature é ver o cartão andar enquanto o agente trabalha.
  | 'todo:changed'
  | 'vault:changed'
  | 'connection:status'
  | 'terminal:data'
  | 'terminal:exit'
  | 'terminal:status'
  // A leitura que o PRÓPRIO agente publica (statusLine do Claude Code), em vez
  // da raspada da tela. Ver core/terminal/status-line.ts.
  | 'terminal:usage'
  | 'codex:account'
  | 'project:scan-progress'
  | 'project:scan-done'
  | 'project:changed'
  | 'project:candidates'
  | 'fs:file-changed'
  | 'fs:file-removed'
  | 'portal:wake'
  | 'portal:zoom-gesture'
  | 'portal:action'
  // Amostra de recursos da máquina. Alta frequência (a cada 2s) e por isso NÃO
  // passa pela store do renderer — ver use-system-stats.ts.
  | 'system:stats'
  /**
   * A máquina voltou de uma suspensão. NÃO é um serviço de tempo no main — é um
   * sinal, sem estado e sem registro: quem reconcilia relógios é o coordenador
   * do renderer, que é onde os nós e os cabos moram. Unir isso ao relógio num
   * serviço entre processos custaria IPC de registro, política de shutdown e uma
   * abstração genérica para dois consumidores com necessidades diferentes.
   */
  | 'system:resume'

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
