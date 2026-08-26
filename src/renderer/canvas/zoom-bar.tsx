/**
 * Barra de zoom do canto: aproximar, afastar, 100% e enquadrar tudo.
 *
 * Mora ao lado do minimapa, e não na toolbar, porque é controle do CANVAS —
 * fica onde a mão já está quando se navega, e não a uma travessia de tela de
 * distância. O que sobrou na toolbar é o que é da JANELA: tema e gravação.
 *
 * Ao contrário do minimapa, NÃO se esconde: o zoom é a primeira coisa que se
 * quer com o canvas parado, e um controle que exige mexer no canvas antes de
 * aparecer não serviria para nada.
 *
 * O rótulo da porcentagem assina o viewport e escreve no DOM direto, sem
 * passar por estado do React — um setState por frame de zoom re-renderizaria
 * a árvore inteira, que é o que o resto do canvas evita.
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { nodesBounds, viewport } from './viewport'

export function ZoomBar(): JSX.Element | null {
  const { workspace } = useStore()
  const labelRef = useRef<HTMLButtonElement>(null)

  const nodesRef = useRef(workspace?.nodes ?? [])
  nodesRef.current = workspace?.nodes ?? []

  useEffect(() => {
    return viewport.subscribe(({ zoom }) => {
      const el = labelRef.current
      if (el) el.textContent = `${Math.round(zoom * 100)}%`
    })
  }, [])

  if (!workspace) return null

  const fitAll = (): void => {
    const bounds = nodesBounds(nodesRef.current)
    if (bounds) viewport.fit(bounds)
  }

  return (
    <div className="zoom-bar" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="zoom-btn"
        title="Aproximar"
        aria-label="Aproximar"
        onClick={() => viewport.setZoom(viewport.zoom + 0.25)}
      >
        +
      </button>

      {/* O número é o botão: clicar volta a 100%, que é o gesto que já se
          espera de um indicador de zoom. */}
      <button
        ref={labelRef}
        type="button"
        className="zoom-level"
        title="Voltar a 100%"
        onClick={() => viewport.setZoom(1)}
      >
        100%
      </button>

      <button
        type="button"
        className="zoom-btn"
        title="Afastar"
        aria-label="Afastar"
        onClick={() => viewport.setZoom(viewport.zoom - 0.25)}
      >
        −
      </button>

      <span className="zoom-sep" />

      <button
        type="button"
        className="zoom-btn"
        title="Enquadrar tudo — traz todos os nós para a tela"
        aria-label="Enquadrar tudo"
        disabled={workspace.nodes.length === 0}
        onClick={fitAll}
      >
        ⤢
      </button>
    </div>
  )
}
