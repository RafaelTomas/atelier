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
import { IconMore, IconPlus, IconSearch } from '../icons'
import { truncateStart } from '../paths'
import { store, useStore } from '../state/store'

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

export function ProjectPanel(): JSX.Element {
  const { projects, projectQuery, scanning, workspace } = useStore()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  // Piscada no projeto recém-adicionado: sem isso ele cai em ordem alfabética
  // no meio de dezenas e o usuário não vê que a ação fez alguma coisa.
  const [addedId, setAddedId] = useState<UUID | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    void store.loadProjects()
  }, [])

  useEffect(() => {
    const offProgress = window.atelier.events.onScanProgress((p) =>
      setProgress({ scannedDirs: p.scannedDirs, found: p.found, currentPath: p.currentPath })
    )
    const offDone = window.atelier.events.onScanDone(() => {
      setProgress(null)
      void store.finishScan()
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

  const addFolder = async (): Promise<void> => {
    const { error: failure, added } = await store.addProjectFolder()
    if (failure) setError(failure)
    if (!added) return
    setError(null)
    setAddedId(added.id)
    document.querySelector(`[data-project-id="${added.id}"]`)?.scrollIntoView({ block: 'nearest' })
    setTimeout(() => setAddedId((id) => (id === added.id ? null : id)), 1600)
  }

  /** Fechar sempre limpa: uma lista filtrada sem o campo à vista mente. */
  const toggleSearch = (): void => {
    if (searchOpen) store.setProjectQuery('')
    setSearchOpen(!searchOpen)
  }

  const selected = menu ? projects.find((p) => p.id === menu.id) ?? null : null

  return (
    <>
      <div className="sidebar-header">
        <span>Projetos {projects.length > 0 && <em className="sidebar-count">{projects.length}</em>}</span>
        <div className="sidebar-header-actions">
          <button type="button" className="ghost-btn" onClick={() => void addFolder()} title="Adicionar projeto…">
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className={searchOpen || projectQuery ? 'ghost-btn is-active' : 'ghost-btn'}
            onClick={toggleSearch}
            title="Buscar projeto"
            disabled={projects.length === 0}
          >
            <IconSearch size={15} />
          </button>
          <button
            type="button"
            className={moreMenu ? 'ghost-btn is-active' : 'ghost-btn'}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMoreMenu(moreMenu ? null : { x: r.right, y: r.bottom + 4 })
            }}
            title="Mais opções"
          >
            <IconMore size={15} />
          </button>
        </div>
      </div>

      {projects.length > 0 && searchOpen && (
        <div className="sidebar-search">
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

      {error && <p className="scan-error">{error}</p>}

      <ul className="project-list">
        {visible.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              data-project-id={project.id}
              className={[
                'project-item',
                project.isArchived ? 'is-archived' : '',
                project.id === addedId ? 'is-new' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              title={project.path}
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
              {project.description && <span className="project-desc">{project.description}</span>}
            </button>
          </li>
        ))}
      </ul>

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
