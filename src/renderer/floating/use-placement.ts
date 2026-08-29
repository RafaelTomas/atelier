/**
 * O gesto de arrastar uma pílula flutuante para outra borda.
 *
 * Três decisões moram aqui, e as três existem por um modo de falha concreto:
 *
 *  - **Limiar de 4px antes de virar arrasto.** Um `pointerdown` na pílula é
 *    CLIQUE até andar mais que isso — o mesmo limiar que o canvas já usa. Sem
 *    ele, todo clique num botão da dock viraria um micro-arrasto e a dock
 *    mudaria de lugar quando o usuário só queria abrir um menu.
 *  - **`setPointerCapture`.** O ponteiro passa por cima de webviews de portal
 *    durante o gesto, e um `<webview>` engole os eventos do documento. Sem a
 *    captura o arrasto morre no meio da tela, com a pílula grudada no cursor.
 *    É o mesmo motivo pelo qual o arrasto de nós já captura.
 *  - **A posição durante o gesto NÃO entra na store.** Ela vira uma CSS var
 *    escrita direto no elemento. A store notifica todos os assinantes a cada
 *    `set()`, e um arrasto a 60fps re-renderizaria o canvas inteiro — a mesma
 *    regra que a alça de largura da rail e o progresso da varredura já seguem.
 *
 * A gravação acontece UMA VEZ, ao soltar.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Placement, PlacementEdge } from '@shared/types'
import { placementFor } from '@shared/placement'

/** Abaixo disto o gesto ainda é um clique. Espelha o CLICK_SLOP do canvas. */
const DRAG_SLOP = 4

export interface PlacementDrag {
  /** Passe no `onPointerDown` da pílula. */
  onPointerDown: (e: React.PointerEvent) => void
  /** Verdadeiro só depois do limiar: é o que liga `.is-dragging`. */
  dragging: boolean
  /** Borda sob o ponteiro agora, para acender o alvo. `null` = nenhuma. */
  hot: PlacementEdge | null
}

export function usePlacementDrag(
  current: Placement,
  onDrop: (next: Placement) => void
): PlacementDrag {
  const [dragging, setDragging] = useState(false)
  const [hot, setHot] = useState<PlacementEdge | null>(null)

  /** Tudo o que muda a 60fps vive em refs: nenhum re-render por movimento. */
  const state = useRef<{
    el: HTMLElement | null
    pointerId: number
    startX: number
    startY: number
    armed: boolean
  } | null>(null)

  const finish = useCallback(
    (commit: boolean, x: number, y: number) => {
      const s = state.current
      state.current = null
      if (!s) return

      s.el?.classList.remove('is-dragging')
      s.el?.style.removeProperty('--pill-x')
      s.el?.style.removeProperty('--pill-y')
      try {
        s.el?.releasePointerCapture(s.pointerId)
      } catch {
        // O ponteiro já pode ter sido liberado (Esc, janela perdendo o foco).
      }
      setDragging(false)
      setHot(null)

      if (!commit || !s.armed) return
      const next = placementFor(x, y, { width: window.innerWidth, height: window.innerHeight })
      // `null` = solto longe de toda borda. A pílula VOLTA para onde estava:
      // nada de "quase encaixou", que moveria a dock por um gesto abandonado.
      if (next) onDrop(next)
    },
    [onDrop]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Botão direito é o menu de contexto (as doze posições), não o arrasto.
      if (e.button !== 0) return
      // Um gesto que começa DENTRO de um botão continua sendo o clique dele até
      // passar do limiar; quem decide é o slop, não o alvo.
      const el = e.currentTarget as HTMLElement
      state.current = {
        el,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        armed: false
      }
    },
    []
  )

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const s = state.current
      if (!s) return

      if (!s.armed) {
        const dx = e.clientX - s.startX
        const dy = e.clientY - s.startY
        if (Math.hypot(dx, dy) < DRAG_SLOP) return
        s.armed = true
        s.el?.classList.add('is-dragging')
        try {
          s.el?.setPointerCapture(s.pointerId)
        } catch {
          // Sem captura o gesto ainda funciona sobre o canvas; só morre ao
          // cruzar um webview. Melhor do que abortar o arrasto inteiro.
        }
        setDragging(true)
      }

      // CSS var, e não state: é isto que mantém o canvas fora do re-render.
      s.el?.style.setProperty('--pill-x', `${e.clientX}px`)
      s.el?.style.setProperty('--pill-y', `${e.clientY}px`)

      const next = placementFor(e.clientX, e.clientY, {
        width: window.innerWidth,
        height: window.innerHeight
      })
      setHot(next?.edge ?? null)
    }

    const onUp = (e: PointerEvent): void => finish(true, e.clientX, e.clientY)

    // Esc cancela: a pílula volta para onde estava. É a saída de quem começou o
    // gesto sem querer, e não custa um segundo arrasto para desfazer.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(false, 0, 0)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [finish])

  return { onPointerDown, dragging, hot }
}
