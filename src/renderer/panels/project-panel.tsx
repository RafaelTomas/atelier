/**
 * Painel de projetos: o índice global, com busca e as ações que levam um
 * projeto para o canvas.
 *
 * O progresso da varredura fica em useState LOCAL, não na store. O scanner
 * emite a ~7Hz, e cada set() da store notifica todos os assinantes — incluindo
 * o canvas. Manter isto aqui é a mesma regra que mantém pan/zoom fora da store.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Project, UUID } from '@shared/types'
import { viewport } from '../canvas/viewport'
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
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

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

  const newAgentHere = (project: Project): void => {
    setMenu(null)
    store.openNewTerminal(null, project.path)
  }

  const selected = menu ? projects.find((p) => p.id === menu.id) ?? null : null

  return (
    <>
      <div className="sidebar-header">
        <span>Projetos {projects.length > 0 && <em className="sidebar-count">{projects.length}</em>}</span>
        <div className="sidebar-header-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => store.openScanDialog()}
            title="Escanear projetos"
            disabled={scanning}
          >
            ⟳
          </button>
        </div>
      </div>

      {projects.length > 0 && (
        <div className="sidebar-create">
          <input
            className="project-search"
            value={projectQuery}
            placeholder="Buscar projeto…"
            onChange={(e) => store.setProjectQuery(e.target.value)}
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
          <button type="button" className="btn is-primary" onClick={() => store.openScanDialog()}>
            Escanear projetos
          </button>
        </div>
      )}

      <ul className="project-list">
        {visible.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className={project.isArchived ? 'project-item is-archived' : 'project-item'}
              title={project.path}
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

      {menu && selected && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>
      )}
    </>
  )
}
