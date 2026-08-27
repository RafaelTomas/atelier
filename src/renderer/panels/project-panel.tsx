/**
 * Painel de projetos: o índice global, com busca e as ações que levam um
 * projeto para o canvas.
 *
 * O progresso da varredura fica em useState LOCAL, não na store. O scanner
 * emite a ~7Hz, e cada set() da store notifica todos os assinantes — incluindo
 * o canvas. Manter isto aqui é a mesma regra que mantém pan/zoom fora da store.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, UUID } from '@shared/types'
import { viewport } from '../canvas/viewport'
import { ContextMenu } from '../context-menu'
import { PROJECT_DRAG_TYPE } from '../drag'
import { DESCRIBE_PROJECTS_ENABLED } from '../feature-flags'
import { IconMore, IconPin, IconPlus, IconSearch } from '../icons'
import { truncateStart } from '../paths'
import { store, useStore } from '../state/store'
import { QUICK_STARTS } from '../terminal-presets'

/** Só os presets que sobem um agente: um shell puro não descreveria nada. */
const AGENT_PRESETS = QUICK_STARTS.filter((p) => p.command.length > 0)

interface MenuState {
  id: UUID
  x: number
  y: number
}

interface Progress {
  scannedDirs: number
  found: number
  currentPath: string
}

/** Acima disto a lista deixa de ser legível e só custa render a cada tecla. */
const MAX_VISIBLE = 200

interface Props {
  /**
   * 'picker' é a MESMA lista, sem as ações que não pertencem a "escolher um
   * projeto": varredura, favoritar, levar para o canvas. Ela é a coluna 1 da
   * cascata quando Arquivos ou Git ainda não têm projeto — e é literalmente a
   * lista de sempre, porque duas listas de projeto seriam duas listas para
   * manter em pé.
   */
  mode?: 'full' | 'picker'
  /** Chamado depois de escolher um projeto — a cascata avança com isso. */
  onPick?: (id: UUID) => void
  /** Presente = o painel oferece "fixar no canvas", e avisa quando foi pedido. */
  onPin?: () => void
  /**
   * O que mostrar SOBRE o projeto escolhido, logo abaixo dele.
   *
   * Com detalhe, a lista se recolhe ao item selecionado: só se escolhe um
   * projeto por vez, e manter os outros 22 embaixo do escolhido é oferecer uma
   * escolha que já foi feita. Clicar nele de novo desmarca e a lista volta —
   * é o mesmo clique nos dois sentidos, e por isso não precisa de um "voltar".
   */
  detail?: React.ReactNode
}

export function ProjectPanel({ mode = 'full', onPick, onPin, detail }: Props = {}): JSX.Element {
  const { projects, projectQuery, scanning, workspace, prefs, selectedProjectId } = useStore()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [scannerError, setScannerError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  // Piscada no projeto recém-adicionado: sem isso ele cai em ordem alfabética
  // no meio de dezenas e o usuário não vê que a ação fez alguma coisa.
  const [addedId, setAddedId] = useState<UUID | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  // Último agente escolhido para descrever. Não é fixo — nem todos usam o
  // mesmo — e é ele que a descrição automática do fim do scan reaproveita.
  const [scannerCommand, setScannerCommand] = useState(AGENT_PRESETS[0]?.command ?? 'claude')

  useEffect(() => {
    void store.loadProjects()
  }, [])

  // O assinante do scan-done é montado uma vez só; o comando do agente muda
  // com o select. Um ref evita reassinar o evento a cada troca.
  const startScannerRef = useRef<() => void>(() => {})

  useEffect(() => {
    const offProgress = window.atelier.events.onScanProgress((p) =>
      setProgress({ scannedDirs: p.scannedDirs, found: p.found, currentPath: p.currentPath })
    )
    const offDone = window.atelier.events.onScanDone(() => {
      setProgress(null)
      void store.finishScan().then((shouldDescribe) => {
        if (shouldDescribe) startScannerRef.current()
      })
    })
    const offChanged = window.atelier.events.onProjectsChanged(() => void store.loadProjects())
    return () => {
      offProgress()
      offDone()
      offChanged()
    }
  }, [])

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (!menu && !moreMenu) return
    const close = (): void => {
      setMenu(null)
      setMoreMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, moreMenu])

  const visible = useMemo(() => {
    const q = projectQuery.trim().toLowerCase()
    const matches = q
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.path.toLowerCase().includes(q) ||
            p.kind.toLowerCase().includes(q) ||
            p.stack.some((s) => s.toLowerCase().includes(q))
        )
      : projects
    // Favoritos primeiro, arquivados por último: a ordem em que se procura.
    return [...matches]
      .sort((a, b) => {
        if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, MAX_VISIBLE)
  }, [projects, projectQuery])

  /** Nasce no centro da viewport, como qualquer nó criado por ação de UI. */
  const addToCanvas = (project: Project): void => {
    setMenu(null)
    const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
    void store.addProjectToWorkspace(project.id, { x: c.x - 150, y: c.y - 210 })
  }

  const newAgentHere = (project: Project): void => {
    setMenu(null)
    store.openNewTerminal(null, project.path)
  }

  const startScanner = (command = scannerCommand): void => {
    setMenu(null)
    setMoreMenu(null)
    setScannerCommand(command)
    const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
    void store.startScannerAgent({ x: c.x - 280, y: c.y - 180 }, command).then((failure) => {
      setScannerError(failure)
    })
  }

  const addFolder = async (): Promise<void> => {
    const { error, added } = await store.addProjectFolder()
    if (error) setScannerError(error)
    if (!added) return
    setScannerError(null)
    setAddedId(added.id)
    document.querySelector(`[data-project-id="${added.id}"]`)?.scrollIntoView({ block: 'nearest' })
    setTimeout(() => setAddedId((id) => (id === added.id ? null : id)), 1600)
  }

  /** Fechar sempre limpa: uma lista filtrada sem o campo à vista mente. */
  const toggleSearch = (): void => {
    if (searchOpen) store.setProjectQuery('')
    setSearchOpen(!searchOpen)
  }

  startScannerRef.current = () => startScanner()

  const selected = menu ? projects.find((p) => p.id === menu.id) ?? null : null
  // Buscado no índice inteiro, e não em `visible`: o escolhido pode estar além
  // do corte de MAX_VISIBLE, e aí a coluna recolhida ficaria vazia.
  const chosen = projects.find((p) => p.id === selectedProjectId) ?? null
  const pendingCount = projects.filter((p) => !p.isArchived && !p.enrichedAt).length
  const picker = mode === 'picker'
  /**
   * Uma busca ativa desfaz o recolhimento: filtrar uma lista escondida não teria
   * como mostrar o resultado, e o campo de busca aberto sobre um item só seria
   * uma promessa que a coluna não cumpre.
   */
  const collapsed = Boolean(detail) && chosen !== null && !projectQuery.trim()

  return (
    <>
      <div className="panel-header">
        <span>Projetos {projects.length > 0 && <em className="panel-count">{projects.length}</em>}</span>
        <div className="panel-header-actions">
          {onPin && (
            <button
              type="button"
              className="icon-btn ghost-btn rail-pin"
              onClick={onPin}
              title="Fixar este painel no canvas"
            >
              <IconPin size={15} />
            </button>
          )}
          <button type="button" className="icon-btn ghost-btn" onClick={() => void addFolder()} title="Adicionar projeto…">
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className={searchOpen || projectQuery ? 'icon-btn ghost-btn is-active' : 'icon-btn ghost-btn'}
            onClick={toggleSearch}
            title="Buscar projeto"
            disabled={projects.length === 0}
          >
            <IconSearch size={15} />
          </button>
          {/* O seletor não escaneia nem configura varredura: ali a lista
              existe para UMA coisa, escolher um projeto. Renderização
              condicional e não `hidden`: o atributo põe display:none no nível
              do agente de usuário, e o `display: flex` de .icon-btn vence. */}
          {!picker && (
            <button
              type="button"
              className={moreMenu ? 'icon-btn ghost-btn is-active' : 'icon-btn ghost-btn'}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMoreMenu(moreMenu ? null : { x: r.right, y: r.bottom + 4 })
              }}
              title="Mais opções"
            >
              <IconMore size={15} />
            </button>
          )}
        </div>
      </div>

      {projects.length > 0 && searchOpen && (
        <div className="panel-search">
          <input
            ref={searchInput}
            className="project-search"
            value={projectQuery}
            placeholder="Buscar projeto…"
            onChange={(e) => store.setProjectQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleSearch()
            }}
          />
        </div>
      )}

      {scanning && (
        <div className="scan-progress">
          <div className="scan-progress-line">
            <strong>{progress?.found ?? 0}</strong> encontrados
            <span>{progress?.scannedDirs ?? 0} pastas</span>
          </div>
          <div className="scan-progress-path" title={progress?.currentPath}>
            {truncateStart(progress?.currentPath ?? '', 30)}
          </div>
          <button type="button" className="btn" onClick={() => store.cancelScan()}>
            Cancelar
          </button>
        </div>
      )}

      {!scanning && projects.length === 0 && (
        <div className="project-empty">
          <p>Nenhum projeto no índice ainda.</p>
          <button type="button" className="btn is-primary" onClick={() => void addFolder()}>
            Adicionar projeto
          </button>
          <button type="button" className="btn" onClick={() => store.openScanDialog()}>
            Escanear a pasta pessoal
          </button>
        </div>
      )}

      {scannerError && <p className="scan-error">{scannerError}</p>}

      <ul className={collapsed ? 'project-list is-collapsed' : 'project-list'}>
        {(collapsed && chosen ? [chosen] : visible).map((project) => (
          <li key={project.id}>
            <button
              type="button"
              data-project-id={project.id}
              // Arrastar para o canvas: o alvo do drop decide o que nasce.
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)
                e.dataTransfer.effectAllowed = 'copy'
                setMenu(null)
              }}
              className={[
                'project-item',
                project.isArchived ? 'is-archived' : '',
                project.id === addedId ? 'is-new' : '',
                project.id === selectedProjectId ? 'is-selected' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={project.path}
              // Um clique escolhe de quem é a árvore da coluna Arquivos; o
              // clique no que JÁ está escolhido desmarca. Só há uma seleção,
              // então o mesmo alvo tem de servir para desfazê-la.
              onClick={() => {
                if (project.id === selectedProjectId) {
                  store.selectProject(null)
                  return
                }
                store.selectProject(project.id)
                onPick?.(project.id)
              }}
              onDoubleClick={() => addToCanvas(project)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: project.id, x: e.clientX, y: e.clientY })
              }}
            >
              <span className="project-item-top">
                <span className="project-name">
                  {project.isFavorite && <span className="project-star">★</span>}
                  {project.name}
                </span>
                <span className="project-kind">{project.kind}</span>
              </span>
              <span className="project-path">{truncateStart(project.path, 30)}</span>
              {/* `title` porque a linha trunca: com o detalhe não repetindo
                  mais a descrição, o hover é o único lugar onde ela cabe
                  inteira. */}
              {project.description && (
                <span className="project-desc" title={project.description}>
                  {project.description}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {/* Abaixo do item, e não numa coluna ao lado: o detalhe é DAQUELE projeto,
          e uma segunda coluna o desgruda do que ele descreve. A rolagem é dele,
          não da lista — que aqui tem uma linha só. */}
      {collapsed && <div className="project-detail">{detail}</div>}

      {moreMenu && (
        <ContextMenu x={moreMenu.x} y={moreMenu.y} align="right">
          <button
            type="button"
            disabled={scanning}
            onClick={() => {
              setMoreMenu(null)
              store.openScanDialog()
            }}
          >
            {scanning ? 'Escaneando…' : 'Escanear projetos…'}
          </button>

          <div className="context-menu-sep" />

          <button
            type="button"
            onClick={() => {
              setMoreMenu(null)
              void store.setAutoScanOnLaunch(!prefs?.autoScanOnLaunch)
            }}
          >
            {prefs?.autoScanOnLaunch ? '✓ ' : '\u2007 '}Varrer ao abrir o app
          </button>

          {DESCRIBE_PROJECTS_ENABLED && (
            <>
              <div className="context-menu-sep" />
              {pendingCount === 0 ? (
                <div className="context-menu-label">Todos os projetos descritos</div>
              ) : (
                <>
                  <div className="context-menu-label">
                    {pendingCount} sem descrição · descrever com
                  </div>
                  {AGENT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={!workspace}
                      onClick={() => startScanner(preset.command)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </ContextMenu>
      )}

      {menu && selected && (
        <ContextMenu x={menu.x} y={menu.y}>
          <button type="button" disabled={!workspace} onClick={() => addToCanvas(selected)}>
            Adicionar ao workspace
          </button>
          <button type="button" disabled={!workspace} onClick={() => newAgentHere(selected)}>
            Novo agente aqui
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              store.showProjectFiles(selected.id)
            }}
          >
            Ver arquivos
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              store.showProjectGit(selected.id)
            }}
          >
            Ver Git
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void store.patchProject(selected.id, { isFavorite: !selected.isFavorite })
            }}
          >
            {selected.isFavorite ? 'Desfavoritar' : 'Favoritar'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void window.atelier.fs.reveal(selected.path)
            }}
          >
            Revelar no sistema
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void store.removeProject(selected.id)
            }}
          >
            Remover do índice
          </button>
        </ContextMenu>
      )}
    </>
  )
}
