/**
 * Menu de contexto — em portal, ancorado no ponto do clique.
 *
 * O portal não é preciosismo: a sidebar tem `backdrop-filter`, e um elemento
 * com filtro vira containing block dos descendentes `position: fixed`. Um menu
 * renderizado lá dentro passa a ser posicionado E RECORTADO pela sidebar, que
 * tem `overflow: hidden` — some metade dele. Fora da árvore dela, `fixed` volta
 * a significar "em relação à janela".
 *
 * A correção de borda vem junto: clique perto da margem inferior ou direita
 * abriria um menu fora da tela.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  x: number
  y: number
  /** 'right' trata `x` como a borda DIREITA — para menus pendurados num botão. */
  align?: 'left' | 'right'
  children: React.ReactNode
}

const MARGIN = 8

export function ContextMenu({ x, y, align = 'left', children }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Mede depois de montar: a altura depende de quantos itens quem chamou pôs.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const wanted = align === 'right' ? x - width : x
    setPos({
      left: Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN))
    })
  }, [x, y, align])

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}
