/**
 * Onde um nó criado pelo main nasce: à direita de quem o pediu, sem cobrir
 * ninguém.
 *
 * Extraído do portal-spawn quando o `atelier recruit` passou a criar terminais
 * pelo mesmo caminho. A regra é a mesma para os dois e não depende do tipo do
 * nó — o que muda é só o tamanho, que entra por parâmetro: dois nós seguidos
 * não podem nascer empilhados, porque o segundo ficaria invisível debaixo do
 * primeiro.
 */
import type { CanvasNode } from '@shared/types'
import type { WorkspaceManager } from './state/workspace-manager'

/** Folga entre o pai e o filho, e passo da cascata quando há sobreposição. */
const GAP = 60
const CASCADE_STEP = 40
const CASCADE_TRIES = 12

interface Size {
  width: number
  height: number
}

function overlaps(ws: WorkspaceManager, x: number, y: number, size: Size): boolean {
  return ws.nodes.some(
    (n) =>
      x < n.frame.x + n.frame.width &&
      x + size.width > n.frame.x &&
      y < n.frame.y + n.frame.height &&
      y + size.height > n.frame.y
  )
}

export function freeSpotRightOf(
  ws: WorkspaceManager,
  origin: CanvasNode,
  size: Size
): { x: number; y: number } {
  const x = origin.frame.x + origin.frame.width + GAP
  const y = origin.frame.y
  for (let i = 0; i < CASCADE_TRIES; i++) {
    const cx = x + i * CASCADE_STEP
    const cy = y + i * CASCADE_STEP
    if (!overlaps(ws, cx, cy, size)) return { x: cx, y: cy }
  }
  return { x: x + CASCADE_TRIES * CASCADE_STEP, y: y + CASCADE_TRIES * CASCADE_STEP }
}
