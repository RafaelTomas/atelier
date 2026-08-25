/**
 * Lista de workspaces — o conteúdo que a Sidebar tinha antes de ganhar abas.
 * Extração literal: nenhum comportamento mudou.
 */
import { useEffect, useState } from 'react'
import type { UUID } from '@shared/types'
import { store, useStore } from '../state/store'

interface MenuState {
  id: UUID
  x: number
  y: number
}

export function WorkspacePanel(): JSX.Element {
  const { entries, activeId } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<UUID | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const submit = (): void => {
    const trimmed = name.trim()
    if (trimmed) void store.createWorkspace(trimmed)
    setName('')
    setCreating(false)
  }

  // Um clique/Escape em qualquer lugar fecha o menu, como qualquer menu nativo.
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

  const startRename = (id: UUID, current: string): void => {
    setMenu(null)
    setRenamingId(id)
    setRenameValue(current)
  }

  const commitRename = (): void => {
    if (renamingId) void store.renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
    setRenameValue('')
  }

  return (
    <>
      <div className="sidebar-header">
        <span>Workspaces</span>
        <div className="sidebar-header-actions">
          <button type="button" className="ghost-btn" onClick={() => setCreating(true)} title="Novo workspace">
            +
          </button>
        </div>
      </div>

      <ul className="workspace-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            {renamingId === entry.id ? (
              <input
                autoFocus
                className="workspace-rename"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={commitRename}
              />
            ) : (
              <button
                type="button"
                className={entry.id === activeId ? 'workspace-item is-active' : 'workspace-item'}
                onClick={() => void store.openWorkspace(entry.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ id: entry.id, x: e.clientX, y: e.clientY })
                }}
              >
                <span className="workspace-dot" data-color={entry.color} />
                {entry.name}
              </button>
            )}
          </li>
        ))}
      </ul>

      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() =>
              startRename(menu.id, entries.find((w) => w.id === menu.id)?.name ?? '')
            }
          >
            Renomear
          </button>
        </div>
      )}

      {creating && (
        <div className="sidebar-create">
          <input
            autoFocus
            value={name}
            placeholder="Nome do workspace"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') setCreating(false)
            }}
            onBlur={submit}
          />
        </div>
      )}
    </>
  )
}
