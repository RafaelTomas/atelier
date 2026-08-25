/**
 * Barra de ações do terminal selecionado.
 *
 * Mesma mecânica da FormatBar: vive FORA do contêiner transformado do canvas,
 * em coordenadas de tela, e é reposicionada no callback do viewport — assim não
 * escala com o zoom nem re-renderiza a árvore de nós a cada pan.
 */
import { useEffect, useRef } from 'react'
import type { CanvasNode } from '@shared/types'
import { viewport } from '../canvas/viewport'
import { IconConnect, IconPencil, IconReload, IconTrash } from '../icons'
import { store } from '../state/store'

const BAR_GAP = 12 // px de tela entre o topo do nó e a barra

interface Props {
  node: CanvasNode
}

export function NodeActionBar({ node }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const place = (): void => {
      const el = ref.current
      if (!el) return
      const { frame } = node
      const topLeft = viewport.toScreen({ x: frame.x, y: frame.y })
      el.style.left = `${topLeft.x + (frame.width * viewport.zoom) / 2}px`
      el.style.top = `${topLeft.y - BAR_GAP}px`
    }
    place()
    return viewport.subscribe(place)
  }, [node.frame.x, node.frame.y, node.frame.width])

  return (
    <div
      ref={ref}
      className="node-action-bar"
      // O canvas trata mousedown na fase de bolha; sem parar aqui, clicar num
      // botão também iniciaria seleção ou arrasto no nó de baixo.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="action-btn"
        title="Ligar a outro nó"
        onClick={() => store.startConnecting(node.id)}
      >
        <IconConnect size={16} />
      </button>
      <button
        type="button"
        className="action-btn"
        title="Editar terminal"
        onClick={() => store.openEditTerminal(node.id)}
      >
        <IconPencil size={16} />
      </button>
      <button
        type="button"
        className="action-btn"
        title="Recarregar — mata o processo e sobe outro"
        onClick={() => void store.restartTerminal(node.id)}
      >
        <IconReload size={16} />
      </button>
      <span className="action-sep" />
      <button
        type="button"
        className="action-btn is-danger"
        title="Excluir terminal"
        onClick={() => void store.removeNode(node.id)}
      >
        <IconTrash size={16} />
      </button>
    </div>
  )
}
