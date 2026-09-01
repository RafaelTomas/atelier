/**
 * O índice da busca — fase 7 do plano.
 *
 * O problema que esta fase existe para resolver: rótulo e dica de cada linha
 * moravam só dentro do JSX de cada grupo, então não havia nada para filtrar.
 * Duas saídas óbvias:
 *
 *  (a) um índice DECLARADO à parte — uma lista de {grupo, rótulo, dica} só
 *      para a busca —, que corre o risco de divergir do JSX no dia em que
 *      alguém editar uma linha e esquecer de atualizar a lista;
 *  (b) tirar os rótulos do JSX para um lugar de onde os dois leem.
 *
 * Esta fase escolhe (b), mas sem inventar geometria nova nem mover o JSX para
 * fora dos arquivos de grupo: cada `settings/*.tsx` exporta um `ROWS` — um
 * objeto com o rótulo (e, quando é texto fixo, a dica) de cada linha do
 * grupo — e o PRÓPRIO JSX do grupo lê dali (`label={ROWS.tema.label}`, e não
 * `label="Tema"`). Este módulo só *agrega* os sete `ROWS` com o id do grupo
 * de cada um.
 *
 * O que torna isto honesto, e não um índice (a) disfarçado: o JSX e a busca
 * leem o MESMO objeto. Editar o rótulo de uma linha é editar `ROWS` — e o
 * `<SettingsSelect>`/`<SettingsRow>` daquela linha muda junto, no mesmo commit,
 * porque não há mais nenhuma outra string para editar. Não é possível a busca
 * ficar com o nome velho enquanto a tela mostra o novo: não existem dois
 * lugares, existe um.
 *
 * Ficam de fora, de propósito, as linhas cujo rótulo OU dica é dado, não
 * documentação: os itens de uma lista (uma conta, uma raiz de varredura, um
 * tema de terminal, um caminho ignorado) e as dicas dinâmicas de "Sobre"
 * (caminho em disco, resultado da última verificação). Buscar "início" não
 * deveria casar com a pasta pessoal de alguém.
 */
import type { SettingsGroup } from '../../state/store'
import { ROWS as ABOUT_ROWS } from './about'
import { ROWS as AGENTS_ROWS } from './agents'
import { ROWS as APPEARANCE_ROWS } from './appearance'
import { ROWS as CANVAS_ROWS } from './canvas'
import { ROWS as PORTALS_ROWS } from './portals'
import { ROWS as PROJECTS_ROWS } from './projects'
import { ROWS as TERMINALS_ROWS } from './terminals'

export interface SettingsSearchEntry {
  group: SettingsGroup
  /** Rótulo exato da linha — é por ele que o resultado é encontrado de volta no DOM ao navegar até lá. */
  label: string
  hint?: string
}

function entriesOf(
  group: SettingsGroup,
  rows: Record<string, { label: string; hint?: string }>
): SettingsSearchEntry[] {
  return Object.values(rows).map((row) => ({ group, ...row }))
}

/** As sete listas juntas, na mesma ordem em que os grupos aparecem na coluna esquerda. */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  ...entriesOf('aparencia', APPEARANCE_ROWS),
  ...entriesOf('canvas', CANVAS_ROWS),
  ...entriesOf('terminais', TERMINALS_ROWS),
  ...entriesOf('agentes', AGENTS_ROWS),
  ...entriesOf('projetos', PROJECTS_ROWS),
  ...entriesOf('portais', PORTALS_ROWS),
  ...entriesOf('sobre', ABOUT_ROWS)
]

/** Sem acento e em minúsculas, para "conexoes" achar "Conexões". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Rótulo e dica, por substring — a mesma regra simples que o resto do app usa em filtros de lista. */
export function searchSettings(query: string): SettingsSearchEntry[] {
  const q = normalize(query.trim())
  if (!q) return []
  return SETTINGS_SEARCH_INDEX.filter(
    (entry) => normalize(entry.label).includes(q) || (entry.hint && normalize(entry.hint).includes(q))
  )
}
