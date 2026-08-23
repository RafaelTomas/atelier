import { useState } from 'react'
import { store, useStore } from './state/store'

export function Sidebar(): JSX.Element {
  const { entries, activeId } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const submit = (): void => {
    const trimmed = name.trim()
    if (trimmed) void store.createWorkspace(trimmed)
    setName('')
    setCreating(false)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Workspaces</span>
        <button type="button" className="ghost-btn" onClick={() => setCreating(true)} title="Novo workspace">
          +
        </button>
      </div>

      <ul className="workspace-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={entry.id === activeId ? 'workspace-item is-active' : 'workspace-item'}
              onClick={() => void store.openWorkspace(entry.id)}
            >
              <span className="workspace-dot" data-color={entry.color} />
              {entry.name}
            </button>
          </li>
        ))}
      </ul>

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
    </aside>
  )
}
