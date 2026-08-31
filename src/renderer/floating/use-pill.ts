/**
 * Tudo o que uma pílula flutuante precisa para ser móvel, num hook só.
 *
 * A dock, a rail e a tira do monitor usam exatamente o mesmo comportamento —
 * arrastar, menu de contexto, dividir ou trocar de borda quando colidem —, e a
 * única diferença entre elas é qual preferência guarda a posição. Duplicar isso
 * nos três componentes seria duplicar cinco decisões (limiar, captura de
 * ponteiro, CSS var, medição, colisão) que já são sutis uma vez.
 *
 * Nasceu para DUAS pílulas, com ternários no lugar dos mapas e uma "outra" no
 * singular. Com a terceira, os ternários viraram `Record<PillId, …>` e a
 * resolução passou a iterar sobre as OUTRAS que estão na mesma borda — ver
 * `fitAmong`, que é onde a conta de N pílulas mora.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Placement } from '@shared/types'
import {
  DOCK_PLACEMENT_DEFAULT,
  MONITOR_PLACEMENT_DEFAULT,
  RAIL_PLACEMENT_DEFAULT,
  isVerticalEdge
} from '@shared/types'
import { fitAmong, resolveCollision } from '@shared/placement'
import { reserveFor } from './chrome-band'
import { store, useStore } from '../state/store'
import { usePlacementDrag } from './use-placement'

export type PillId = 'dock' | 'rail' | 'monitor'

/**
 * A ordem em que as irmãs são acomodadas quando três dividem uma borda.
 *
 * FIXA, e não a de renderização: empurrar a rail antes da tira não dá o mesmo
 * resultado que o contrário, e uma ordem que dependesse de quem montou primeiro
 * faria o mesmo gesto terminar em lugares diferentes entre duas execuções.
 */
export const PILL_ORDER: PillId[] = ['dock', 'rail', 'monitor']

/**
 * A classe CSS de cada pílula. Não é `id` direto porque a do monitor NÃO pode
 * se chamar `monitor`: `.monitor` já é o painel do monitor (panels.css), e uma
 * pílula que casasse com ele herdaria o `overflow-y: auto` que faz o painel
 * rolar dentro do nó — o que numa pílula recorta o popover e o menu que abrem
 * para fora dela. Eles ficavam no DOM, na posição certa, e invisíveis.
 */
const PILL_CLASS: Record<PillId, string> = {
  dock: 'dock',
  rail: 'rail',
  monitor: 'monitor-dock'
}

const PILL_FALLBACK: Record<PillId, Placement> = {
  dock: DOCK_PLACEMENT_DEFAULT,
  rail: RAIL_PLACEMENT_DEFAULT,
  monitor: MONITOR_PLACEMENT_DEFAULT
}

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
 * outra pílula por um obstáculo que não existe. É também o que acontece com a
 * tira do monitor DESLIGADA — ela não está na tela, e portanto não disputa
 * borda com ninguém.
 */
function edgeLength(id: PillId, placement: Placement): number | null {
  const el = document.querySelector<HTMLElement>(`.pill.${PILL_CLASS[id]}`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return isVerticalEdge(placement.edge) ? r.height : r.width
}

export function usePill(id: PillId): Pill {
  const { dockPlacement, railPlacement, monitorPlacement } = useStore()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const placements: Record<PillId, Placement> = {
    dock: dockPlacement,
    rail: railPlacement,
    monitor: monitorPlacement
  }
  const placement = placements[id]
  const fallback = PILL_FALLBACK[id]

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
   * Pílulas podem DIVIDIR uma borda — o que elas não podem é se sobrepor.
   *
   * Roda depois do commit e antes da pintura (`useLayoutEffect`, e não
   * `useEffect`): o empurrão tem de entrar no mesmo quadro, senão aparece um
   * piscar com as peças empilhadas antes do conserto.
   *
   * Sem lista de dependências de propósito. A condição de saída é o `pending`,
   * não uma mudança de valor: soltar a pílula exatamente onde ela já estava
   * ainda notifica a store (ela troca a referência do snapshot a cada `set`), e
   * um `[placement]` deixaria a marca pendurada para disparar num render alheio.
   *
   * Só a pílula ARRASTADA resolve — é a única com `pending` marcado. Se todas
   * resolvessem, cada uma empurraria as outras e o resultado dependeria da
   * ordem de renderização, que não é coisa em que se apoiar.
   */
  useLayoutEffect(() => {
    const from = pending.current
    if (!from) return
    pending.current = null

    const total = isVerticalEdge(placement.edge) ? window.innerHeight : window.innerWidth
    const mine = edgeLength(id, placement)
    // Sem a medida da própria pílula não há conta a fazer, e não mexer é melhor
    // do que mexer por palpite: esta posição vai para o disco.
    if (mine === null) return

    // As OUTRAS que estão nesta mesma borda, na ordem fixa. Quem está em outra
    // borda não disputa nada, e quem não está montado (a tira desligada) não é
    // obstáculo — `edgeLength` devolve null e ela fica de fora.
    const rivals: { id: PillId; placement: Placement; length: number }[] = []
    for (const other of PILL_ORDER) {
      if (other === id) continue
      const theirs = placements[other]
      if (theirs.edge !== placement.edge) continue
      const length = edgeLength(other, theirs)
      if (length === null) continue
      rivals.push({ id: other, placement: theirs, length })
    }
    if (rivals.length === 0) return

    const fits = fitAmong(
      { offset: placement.offset, length: mine },
      rivals.map((r) => ({ offset: r.placement.offset, length: r.length })),
      total,
      placement.edge,
      // No topo a pista é mais curta do que a borda: o chip e os controles de
      // vista ficam na mesma linha. Sem esta reserva a conta ofereceria à irmã
      // um vão que o CSS não desenha, e ela pousaria por cima do zoom.
      reserveFor(placement.edge)
    )

    rivals.forEach((rival, i) => {
      const fit = fits[i]
      if (fit.kind === 'ok') return
      if (fit.kind === 'push') {
        void store.setPillPlacement(rival.id, { edge: rival.placement.edge, offset: fit.offset })
        return
      }
      // Não cabe nesta borda: volta a regra antiga, a troca de bordas.
      const r = resolveCollision(placement, from, rival.placement)
      if (r.other.edge !== rival.placement.edge) void store.setPillPlacement(rival.id, r.other)
    })
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
