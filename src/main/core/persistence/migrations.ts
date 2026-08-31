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
 * A v5 é igual: um caso a mais no enum (`image`, o nó de imagem), reusando a
 * lista `dataConnections` do cabo terminal↔imagem. Nenhum dado transformado —
 * todo documento v4 já é um v5 válido.
 *
 * A v6 acrescenta `widget`: um painel do app (projetos, git)
 * hospedado num nó. Um caso só para todos eles — qual painel é fica num campo
 * DENTRO do payload —, justamente para que painel novo não peça versão nova.
 * Nenhum dado transformado: todo documento v5 já é um v6 válido.
 *
 * A v7 acrescenta `secretVault`, o nó de cofre, e uma nova lista de conexões
 * (`secretConnections`, o cabo terminal↔cofre e portal↔cofre). Nenhum dado é
 * transformado: todo documento v6 já é um v7 válido. Os segredos NÃO estão no
 * arquivo — moram cifrados em `vaults/<id>.vault` —, então não há nada de
 * cifrado a migrar aqui, hoje nem quando a passphrase chegar.
 *
 * A v8 é uma migração VAZIA: todo documento v7 já é um v8 válido, e o decoder lê
 * os dois sem transformar nada. A versão sobe porque a v8 traz um array
 * PERSISTIDO novo — `clockActionConnections`, o cabo relógio→botão. Um cliente
 * mais antigo (daqui ou o app nativo Swift) não conhece a chave, a ignora ao
 * abrir e a APAGA no primeiro save. Aqui isso não é decoração descartável: um
 * cabo perdido muda o comportamento AUTOMÁTICO do workspace — o fim de um timer
 * deixa de acionar o botão —, então o custo tem de ser barulhento, como nas
 * v3–v7. Ver `clockActionConnections` em models/workspace.ts.
 *
 * As molduras de grupo NÃO subiram a versão, e é o ponto inteiro do desenho
 * delas: `groups` é uma chave a mais no topo do payload, não um caso a mais no
 * enum de conteúdo. Um leitor mais velho — daqui ou o app nativo — ignora a
 * chave e abre o arquivo normalmente. Se ele salvar, as molduras se perdem;
 * os nós, não. Ver NodeGroup em shared/types.ts.
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
  // Não há passo 2 → 3 … 7 → 8: cada uma só acrescenta um caso ao enum de
  // conteúdo (ou, na v8, uma lista de conexões nova), e todo documento da versão
  // anterior já é válido na seguinte. Só o número muda.
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
    'secretConnections',
    'clockActionConnections',
    'floors',
    'drawings',
    // Molduras de grupo. Mesmo motivo dos outros: o resto do código conta com
    // um array, e `undefined` obrigaria cada leitor a se defender sozinho.
    'groups'
  ]
  const patched: Record<string, unknown> = { ...payload }
  for (const key of arrays) {
    if (!Array.isArray(patched[key])) patched[key] = []
  }
  return { ...doc, payload: patched }
}
