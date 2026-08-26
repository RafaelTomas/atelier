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

const PORTAL_SIZE = { width: 640, height: 440 }
/** Folga entre o pai e o filho, e passo da cascata quando há sobreposição. */
const GAP = 60
const CASCADE_STEP = 40
const CASCADE_TRIES = 12

/** O workspace que contém este nó — não necessariamente o ativo. */
export function workspaceForNode(nodeId: UUID): WorkspaceManager | null {
  for (const ws of appState.workspaces.values()) {
    if (ws.node(nodeId)) return ws
  }
  return null
}

function overlaps(ws: WorkspaceManager, x: number, y: number): boolean {
  return ws.nodes.some(
    (n) =>
      x < n.frame.x + n.frame.width &&
      x + PORTAL_SIZE.width > n.frame.x &&
      y < n.frame.y + n.frame.height &&
      y + PORTAL_SIZE.height > n.frame.y
  )
}

/**
 * Posição livre à direita da origem. Dois popups seguidos não podem nascer
 * empilhados — o segundo ficaria invisível debaixo do primeiro.
 */
function freeSpotRightOf(ws: WorkspaceManager, origin: CanvasNode): { x: number; y: number } {
  const x = origin.frame.x + origin.frame.width + GAP
  const y = origin.frame.y
  for (let i = 0; i < CASCADE_TRIES; i++) {
    const cx = x + i * CASCADE_STEP
    const cy = y + i * CASCADE_STEP
    if (!overlaps(ws, cx, cy)) return { x: cx, y: cy }
  }
  return { x: x + CASCADE_TRIES * CASCADE_STEP, y: y + CASCADE_TRIES * CASCADE_STEP }
}

interface SpawnOptions {
  /** Nó de onde o portal nasce: o pai do popup, ou o terminal que pediu. */
  originId: UUID
  url: string
  name?: string
  /**
   * Partição a herdar. Vinda do portal pai, é o que mantém o popup logado —
   * ver Decisão B do PLANO-portal.md.
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

  const spot = freeSpotRightOf(ws, origin)
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
