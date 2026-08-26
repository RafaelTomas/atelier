/**
 * Zoom do canvas: um botão redondo na borda direita que abre as opções quando
 * o ponteiro chega perto.
 *
 * Mora aqui, e não na toolbar, porque é controle do CANVAS — fica onde a mão
 * já está quando se navega, e não a uma travessia de tela de distância. O que
 * sobrou na toolbar é o que é da JANELA: tema e gravação.
 *
 * Fechado, o círculo mostra a porcentagem atual: mesmo em repouso ele responde
 * "em que zoom eu estou", que é metade do que se quer de um controle de zoom.
 * Aberto, cresce numa coluna com aproximar, afastar e enquadrar tudo.
 *
 * A abertura é por CSS (:hover / :focus-within), não por estado do React. Um
 * onMouseEnter que chamasse setState re-renderizaria a árvore inteira a cada
 * passada do mouse — e :focus-within resolve de graça o acesso por teclado,
 * que um handler de mouse deixaria de fora.
 *
 * O rótulo assina o viewport e escreve no DOM direto, pelo mesmo motivo: um
 * setState por frame de zoom faria o que o resto do canvas evita.
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { nodesBounds, viewport } from './viewport'

export function ZoomBar(): JSX.Element | null {
  const { workspace } = useStore()
  const labelRef = useRef<HTMLSpanElement>(null)

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
    <div className="zoom-dial" onMouseDown={(e) => e.stopPropagation()}>
      {/* As opções vêm ANTES do gatilho no DOM para abrirem para CIMA a partir
          dele: a coluna é `flex-direction: column` e o círculo fica por último,
          ancorado embaixo. */}
      <div className="zoom-dial-options">
        <button
          type="button"
          className="zoom-btn"
          title="Aproximar"
          aria-label="Aproximar"
          onClick={() => viewport.setZoom(viewport.zoom + 0.25)}
        >
          +
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

      {/* O círculo é um <button> de verdade: clicar volta a 100%, que é o gesto
          que já se espera de um indicador de zoom, e é o que dá o foco de
          teclado que abre o painel via :focus-within. */}
      <button
        type="button"
        className="zoom-dial-trigger"
        title="Zoom · clique para voltar a 100%"
        onClick={() => viewport.setZoom(1)}
      >
        <span ref={labelRef} className="zoom-dial-label">
          100%
        </span>
      </button>
    </div>
  )
}
