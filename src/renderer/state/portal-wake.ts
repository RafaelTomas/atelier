/**
 * Portais acordados sob demanda.
 *
 * Um portal só existe como processo enquanto o `<webview>` está montado — e ele
 * é desmontado em duas situações: zoom abaixo do congelamento e nó fora da
 * viewport. Quando o agente pede para ler a página, o main manda `portal:wake` e
 * o nó precisa montar mesmo estando nas duas situações.
 *
 * POR QUE ESTE MÓDULO NÃO VIVE DENTRO DO PortalNode: um nó desmontado não tem
 * como escutar o pedido para se montar. A assinatura precisa estar num lugar que
 * está sempre vivo.
 *
 * A liberação é por tempo: sem ela, uma leitura deixaria um processo de
 * renderização vivo para sempre num canto do canvas que ninguém está olhando.
 */
import type { UUID } from '@shared/types'

/** Quanto tempo um nó fica de pé depois de acordado. */
const AWAKE_MS = 30_000

const awake = new Map<UUID, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const cb of listeners) cb()
}

export const portalWake = {
  has(nodeId: UUID): boolean {
    return awake.has(nodeId)
  },

  /** Acorda (ou renova) — devolve true se o conjunto mudou. */
  keep(nodeId: UUID): void {
    const running = awake.get(nodeId)
    if (running) clearTimeout(running)
    awake.set(nodeId, setTimeout(() => portalWake.release(nodeId), AWAKE_MS))
    if (!running) emit()
  },

  release(nodeId: UUID): void {
    const running = awake.get(nodeId)
    if (!running) return
    clearTimeout(running)
    awake.delete(nodeId)
    emit()
  },

  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
}

/** Chamado uma vez, na montagem do app. */
export function listenForPortalWake(): () => void {
  return window.atelier.portal.onWake(({ nodeId }) => portalWake.keep(nodeId))
}
