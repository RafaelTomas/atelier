import { useEffect, useState } from 'react'
import { viewport } from './canvas/viewport'
import { store, useStore } from './state/store'
import type { ThemeMode } from './theme'

const THEMES: { id: ThemeMode; icon: string; label: string }[] = [
  { id: 'system', icon: '◑', label: 'Sistema' },
  { id: 'light', icon: '☀', label: 'Claro' },
  { id: 'dark', icon: '☾', label: 'Escuro' }
]

export function Toolbar(): JSX.Element {
  const { workspace, connectingFrom, placing, notice, sidebarCollapsed, theme } = useStore()
  const [themeMenu, setThemeMenu] = useState(false)

  useEffect(() => {
    if (!themeMenu) return
    const close = (): void => setThemeMenu(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setThemeMenu(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [themeMenu])

  return (
    <header className={sidebarCollapsed ? 'toolbar has-window-controls' : 'toolbar'}>
      {sidebarCollapsed && (
        <button
          type="button"
          className="ghost-btn toolbar-reveal"
          onClick={() => store.toggleSidebar()}
          title="Mostrar workspaces"
        >
          ☰
        </button>
      )}
      <div className="toolbar-title">{workspace?.name ?? '—'}</div>

      {/* Criar nós e desenhar mudaram para a dock (renderer/dock.tsx). Aqui
          fica só o que é da JANELA: zoom, tema e gravação. */}
      <div className="toolbar-actions">
        <button type="button" onClick={() => viewport.setZoom(viewport.zoom - 0.25)}>−</button>
        <button type="button" onClick={() => viewport.setZoom(1)}>100%</button>
        <button type="button" onClick={() => viewport.setZoom(viewport.zoom + 0.25)}>+</button>

        <span className="toolbar-sep" />

        <div className="theme-picker" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            title={`Tema: ${THEMES.find((t) => t.id === theme)?.label ?? 'Sistema'}`}
            onClick={() => setThemeMenu((v) => !v)}
          >
            {THEMES.find((t) => t.id === theme)?.icon ?? '◑'}
          </button>
          {themeMenu && (
            <div className="context-menu theme-menu">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    store.setTheme(t.id)
                    setThemeMenu(false)
                  }}
                >
                  <span className="theme-check">{theme === t.id ? '✓' : ''}</span>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" onClick={() => void window.atelier.workspace.saveNow()}>Salvar</button>
      </div>

      {connectingFrom && (
        <div className="connecting-hint">
          clique no nó de destino para conectar · Esc cancela
        </div>
      )}

      {notice && (
        <button type="button" className="connecting-hint is-notice" onClick={() => store.dismissNotice()}>
          {notice}
        </button>
      )}

      {placing && (
        <div className="connecting-hint">
          arraste no canvas para definir a área {articleFor(placing.label)} · clique só
          usa o tamanho padrão · Esc cancela
        </div>
      )}
    </header>
  )
}

/** "da nota" / "do terminal" — o rótulo do item vem sem artigo. */
function articleFor(label: string): string {
  const feminine = /^(nota|legenda|árvore)/.test(label)
  return `${feminine ? 'da' : 'do'} ${label}`
}
