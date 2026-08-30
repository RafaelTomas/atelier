/**
 * As quatro bordas acesas durante o arrasto de uma pílula.
 *
 * Existem porque a regra de encaixe não é adivinhável: a borda VENCEDORA é a
 * mais próxima do ponteiro, e num canto há um desempate declarado (ver
 * shared/placement.ts). Sem os alvos, o usuário descobre onde a dock vai parar
 * só depois de soltá-la — e desfazer custa um segundo gesto.
 *
 * `pointer-events: none` no contêiner: eles são pintura, e nunca podem
 * interceptar o ponteiro que está no meio de um arrasto.
 */
import type { PlacementEdge } from '@shared/types'
import { PLACEMENT_EDGES } from '@shared/types'

export function PlacementTargets({ hot }: { hot: PlacementEdge | null }): JSX.Element {
  return (
    <div className="pill-targets" aria-hidden="true">
      {PLACEMENT_EDGES.map((edge) => (
        <div
          key={edge}
          className={edge === hot ? 'pill-target is-hot' : 'pill-target'}
          data-edge={edge}
        />
      ))}
    </div>
  )
}
