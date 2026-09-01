/**
 * Canvas — posição das três pílulas flutuantes, visibilidade da tira do
 * monitor e a conta que ela mostra.
 *
 * Zero geometria nova: `PLACEMENTS` e `formatPlacement` já existem em
 * `@shared/types`, e a escrita é a mesma que `usePlacementDrag`/`usePill` já
 * fazem hoje — `store.setPillPlacement(id, placement)` — só que a partir de um
 * `<select>` em vez de um arrasto ou do menu de contexto da pílula.
 *
 * O ganho que esta tela existe para dar: com a tira DESLIGADA
 * (`monitorDockVisible: false`), a pílula não está montada e o menu de
 * contexto dela — o único lugar onde `monitorPlacement` e
 * `monitorDockAccountId` podiam ser mudados — some com ela. Por isso as duas
 * linhas da tira aqui NÃO dependem de `monitorDockVisible`: elas leem e
 * escrevem a preferência direto, e continuam alcançáveis com a tira apagada.
 */
import { PLACEMENT_ALIGNS, PLACEMENT_EDGES, ALIGN_OFFSET, formatPlacement } from '@shared/types'
import type { Placement, PlacementAlign, PlacementEdge } from '@shared/types'
import type { PillId } from '../../floating/use-pill'
import { store, useStore } from '../../state/store'
import { SettingsSection, SettingsSelect, SettingsToggle } from '../settings-rows'

const EDGE_LABEL: Record<PlacementEdge, string> = {
  top: 'Topo',
  bottom: 'Base',
  left: 'Esquerda',
  right: 'Direita'
}

const ALIGN_LABEL: Record<PlacementAlign, string> = {
  start: 'início',
  center: 'centro',
  end: 'fim'
}

/** `"bottom/center"` — a mesma chave que `formatPlacement` devolve para uma parada nomeada. */
type PlacementKey = `${PlacementEdge}/${PlacementAlign}`

/** As doze paradas, na mesma ordem do menu de contexto da pílula. */
const PLACEMENT_OPTIONS: readonly { value: PlacementKey; label: string }[] =
  PLACEMENT_EDGES.flatMap((edge) =>
    PLACEMENT_ALIGNS.map((align) => ({
      value: `${edge}/${align}` as PlacementKey,
      label: `${EDGE_LABEL[edge]} · ${ALIGN_LABEL[align]}`
    }))
  )

/**
 * Rótulo e dica de cada linha do grupo — a MESMA constante que a busca da
 * tela lê (ver `search-index.ts`). As três posições ficam de fora: seus
 * rótulos ("Dock", "Rail", "Tira do monitor") já são a chave de cada
 * `PlacementRow`, sem dica — indexá-las aqui duplicaria a mesma string sem
 * ganho.
 */
export const ROWS = {
  dock: { label: 'Dock' },
  rail: { label: 'Rail' },
  tira: { label: 'Tira do monitor' },
  mostrarTira: {
    label: 'Mostrar a tira',
    hint: 'Desligada, ela some do canvas e para de medir a máquina — não só de aparecer.'
  },
  contaMostrada: {
    label: 'Conta mostrada',
    hint: '“Automática” segue a conta mais apertada do momento.'
  }
} satisfies Record<string, { label: string; hint?: string }>

function keyOf(p: Placement): PlacementKey {
  // Uma posição arrastada para um ponto livre da borda (fora das três paradas
  // nomeadas) não corresponde a nenhuma opção — `formatPlacement` devolve a
  // fração em vez de uma palavra, e o `<select>` fica sem opção marcada, o que
  // é honesto: não há nome para essa posição.
  return formatPlacement(p) as PlacementKey
}

function placementOf(key: PlacementKey): Placement {
  const [edge, align] = key.split('/') as [PlacementEdge, PlacementAlign]
  return { edge, offset: ALIGN_OFFSET[align] }
}

export function CanvasSettings(): JSX.Element {
  const { dockPlacement, railPlacement, monitorPlacement, monitorDockVisible, monitorDockAccountId, claudeAccounts } =
    useStore()

  return (
    <>
      <SettingsSection title="Posição">
        <PlacementRow id="dock" label={ROWS.dock.label} placement={dockPlacement} />
        <PlacementRow id="rail" label={ROWS.rail.label} placement={railPlacement} />
        <PlacementRow id="monitor" label={ROWS.tira.label} placement={monitorPlacement} />
      </SettingsSection>

      <SettingsSection title="Tira do monitor">
        <SettingsToggle
          label={ROWS.mostrarTira.label}
          hint={ROWS.mostrarTira.hint}
          value={monitorDockVisible}
          onChange={(value) => void store.setMonitorDockVisible(value)}
        />
        <SettingsSelect
          label={ROWS.contaMostrada.label}
          hint={ROWS.contaMostrada.hint}
          options={[
            { value: '', label: 'Automática' },
            ...claudeAccounts.map((a) => ({ value: a.id, label: a.label }))
          ]}
          value={monitorDockAccountId}
          onChange={(value) => void store.setMonitorDockAccount(value)}
        />
      </SettingsSection>
    </>
  )
}

function PlacementRow({
  id,
  label,
  placement
}: {
  id: PillId
  label: string
  placement: Placement
}): JSX.Element {
  return (
    <SettingsSelect
      label={label}
      options={PLACEMENT_OPTIONS}
      value={keyOf(placement)}
      onChange={(value) => void store.setPillPlacement(id, placementOf(value))}
    />
  )
}
