/**
 * Geometria PURA das molduras de grupo — medidas e retângulos, sem DOM.
 *
 * Mora em `shared/` pelo mesmo motivo de `placement.ts`: são funções que
 * recebem números e devolvem números, e mais de um processo precisa das MESMAS
 * medidas. O renderer usa para desenhar a moldura, decidir quem entra num
 * arrasto e calcular o frame ao agrupar a seleção; o main usa quando um agente
 * pede um grupo pelo CLI (`atelier node group`). Números repetidos nos dois
 * lados divergiriam no primeiro ajuste, e o sintoma seria uma moldura criada
 * pelo agente com folga diferente da criada pelo usuário.
 *
 * O que depende do viewport do renderer (`groupAt`, `groupOf`) ficou em
 * `renderer/canvas/group-geometry.ts`, que reexporta o que está aqui.
 */
import type { NodeGroup, Rect } from './types'

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
 * Quem adota um nó cujo frame é `frame`: o grupo cujo retângulo contém o
 * CENTRO do nó. null = nenhum, o nó fica solto.
 *
 * O centro, e não a sobreposição: um nó que encosta na moldura por uma quina
 * não foi posto lá dentro, e "meio dentro" precisaria de um limiar arbitrário
 * que ninguém consegue prever com o mouse na mão. Do último para o primeiro
 * porque o fim do array é o grupo desenhado por cima — com duas molduras
 * sobrepostas, ganha a que está visualmente na frente.
 *
 * Mora aqui, e não no renderer, porque DOIS gestos precisam decidir isto do
 * mesmo jeito: o fim de um arrasto do usuário e o `atelier node move` de um
 * agente. Duas cópias divergiriam, e o sintoma seria um nó que o mouse tira do
 * grupo e o CLI deixa dentro — ou o contrário.
 */
export function groupAt(groups: NodeGroup[], frame: Rect): NodeGroup | null {
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (rectContains(groups[i].frame, center)) return groups[i]
  }
  return null
}
