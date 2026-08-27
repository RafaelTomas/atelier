/**
 * Ctrl/⌘+roda DENTRO de um Portal vira zoom do CANVAS.
 *
 * POR QUE PRECISA DE CÓDIGO NO MAIN: o `<webview>` é um processo separado, e
 * evento de entrada que acontece dentro do guest NÃO sobe para o DOM do host —
 * a captura de `wheel` no canvas (canvas/canvas-view.tsx), que resolve todos os
 * outros nós, é cega aqui. O único ponto que enxerga o gesto é o webContents do
 * guest, e o Chromium o entrega pronto: `zoom-changed` já diz a direção.
 *
 * POR QUE O ZOOM DA PÁGINA VOLTA A 100% A CADA EVENTO: o gesto pedido é o do
 * canvas, não o do conteúdo — e, além disso, `zoom-changed` PARA de ser emitido
 * quando o zoom do Chromium bate no próprio limite. Resetando, o guest nunca
 * chega ao limite e o gesto continua funcionando indefinidamente.
 */
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { notifyRenderer } from '../../ipc/notify'
import { guestFor, onGuestRegistered } from './portal-registry'

/** webContents já armados: `dom-ready` se repete a cada navegação. */
const armed = new Set<number>()

/** Chamado uma vez no boot, junto do resto do armamento do Portal. */
export function armPortalZoom(): void {
  onGuestRegistered((nodeId: UUID) => {
    void guestFor(nodeId).then((guest) => {
      if (!guest || armed.has(guest.id)) return
      armed.add(guest.id)
      guest.on('destroyed', () => armed.delete(guest.id))
      guest.on('zoom-changed', (_event, direction) => {
        guest.setZoomLevel(0)
        notifyRenderer('portal:zoom-gesture', { nodeId, direction })
      })
      log.debug('portal', `zoom do guest ${guest.id} redirecionado ao canvas`)
    })
  })
}
