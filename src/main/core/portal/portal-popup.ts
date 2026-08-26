/**
 * O que acontece quando a página dentro de um Portal abre uma janela.
 *
 * ANTES DISTO NÃO ACONTECIA NADA. O `setWindowOpenHandler` de window.ts está no
 * webContents da JANELA, e o `<webview>` roda num guest separado que não herda
 * handler nenhum do host. E popup em webview vem desligado de fábrica
 * ("Popups are disabled by default", na doc do atributo `allowpopups`): o pedido
 * morria antes de chegar em qualquer handler nosso. O clique em "Ver painel"
 * caía no vazio — nem dentro do app, nem no navegador do sistema.
 *
 * São DUAS peças, e as duas são necessárias:
 *   1. `allowpopups` no <webview>, para o pedido chegar até aqui;
 *   2. este handler, que nega a janela nativa e devolve um nó no canvas.
 *
 * Sem (1) não somos chamados. Sem (2), `allowpopups` abriria exatamente a janela
 * solta que o app nunca quis.
 *
 * O armamento é em `web-contents-created`, não no registro do nó: uma página que
 * chama window.open enquanto carrega não pode escapar pela fresta entre o guest
 * nascer e o renderer dizer de quem ele é.
 */
import type { WebContents } from 'electron'
import { app, shell } from 'electron'
import { log } from '../logger'
import { appState } from '../state/app-state'
import { guestFor, nodeIdForGuest, onGuestRegistered } from './portal-registry'
import { partitionOf, spawnPortal } from './portal-spawn'

/** Esquemas que o app trata sozinho; o resto é assunto do sistema. */
function isWeb(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function toSystem(url: string): void {
  void shell.openExternal(url).catch(() => undefined)
}

/**
 * Idempotente de propósito: `setWindowOpenHandler` substitui o anterior, e o
 * guest view manager do Electron arma o dele no attach. Armar duas vezes — na
 * criação e no registro do nó, que vem depois — garante que o último a falar
 * seja este.
 */
function armGuest(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const nodeId = nodeIdForGuest(contents.id)
    const mode = appState.preferences.portalPopups
    log.info('portal', `popup ${disposition} → ${url} (nó ${nodeId?.slice(0, 8) ?? '?'}, modo ${mode})`)

    if (!isWeb(url)) {
      // mailto:, tel:, esquema de app: só o sistema sabe abrir
      toSystem(url)
      return { action: 'deny' }
    }

    // Guest ainda sem dono (window.open durante o carregamento, antes do
    // dom-ready): não dá para criar o nó no lugar certo, e perder o clique do
    // usuário é pior que abrir fora.
    if (!nodeId) {
      log.warn('portal', 'popup de um guest ainda não registrado — abrindo no sistema')
      toSystem(url)
      return { action: 'deny' }
    }

    switch (mode) {
      case 'system':
        toSystem(url)
        break
      case 'same':
        void contents.loadURL(url).catch(() => undefined)
        break
      default: {
        if (!spawnPortal({ originId: nodeId, url, partition: partitionOf(nodeId) })) {
          log.warn('portal', 'popup sem workspace de origem — abrindo no sistema')
          toSystem(url)
        }
      }
    }

    // Sempre deny: janela nativa solta dentro do app nunca é a resposta certa.
    return { action: 'deny' }
  })
}

/** Chamado uma vez no boot, antes da janela existir. */
export function armPopupHandling(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') armGuest(contents)
  })

  onGuestRegistered((nodeId) => {
    void guestFor(nodeId).then((guest) => {
      if (guest) armGuest(guest)
    })
  })
}
