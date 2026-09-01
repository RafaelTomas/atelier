/**
 * A tela de Configurações — a casca.
 *
 * Um modal centrado, na mesma gramática dos outros diálogos do app
 * (`.modal-backdrop` / `.modal` / `.modal-footer`), numa variante larga e de
 * DUAS colunas: a lista de grupos à esquerda escolhe, o conteúdo à direita
 * mostra. É a geometria da cascata da rail, e é de propósito — é a forma que o
 * app já ensinou ao usuário para "escolher de um lado, ver do outro".
 *
 * O que esta casca NÃO faz:
 *
 * - Não guarda preferência nenhuma. Nem um rascunho, nem um "valor atual".
 *   Cada linha de cada grupo lê da store e escreve nela; por isso o rodapé tem
 *   só **Fechar**, sem OK nem Cancelar (ver o plano, decisões 1 e 4). Um botão
 *   de Cancelar exigiria estado-rascunho, e aí a tela passaria a ser dona de
 *   estado — que é exatamente o que a decisão 1 proíbe.
 * - Não decide QUAL grupo está aberto: isso é `store.settingsOpen`, para que as
 *   portas de entrada possam abrir a tela já no grupo certo.
 *
 * O grupo de cada página mora num arquivo próprio em `settings/`.
 *
 * ─── Busca (fase 7) ───
 *
 * O campo de busca É estado local (`query`), e não da store: é interação
 * efêmera de navegação dentro da tela, não uma preferência — não faz sentido
 * persistir "o que a pessoa procurou da última vez que abriu Configurações",
 * e por isso não fere a regra "a tela não é dona de estado" (essa regra é
 * sobre PREFERÊNCIAS, não sobre todo `useState`).
 *
 * Com o campo vazio, a coluna esquerda mostra os sete grupos, como sempre.
 * Com texto, ela mostra os RESULTADOS — cada linha de cada grupo cujo rótulo
 * ou dica bate com a busca (`searchSettings`, em `settings/search-index.ts`;
 * é lá que está a decisão de como o índice nasce sem poder divergir do JSX).
 * Clicar num resultado abre o grupo dele (`store.openSettings`) e destaca a
 * linha encontrada — ver o efeito que casa `highlight` com o rótulo já
 * renderizado.
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { store, useStore } from '../state/store'
import { AboutSettings } from './settings/about'
import { AgentsSettings } from './settings/agents'
import { AppearanceSettings } from './settings/appearance'
import { CanvasSettings } from './settings/canvas'
import { PortalsSettings } from './settings/portals'
import { ProjectsSettings } from './settings/projects'
import { searchSettings } from './settings/search-index'
import { TerminalsSettings } from './settings/terminals'
import type { SettingsSearchEntry } from './settings/search-index'
import type { SettingsGroup } from '../state/store'

/**
 * Os sete grupos, na ordem em que aparecem. A ordem é a do plano e não é
 * alfabética: começa no que todo mundo procura primeiro (Aparência) e termina
 * no que se procura uma vez (Sobre).
 */
const GROUPS: readonly {
  id: SettingsGroup
  label: string
  Content: () => JSX.Element
}[] = [
  { id: 'aparencia', label: 'Aparência', Content: AppearanceSettings },
  { id: 'canvas', label: 'Canvas', Content: CanvasSettings },
  { id: 'terminais', label: 'Terminais', Content: TerminalsSettings },
  { id: 'agentes', label: 'Agentes e Contas', Content: AgentsSettings },
  { id: 'projetos', label: 'Projetos', Content: ProjectsSettings },
  { id: 'portais', label: 'Portais', Content: PortalsSettings },
  { id: 'sobre', label: 'Sobre', Content: AboutSettings }
]

export function SettingsDialog(): JSX.Element | null {
  const { settingsOpen } = useStore()
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Nasce vazio a cada abertura: uma busca de uma visita anterior não deveria
  // recuar sozinha quando a tela é reaberta em outro dia por outro motivo.
  useEffect(() => {
    if (settingsOpen) setQuery('')
  }, [settingsOpen])

  /**
   * A linha achada por último — leva o grupo dela ao content e o rótulo pelo
   * qual encontrá-la de novo já renderizada. Um `nonce` faz o efeito abaixo
   * rodar de novo mesmo clicando duas vezes no MESMO resultado.
   */
  const [highlight, setHighlight] = useState<{ group: SettingsGroup; label: string; nonce: number } | null>(
    null
  )

  // `capture: true`, como no diálogo de scan: a tela está por cima de tudo, e o
  // Esc dela tem de chegar antes do Esc do canvas — que cancela conexão,
  // seleção e ferramenta, coisas que quem está aqui não pediu para mexer.
  //
  // Uma exceção mora aqui: Esc com o FOCO no campo de busca e texto digitado
  // limpa a busca em vez de fechar a tela — é o gesto de "recomeçar a busca",
  // não o de "sair". Esc no campo vazio, ou em qualquer outro lugar da tela,
  // continua fechando, como sempre fez.
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (document.activeElement === searchRef.current && query) {
        e.stopPropagation()
        setQuery('')
        return
      }
      e.stopPropagation()
      store.closeSettings()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [settingsOpen, query])

  if (!settingsOpen) return null

  // Grupo desconhecido cai na Aparência em vez de deixar a coluna vazia: o
  // valor vem da store, e um id que não existe mais (versão anterior, atalho
  // antigo) não pode resultar numa tela em branco sem explicação.
  const active = GROUPS.find((g) => g.id === settingsOpen) ?? GROUPS[0]
  const { Content } = active

  const results = query.trim() ? searchSettings(query) : null

  const goToResult = (entry: SettingsSearchEntry): void => {
    store.openSettings(entry.group)
    setHighlight({ group: entry.group, label: entry.label, nonce: Date.now() })
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) store.closeSettings()
      }}
    >
      <div
        className="modal is-wide settings-modal"
        role="dialog"
        aria-label="Configurações"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Configurações</h2>

        <div className="settings-columns">
          <div className="settings-groups-column">
            <input
              ref={searchRef}
              type="search"
              className="settings-search"
              placeholder="Buscar…"
              aria-label="Buscar nas configurações"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            {results === null ? (
              <nav className="settings-groups" aria-label="Grupos de configuração">
                {GROUPS.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={
                      group.id === active.id ? 'settings-group is-active' : 'settings-group'
                    }
                    aria-current={group.id === active.id ? 'page' : undefined}
                    onClick={() => store.openSettings(group.id)}
                  >
                    {group.label}
                  </button>
                ))}
              </nav>
            ) : (
              <div className="settings-search-results" role="listbox" aria-label="Resultados da busca">
                {results.length === 0 ? (
                  <p className="settings-search-empty">nada encontrado</p>
                ) : (
                  results.map((entry, i) => (
                    <button
                      key={`${entry.group}/${entry.label}/${i}`}
                      type="button"
                      className="settings-search-result"
                      role="option"
                      onClick={() => goToResult(entry)}
                    >
                      <span className="settings-search-result-group">
                        {GROUPS.find((g) => g.id === entry.group)?.label}
                      </span>
                      <span className="settings-search-result-label">{entry.label}</span>
                      {entry.hint && <span className="settings-search-result-hint">{entry.hint}</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* `key` no grupo: trocar de página DESMONTA a anterior. É o que
              garante que um rascunho de campo de texto (a largura da rail, por
              exemplo) não sobreviva escondido a uma ida e volta pela lista. */}
          <div className="settings-content" key={active.id} ref={contentRef}>
            <Content />
          </div>
        </div>

        <div className="modal-divider" />

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={() => store.closeSettings()}>
            Fechar
          </button>
        </footer>
      </div>

      <SearchHighlight highlight={highlight} activeGroup={active.id} contentRef={contentRef} />
    </div>
  )
}

/**
 * Rola até a linha achada pela busca e a acende por um instante.
 *
 * Componente à parte (e não um `useEffect` solto no corpo do diálogo) só para
 * o efeito ter as duas dependências certas — `highlight` e o grupo hoje
 * ativo — sem competir com os outros efeitos da casca por uma lista de
 * dependências comum.
 *
 * Acha a linha pelo RÓTULO, batendo contra `.settings-row-label` já
 * renderizado — não por um índice de posição, que uma lista dinâmica (contas,
 * temas) deslocaria. Rótulos duplicados dentro do mesmo grupo não existem
 * hoje; se um nascesse, o primeiro que bater é o aceso, o que é bem menos
 * grave do que não iluminar nenhum.
 */
function SearchHighlight({
  highlight,
  activeGroup,
  contentRef
}: {
  highlight: { group: SettingsGroup; label: string; nonce: number } | null
  activeGroup: SettingsGroup
  contentRef: RefObject<HTMLDivElement>
}): JSX.Element | null {
  useEffect(() => {
    if (!highlight || highlight.group !== activeGroup) return
    const root = contentRef.current
    if (!root) return
    const label = Array.from(root.querySelectorAll<HTMLElement>('.settings-row-label')).find(
      (el) => el.textContent === highlight.label
    )
    const row = label?.closest<HTMLElement>('.settings-row')
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.add('is-search-hit')
    const timer = window.setTimeout(() => row.classList.remove('is-search-hit'), 1600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, activeGroup])
  return null
}
