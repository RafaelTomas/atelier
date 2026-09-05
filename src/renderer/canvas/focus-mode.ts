/**
 * Entrar e sair do modo foco — o par que o resto do app chama.
 *
 * Existe como módulo, e não como duas linhas dentro do canvas, porque a SAÍDA
 * é pedida de três lugares (o véu e a tecla, no canvas; a pílula, dentro da
 * casca do nó) e porque ela tem uma segunda metade fácil de esquecer: devolver
 * o zoom e o pan que a entrada travou. Um `store.focusNode(null)` solto sairia
 * do foco deixando o canvas em 100% num lugar que o usuário não escolheu.
 *
 * O zoom vai a 1 na entrada porque o conteúdo do nó é desenhado dentro do
 * contêiner escalado do canvas: ampliar a MOLDURA com o zoom em 60% mostraria
 * um nó grande com letra de 60%, que é o oposto do pedido. Em 1, um ponto de
 * canvas é um pixel de tela — e é isso que `focus-frame.ts` pressupõe.
 */
import type { UUID } from '@shared/types'
import { store } from '../state/store'
import { viewport, type ViewportState } from './viewport'

/** O enquadramento de antes, para devolver na saída. */
let previous: ViewportState | null = null

export function enterFocus(nodeId: UUID): void {
  // Já em foco: trocar de nó não pode sobrescrever o enquadramento guardado
  // pelo zoom 1 que o foco anterior deixou.
  if (previous === null) previous = viewport.state
  store.select([nodeId])
  store.focusNode(nodeId)
  viewport.reset(previous.origin, 1)
}

export function exitFocus(): void {
  if (store.getSnapshot().focusedNodeId === null) return
  store.focusNode(null)
  if (previous) viewport.reset(previous.origin, previous.zoom)
  previous = null
}
