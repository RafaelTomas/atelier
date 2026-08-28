/**
 * Geometria das molduras de grupo.
 *
 * Mora fora do componente porque três lugares precisam das MESMAS medidas: a
 * store (que calcula o frame ao criar um grupo a partir da seleção), o
 * canvas-view (que decide quem entra e quem sai no fim de um arrasto) e a
 * camada de render. Números repetidos em três arquivos divergem no primeiro
 * ajuste, e o sintoma seria uma moldura que desenha um retângulo diferente
 * daquele que ela testa.
 */
import type { NodeGroup, Rect, UUID } from '@shared/types'
import { rectCenter } from './viewport'

/**
 * Altura da faixa do título, em pontos de canvas.
 *
 * Fica ACIMA do conteúdo, dentro do frame: o corpo útil da moldura começa
 * depois dela. É por isso que o frame inicial ganha esta altura a mais no topo,
 * senão a faixa cobriria a primeira fileira de nós.
 */
export const GROUP_TITLE_HEIGHT = 32

/** Respiro entre os nós e a borda da moldura, ao criar ou ajustar ao conteúdo. */
export const GROUP_PADDING = 48

/** Piso da moldura ao redimensionar. Abaixo disto o título não cabe. */
export const GROUP_MIN_WIDTH = 160
export const GROUP_MIN_HEIGHT = 96

/** Espessura da borda clicável, em pontos de canvas — as alças de resize. */
export const GROUP_EDGE = 8

/**
 * O menor retângulo que envolve os frames, com a folga e o espaço da faixa.
 *
 * null com a lista vazia: um grupo sem membros mantém o frame que já tinha, e
 * "ajustar ao conteúdo" sem conteúdo não tem resposta melhor do que não fazer
 * nada.
 */
export function boundsForNodes(frames: Rect[]): Rect | null {
  if (frames.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of frames) {
    minX = Math.min(minX, f.x)
    minY = Math.min(minY, f.y)
    maxX = Math.max(maxX, f.x + f.width)
    maxY = Math.max(maxY, f.y + f.height)
  }
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_TITLE_HEIGHT,
    width: Math.max(GROUP_MIN_WIDTH, maxX - minX + GROUP_PADDING * 2),
    height: Math.max(GROUP_MIN_HEIGHT, maxY - minY + GROUP_PADDING * 2 + GROUP_TITLE_HEIGHT)
  }
}

/** O ponto está dentro do retângulo? Bordas contam. */
export function rectContains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/**
 * Quem adota um nó que acabou de ser solto em `frame`: o grupo cujo retângulo
 * contém o CENTRO do nó. null = nenhum, o nó fica solto.
 *
 * O centro, e não a sobreposição: um nó que encosta na moldura por uma quina
 * não foi posto lá dentro, e "meio dentro" precisaria de um limiar arbitrário
 * que ninguém consegue prever com o mouse na mão. Do último para o primeiro
 * porque o fim do array é o grupo desenhado por cima — com duas molduras
 * sobrepostas, ganha a que está visualmente na frente.
 */
export function groupAt(groups: NodeGroup[], frame: Rect): NodeGroup | null {
  const center = rectCenter(frame)
  for (let i = groups.length - 1; i >= 0; i--) {
    if (rectContains(groups[i].frame, center)) return groups[i]
  }
  return null
}

/** O grupo de que este nó é membro, ou null. */
export function groupOf(groups: NodeGroup[], nodeId: UUID): NodeGroup | null {
  return groups.find((g) => g.nodeIds.includes(nodeId)) ?? null
}

/** Ids de todos os nós que estão dentro de ALGUM grupo colapsado. */
export function collapsedMembers(groups: NodeGroup[]): Set<UUID> {
  const out = new Set<UUID>()
  for (const g of groups) {
    if (!g.isCollapsed) continue
    for (const id of g.nodeIds) out.add(id)
  }
  return out
}
