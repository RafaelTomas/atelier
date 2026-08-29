/**
 * Tudo o que uma pílula flutuante precisa para ser móvel, num hook só.
 *
 * A dock e a rail usam exatamente o mesmo comportamento — arrastar, menu de
 * contexto, dividir ou trocar de borda quando colidem —, e a única diferença
 * entre elas é qual preferência guarda a posição. Duplicar isso nos dois
 * componentes seria duplicar cinco decisões (limiar, captura de ponteiro, CSS
 * var, medição, colisão) que já são sutis uma vez.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Placement } from '@shared/types'
import { DOCK_PLACEMENT_DEFAULT, RAIL_PLACEMENT_DEFAULT, isVerticalEdge } from '@shared/types'
import { fitAlongEdge, resolveCollision } from '@shared/placement'
import { store, useStore } from '../state/store'
import { usePlacementDrag } from './use-placement'

export type PillId = 'dock' | 'rail'

export interface Pill {
  placement: Placement
  /** Passe no elemento raiz da pílula. */
  onPointerDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  dragging: boolean
  /** Borda sob o ponteiro — para acender o alvo. */
  hot: ReturnType<typeof usePlacementDrag>['hot']
  /** Aberto = renderize o `PillMenu` nestas coordenadas. */
  menu: { x: number; y: number } | null
  closeMenu: () => void
  /** Aplica uma posição (do menu ou do arrasto). A colisão é resolvida depois. */
  apply: (next: Placement) => void
  fallback: Placement
}

/**
 * Comprimento da pílula AO LONGO da borda em que ela está, medido no DOM.
 *
 * Medido, e não estimado, porque a mesma pílula tem comprimentos diferentes em
 * bordas diferentes — em linha ela é larga, em coluna é alta — e porque o
 * número de botões muda com o que o workspace oferece. Uma conta de encaixe
 * feita sobre um palpite erra justamente no caso apertado, que é o único em que
 * ela importa.
 *
 * `null` quando o elemento não está montado: uma medida inventada empurraria a
 * outra pílula por um obstáculo que não existe.
 */
function edgeLength(id: PillId, placement: Placement): number | null {
  const el = document.querySelector<HTMLElement>(`.pill.${id}`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return isVerticalEdge(placement.edge) ? r.height : r.width
}

export function usePill(id: PillId): Pill {
  const { dockPlacement, railPlacement } = useStore()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const placement = id === 'dock' ? dockPlacement : railPlacement
  const other = id === 'dock' ? railPlacement : dockPlacement
  const otherId: PillId = id === 'dock' ? 'rail' : 'dock'
  const fallback = id === 'dock' ? DOCK_PLACEMENT_DEFAULT : RAIL_PLACEMENT_DEFAULT

  /**
   * De onde esta pílula saiu no gesto que ainda não foi resolvido.
   *
   * A resolução não pode acontecer dentro do `apply`: ali a pílula ainda está
   * desenhada na borda ANTIGA, e medi-la daria o comprimento da orientação
   * errada — a largura onde vai valer a altura. O ref marca "há um gesto para
   * resolver", e quem resolve é o efeito de layout, já com o DOM novo no lugar.
   */
  const pending = useRef<Placement | null>(null)

  const apply = (next: Placement): void => {
    pending.current = placement
    void store.setPillPlacement(id, next)
  }

  const { onPointerDown, dragging, hot } = usePlacementDrag(placement, apply)

  /**
   * Duas pílulas podem DIVIDIR uma borda — o que elas não podem é se sobrepor.
   *
   * Roda depois do commit e antes da pintura (`useLayoutEffect`, e não
   * `useEffect`): o empurrão tem de entrar no mesmo quadro, senão aparece um
   * piscar com as duas empilhadas antes do conserto.
   *
   * Sem lista de dependências de propósito. A condição de saída é o `pending`,
   * não uma mudança de valor: soltar a pílula exatamente onde ela já estava
   * ainda notifica a store (ela troca a referência do snapshot a cada `set`), e
   * um `[placement]` deixaria a marca pendurada para disparar num render alheio.
   *
   * Só a pílula ARRASTADA resolve — é a única com `pending` marcado. Se as duas
   * resolvessem, cada uma empurraria a outra e o resultado dependeria da ordem
   * de renderização, que não é coisa em que se apoiar.
   */
  useLayoutEffect(() => {
    const from = pending.current
    if (!from) return
    pending.current = null
    if (placement.edge !== other.edge) return

    const total = isVerticalEdge(placement.edge) ? window.innerHeight : window.innerWidth
    const mine = edgeLength(id, placement)
    const theirs = edgeLength(otherId, other)
    // Sem as duas medidas não há conta a fazer, e não mexer é melhor do que
    // mexer por palpite: esta posição vai para o disco.
    if (mine === null || theirs === null) return

    const fit = fitAlongEdge(
      { offset: placement.offset, length: mine },
      { offset: other.offset, length: theirs },
      total,
      placement.edge
    )
    if (fit.kind === 'ok') return
    if (fit.kind === 'push') {
      void store.setPillPlacement(otherId, { edge: other.edge, offset: fit.offset })
      return
    }
    // Não cabem as duas na borda: volta a regra antiga, a troca de bordas.
    const r = resolveCollision(placement, from, other)
    if (r.other.edge !== other.edge) void store.setPillPlacement(otherId, r.other)
  })

  return {
    placement,
    onPointerDown,
    onContextMenu: (e) => {
      e.preventDefault()
      // `stopPropagation` para o canvas não abrir o menu DELE por baixo.
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY })
    },
    dragging,
    hot,
    menu,
    closeMenu: () => setMenu(null),
    apply,
    fallback
  }
}
