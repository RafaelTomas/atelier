/**
 * Zoom do canvas: um botão redondo na borda direita que abre as opções quando
 * o ponteiro chega perto.
 *
 * Mora aqui, e não na toolbar, porque é controle do CANVAS — fica onde a mão
 * já está quando se navega, e não a uma travessia de tela de distância. O que
 * sobrou na toolbar é o que é da JANELA: tema e gravação.
 *
 * Fechado, o círculo é só a lupa — um alvo limpo, do tamanho de um ícone.
 * Aberto, a coluna traz a porcentagem atual e os controles: aproximar,
 * afastar e enquadrar tudo.
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
import { IconSearch } from '../icons'
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

        {/* A porcentagem é o botão de 100%, no meio dos dois que a alteram —
            é onde a mão já está depois de aproximar ou afastar. */}
        <button
          type="button"
          className="zoom-level"
          title="Voltar a 100%"
          onClick={() => viewport.setZoom(1)}
        >
          <span ref={labelRef}>100%</span>
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

      {/* Continua sendo um <button> de verdade, e não uma <div> com hover: é
          ele que recebe o foco de teclado que abre o painel via
          :focus-within. Clicar volta a 100% — o mesmo que a porcentagem lá
          dentro faz, para quem não quer esperar o menu abrir. */}
      <button
        type="button"
        className="zoom-dial-trigger"
        title="Zoom · clique para voltar a 100%"
        aria-label="Zoom"
        onClick={() => viewport.setZoom(1)}
      >
        <IconSearch size={17} />
      </button>
    </div>
  )
}
