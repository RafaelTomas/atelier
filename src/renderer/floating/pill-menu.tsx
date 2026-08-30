/**
 * Menu de contexto das doze posições NOMEADAS de uma pílula.
 *
 * O arrasto alcança qualquer ponto de qualquer borda; aqui ficam as três
 * paradas redondas de cada uma. Não é um extra: sem ele, quem não consegue
 * arrastar não consegue mover a dock, e é o único jeito de acertar o centro
 * exato sem mirar com o mouse. É também a saída de emergência — se um estado
 * ruim for gravado, ou se a pílula ficar num canto difícil de agarrar,
 * "Restaurar padrão" está a um botão direito de distância.
 */
import type { Placement, PlacementEdge } from '@shared/types'
import { ALIGN_OFFSET, PLACEMENT_ALIGNS, PLACEMENT_EDGES, samePlacement } from '@shared/types'
import { ContextMenu } from '../context-menu'

const EDGE_LABEL: Record<PlacementEdge, string> = {
  top: 'Topo',
  bottom: 'Base',
  left: 'Esquerda',
  right: 'Direita'
}

const ALIGN_LABEL: Record<string, string> = {
  start: 'início',
  center: 'centro',
  end: 'fim'
}

interface Props {
  x: number
  y: number
  current: Placement
  fallback: Placement
  onPick: (p: Placement) => void
  onClose: () => void
  /**
   * Ação extra no rodapé — hoje só o "Ocultar" da tira do monitor.
   *
   * OPCIONAL porque a dock e a rail não podem ser ocultadas: elas não custam
   * nada, e esconder a barra de ferramentas do canvas seria oferecer um estado
   * ruim sem razão. A tira custa (assina o amostrador), então desligá-la é um
   * pedido legítimo — e ela só ganhou este item porque o caminho de VOLTA
   * nasceu junto, no item da dock.
   */
  extra?: { label: string; run: () => void }
}

export function PillMenu({ x, y, current, fallback, onPick, onClose, extra }: Props): JSX.Element {
  return (
    <ContextMenu x={x} y={y}>
      <span className="context-menu-label">Posição</span>
      {PLACEMENT_EDGES.map((edge) => (
        <div key={edge} className="pill-menu-row">
          <span className="pill-menu-edge">{EDGE_LABEL[edge]}</span>
          {PLACEMENT_ALIGNS.map((align) => {
            const p = { edge, offset: ALIGN_OFFSET[align] }
            return (
              <button
                key={align}
                type="button"
                // A posição ATUAL fica desabilitada: escolhê-la não faria nada,
                // e um menu que aceita um clique sem efeito parece quebrado.
                disabled={samePlacement(p, current)}
                onClick={() => {
                  onClose()
                  onPick(p)
                }}
              >
                {ALIGN_LABEL[align]}
              </button>
            )
          })}
        </div>
      ))}
      <div className="context-menu-sep" />
      <button
        type="button"
        disabled={samePlacement(current, fallback)}
        onClick={() => {
          onClose()
          onPick(fallback)
        }}
      >
        Restaurar padrão
      </button>
      {extra && (
        <button
          type="button"
          onClick={() => {
            onClose()
            extra.run()
          }}
        >
          {extra.label}
        </button>
      )}
    </ContextMenu>
  )
}
