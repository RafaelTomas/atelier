/**
 * O piso de cada nó, em pontos de canvas — o MESMO para desenhar a área de um
 * nó novo e para redimensionar um que já existe.
 *
 * Ele morava em dois lugares, com números diferentes, e o gesto mentia: o dock
 * aplicava o piso do TIPO ao desenhar (um botão pode nascer com 56×56, e nasce
 * com 88×88), enquanto o redimensionamento aplicava 120×60 a todo mundo. Um
 * botão, então, SALTAVA para 120 de largura no primeiro pixel de arrasto e não
 * descia mais — enquanto a altura continuava encolhendo até passar dos 64 px em
 * que o rótulo some. Era a mesma alça se comportando de dois jeitos na mesma
 * mão. Piso em dois lugares é piso que diverge.
 *
 * Os números espelham `Constants.*Min*` do main, que é quem os aplica quando o
 * nó é criado (`node-sizes.ts`). O espelho existe porque o renderer não importa
 * o processo principal; o que ele não pode é ter números PRÓPRIOS.
 */
import type { CanvasNode, NodeContent } from '@shared/types'

export type MinSizeKey =
  | 'terminal'
  | 'note'
  | 'text'
  | 'portal'
  | 'fileTree'
  | 'codeEditor'
  | 'dataTable'
  | 'image'
  | 'secretVault'
  | 'widget'
  | 'button'
  | 'clock'

export const MIN_SIZE: Record<MinSizeKey, [number, number]> = {
  terminal: [200, 100],
  note: [120, 80],
  text: [80, 32],
  portal: [240, 180],
  fileTree: [180, 140],
  codeEditor: [240, 160],
  dataTable: [240, 140],
  image: [80, 60],
  secretVault: [220, 140],
  // O piso do widget vale também para o monitor e para o quadro de TODO: os
  // dois NASCEM menores que a coluna de painel, mas abaixo de 240×180 as linhas
  // deles não cabem.
  widget: [240, 180],
  // Um botão é um alvo de clique, não um painel — e abaixo de 64 px de lado ele
  // vira só o ícone (ver LABEL_MIN_SIDE em button-widget).
  button: [56, 56],
  clock: [140, 100]
}

/**
 * O piso de um nó QUALQUER, inclusive os que não têm um seu.
 *
 * O fallback (120×60) é o antigo piso único do redimensionamento, e sobra para
 * o que não é criado pelo dock — forma, traço, mão livre. Ele é o teto do
 * descuido, não a regra: um tipo novo que não aparecer nesta tabela encolhe até
 * um retângulo genérico em vez de até o tamanho que o conteúdo dele pede.
 */
export const DEFAULT_MIN_SIZE: [number, number] = [120, 60]

export function minSizeKeyForContent(content: NodeContent): MinSizeKey | null {
  switch (content.type) {
    case 'terminal':
      return 'terminal'
    case 'stickyNote':
      return 'note'
    case 'text':
      return 'text'
    case 'portal':
      return 'portal'
    case 'fileTree':
      return 'fileTree'
    case 'codeEditor':
      return 'codeEditor'
    case 'dataTable':
      return 'dataTable'
    case 'image':
      return 'image'
    case 'secretVault':
      return 'secretVault'
    case 'widget':
      if (content.value.kind === 'button') return 'button'
      if (content.value.kind === 'clock') return 'clock'
      return 'widget'
    default:
      return null
  }
}

export function minSizeForNode(node: CanvasNode): [number, number] {
  const key = minSizeKeyForContent(node.content)
  return key ? MIN_SIZE[key] : DEFAULT_MIN_SIZE
}
