/**
 * Encaixe de um nó na lateral de outro — a GEOMETRIA, sem o gesto.
 *
 * Saiu de `renderer/canvas/dock-snap.ts`, onde nasceu para o arrasto, quando o
 * CLI passou a precisar da mesma conta: uma nota explicativa alinhada ao nó que
 * ela explica é o mesmo "põe este ao lado daquele, do mesmo tamanho" que o
 * usuário faz com a mão. Duas cópias da regra divergiriam, e divergir aqui faz
 * o encaixe do agente não bater com o encaixe do arrasto — o usuário arrastaria
 * um pixel e veria o par se mexer.
 *
 * O que ficou lá: a ESCOLHA do alvo e do lado durante o arrasto (zona de
 * atração, histerese, cobertura), que só existe com um mouse na mão. O que veio
 * para cá: a folga e o retângulo resultante, que valem para os dois.
 */
import type { Rect } from './types'

export type DockSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * Respiro entre os dois encaixados, em pontos de canvas.
 *
 * Colado de verdade (0) faz as duas bordas virarem uma linha grossa só, e o par
 * lê como um nó rachado no meio. Começou em 12 e subiu para 28 no uso: 12 era o
 * bastante para separar as bordas, mas não para os dois pararem de disputar a
 * mesma faixa de pixels — o par ficava apertado em vez de arrumado.
 */
export const DOCK_GAP = 28

/**
 * Onde e com que tamanho `source` fica ao encaixar no lado `side` de `target`.
 *
 * Só o eixo do encaixe é igualado: encostar pela lateral iguala a ALTURA e
 * preserva a largura; por cima ou por baixo iguala a LARGURA e preserva a
 * altura. Igualar os dois eixos jogaria fora a proporção que o nó já tem.
 *
 * `floor` é o piso do TIPO do nó que se encaixa, e vence o tamanho do vizinho:
 * um terminal não encolhe até a altura de um botão só porque encostou nele.
 */
export function dockedFrame(
  source: Rect,
  target: Rect,
  side: DockSide,
  floor: [number, number]
): Rect {
  if (side === 'left' || side === 'right') {
    const height = Math.max(target.height, floor[1])
    const width = Math.max(source.width, floor[0])
    const x = side === 'right' ? target.x + target.width + DOCK_GAP : target.x - width - DOCK_GAP
    return { x, y: target.y, width, height }
  }
  const width = Math.max(target.width, floor[0])
  const height = Math.max(source.height, floor[1])
  const y = side === 'bottom' ? target.y + target.height + DOCK_GAP : target.y - height - DOCK_GAP
  return { x: target.x, y, width, height }
}
