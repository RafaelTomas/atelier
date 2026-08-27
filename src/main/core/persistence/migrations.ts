/**
 * Migrações de schema (porte de Sources/Workspace/Migrations/).
 *
 * A v1 guardava as conexões dentro de cada nó; a v2 promoveu para arrays no topo
 * do payload.
 *
 * A v3 NÃO transforma dado nenhum. Ela só admite um caso a mais no enum de
 * conteúdo de nó (`codeEditor`): todo arquivo v2 já é um v3 válido, e o decoder
 * lê os dois sem tocar em nada. O arquivo passa a ser gravado com
 * `schemaVersion: 3` no primeiro save.
 *
 * A v4 segue a mesma lógica da v3: um caso a mais no enum (`dataTable`, o nó de
 * resultado SQL) e uma nova lista de conexões (`dataConnections`). Nenhum dado
 * é transformado — todo documento v3 já é um v4 válido.
 *
 * O que migração nenhuma resolve é o sentido CONTRÁRIO — um v3 aberto por um
 * leitor mais velho:
 *
 *   • No app nativo Swift, o `JSONDecoder` LANÇA em caso de enum desconhecido:
 *     ele não abre o workspace. É ruim, mas é barulhento, e o arquivo fica
 *     intacto.
 *   • Num Atelier anterior, o decoder daqui não lança — descarta o nó, o app
 *     abre normalmente e o primeiro autosave regrava o arquivo SEM ele. Perda
 *     silenciosa e irreversível.
 *
 * Por isso a subida de versão vem acompanhada de duas coisas concretas, que
 * não moram aqui: o backup único da v2 ao lado do arquivo (ver
 * `PersistenceManager.saveWorkspace`) e o modo seguro que desliga o autosave
 * quando o decoder descarta qualquer nó (ver `AppState`).
 */
import { asRecord, num } from '../coding'
import { Constants } from '../constants'
import { log } from '../logger'

export function migrateWorkspaceDocument(raw: unknown): unknown {
  const doc = asRecord(raw)
  const version = num(doc.schemaVersion, 1)
  if (version >= Constants.schemaVersion) return doc

  log.info('migrations', `migrando workspace v${version} → v${Constants.schemaVersion}`)

  let current = doc
  if (version < 2) current = migrateV1toV2(current)
  // Não há passo 2 → 3 nem 3 → 4: cada uma só acrescenta um caso ao enum de
  // conteúdo, e todo documento da versão anterior já é válido na seguinte. Só o
  // número muda.
  return { ...current, schemaVersion: Constants.schemaVersion }
}

function migrateV1toV2(doc: Record<string, unknown>): Record<string, unknown> {
  const payload = asRecord(doc.payload)
  const arrays = [
    'connections',
    'noteConnections',
    'portalConnections',
    'dataConnections',
    'portalToPortalConnections',
    'noteToNoteConnections',
    'crossFloorConnections',
    'floors',
    'drawings'
  ]
  const patched: Record<string, unknown> = { ...payload }
  for (const key of arrays) {
    if (!Array.isArray(patched[key])) patched[key] = []
  }
  return { ...doc, payload: patched }
}
