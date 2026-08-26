/**
 * O que acontece quando a página dentro de um Portal abre uma janela.
 *
 * ANTES DISTO NÃO ACONTECIA NADA. O `setWindowOpenHandler` de window.ts está no
 * webContents da JANELA, e o `<webview>` roda num guest separado que não herda
 * handler nenhum do host. Sem `allowpopups`, o Electron nega o popup em silêncio
 * — o evento `new-window` do elemento foi removido na v22. O clique em "Ver
 * painel" caía no vazio: nem dentro do app, nem no navegador do sistema.
 *
 * O padrão agora é o popup virar nó no canvas, ligado ao pai pelo cabo
 * portal↔portal, HERDANDO A PARTIÇÃO — sem isso ele nasceria deslogado, que é o
 * mesmo que não funcionar (Decisão B do PLANO-portal.md).
 */
import { shell } from 'electron'
import { log } from '../logger'
import { appState } from '../state/app-state'
import { guestFor, onGuestRegistered } from './portal-registry'
import { partitionOf, spawnPortal } from './portal-spawn'

/** Esquemas que a página pode pedir para abrir e que o app trata sozinho. */
function isWeb(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Chamado uma vez no boot. A partir daí todo guest novo já nasce tratado. */
export function armPopupHandling(): void {
  onGuestRegistered((nodeId) => {
    void (async () => {
      const guest = await guestFor(nodeId)
      if (!guest) return

      guest.setWindowOpenHandler(({ url }) => {
        // mailto:, tel:, e qualquer esquema de app: só o sistema sabe abrir.
        if (!isWeb(url)) {
          void shell.openExternal(url).catch(() => undefined)
          return { action: 'deny' }
        }

        switch (appState.preferences.portalPopups) {
          case 'system':
            void shell.openExternal(url).catch(() => undefined)
            break
          case 'same':
            void guest.loadURL(url).catch(() => undefined)
            break
          default: {
            const spawned = spawnPortal({ originId: nodeId, url, partition: partitionOf(nodeId) })
            if (!spawned) {
              // Nó fora de qualquer workspace: não sumir com o clique do usuário
              log.warn('portal', 'popup sem workspace de origem — abrindo no sistema')
              void shell.openExternal(url).catch(() => undefined)
            }
          }
        }

        // Sempre deny: a janela nativa do Electron nunca é a resposta certa aqui.
        return { action: 'deny' }
      })
    })()
  })
}
