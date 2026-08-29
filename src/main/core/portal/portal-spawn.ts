/**
 * Criar nó Portal a partir do main — o que o popup (Etapa 2) e o
 * `atelier portal open` (Etapa 5) têm em comum.
 *
 * Molde: o createNote de interagent/handlers/note.ts. Nó ao lado do pai,
 * conectado a ele, e um notifyRenderer no fim — o main é dono do estado, o
 * renderer só redesenha.
 */
import type { CanvasNode, PortalContent, UUID } from '@shared/types'
import { portalPartition } from '@shared/types'
import { notifyRenderer } from '../../ipc/notify'
import { makePortalContent } from '../models/node-content'
import { makeCanvasNode } from '../models/workspace'
import { appState } from '../state/app-state'
import type { WorkspaceManager } from '../state/workspace-manager'
import { freeSpotRightOf } from '../spawn-spot'

const PORTAL_SIZE = { width: 640, height: 440 }

/** O workspace que contém este nó — não necessariamente o ativo. */
export function workspaceForNode(nodeId: UUID): WorkspaceManager | null {
  for (const ws of appState.workspaces.values()) {
    if (ws.node(nodeId)) return ws
  }
  return null
}

interface SpawnOptions {
  /** Nó de onde o portal nasce: o pai do popup, ou o terminal que pediu. */
  originId: UUID
  url: string
  name?: string
  /**
   * Partição a herdar. Vinda do portal pai, é o que mantém o popup logado —
   * ver Decisão B do 2026-08-26-PLANO-portal.md.
   */
  partition?: string
}

/** Devolve o nó criado, ou null se a origem não estiver em workspace nenhum. */
export function spawnPortal(opts: SpawnOptions): { node: CanvasNode; workspaceId: UUID } | null {
  const ws = workspaceForNode(opts.originId)
  if (!ws) return null
  const origin = ws.node(opts.originId)
  if (!origin) return null

  const content: PortalContent = makePortalContent(opts.name ?? 'Portal', opts.url)
  if (opts.partition) content.storageScope = opts.partition

  const spot = freeSpotRightOf(ws, origin, PORTAL_SIZE)
  const node = makeCanvasNode({ ...spot, ...PORTAL_SIZE }, { type: 'portal', value: content })

  ws.addNode(node)
  // Portal→portal e terminal→portal já são tipos de conexão conhecidos; o cabo
  // sai de graça e mostra no canvas de onde aquela janela veio.
  ws.addConnection(opts.originId, node.id)

  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return { node, workspaceId: ws.id }
}

/** A partição do portal de origem, quando a origem for um portal. */
export function partitionOf(nodeId: UUID): string | undefined {
  const ws = workspaceForNode(nodeId)
  const node = ws?.node(nodeId)
  if (!node || node.content.type !== 'portal') return undefined
  return portalPartition(node.content.value)
}
