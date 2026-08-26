/**
 * O que flutua SOBRE o canvas: nome do workspace, controles de vista e avisos.
 *
 * Substitui a antiga barra de topo. A troca não é cosmética: a barra ocupava
 * 46px de altura em toda a largura da janela para mostrar um nome e três
 * botões, e o canvas é o produto. Agora cada peça fica no canto onde ela é
 * procurada, e o meio da tela é todo do trabalho.
 *
 * Mora aqui, e não dentro do CanvasView, porque o aviso precisa aparecer mesmo
 * sem workspace aberto — que é justamente quando algo deu errado.
 */
import { useEffect, useState } from 'react'
import { viewport } from './canvas/viewport'
import { GitMenu } from './git-menu'
import { store, useStore } from './state/store'
import type { ThemeMode } from './theme'

const THEMES: { id: ThemeMode; icon: string; label: string }[] = [
  { id: 'system', icon: '◑', label: 'Sistema' },
  { id: 'light', icon: '☀', label: 'Claro' },
  { id: 'dark', icon: '☾', label: 'Escuro' }
]

export function CanvasChrome(): JSX.Element {
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
    <>
      {/* Com a sidebar aberta o chip desvia para a direita dela: a sidebar
          flutua sobre o canvas, então sem o desvio o nome ficaria por baixo. */}
      <div className={sidebarCollapsed ? 'canvas-chip-row' : 'canvas-chip-row is-shifted'}>
        {sidebarCollapsed && (
          <button
            type="button"
            className="canvas-chip is-icon"
            onClick={() => store.toggleSidebar()}
            title="Mostrar painel"
          >
            ☰
          </button>
        )}
        <div className="canvas-chip" title={workspace?.workingDirectory || undefined}>
          {workspace?.name ?? '—'}
        </div>
      </div>

      <ViewControls theme={theme} themeMenu={themeMenu} setThemeMenu={setThemeMenu} />

      {connectingFrom && (
        <div className="canvas-hint">clique no nó de destino para conectar · Esc cancela</div>
      )}

      {placing && (
        <div className="canvas-hint">
          arraste no canvas para definir a área {articleFor(placing.label)} · clique só usa o
          tamanho padrão · Esc cancela
        </div>
      )}

      {notice && (
        <button type="button" className="canvas-hint is-notice" onClick={() => store.dismissNotice()}>
          {notice}
        </button>
      )}
    </>
  )
}

/**
 * Zoom, tema e gravar. O que é da VISTA e da janela — nada de criar nó, que é
 * assunto da dock.
 */
function ViewControls({
  theme,
  themeMenu,
  setThemeMenu
}: {
  theme: ThemeMode
  themeMenu: boolean
  setThemeMenu: (fn: (v: boolean) => boolean) => void
}): JSX.Element {
  const [zoom, setZoom] = useState(viewport.zoom)

  // Assina o viewport direto, sem passar pela store — pan e zoom fora do React
  // é a regra 5 da migração. E só re-renderiza quando o número MOSTRADO muda:
  // sem isso, cada pixel de pan repintaria este cluster.
  useEffect(
    () =>
      viewport.subscribe((v) =>
        setZoom((current) =>
          Math.round(v.zoom * 100) === Math.round(current * 100) ? current : v.zoom
        )
      ),
    []
  )

  return (
    <div className="view-controls">
      {/* Git antes do zoom: é ação sobre o PROJETO, e as outras são sobre a
          vista. Junto delas, o commit ficaria a um clique do botão de zoom. */}
      <div className="vc-group is-git">
        <GitMenu />
      </div>

      <div className="vc-group">
        <button type="button" title="Afastar" onClick={() => viewport.setZoom(viewport.zoom - 0.25)}>
          −
        </button>
        <button
          type="button"
          className="vc-zoom"
          title="Voltar a 100%"
          onClick={() => viewport.setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" title="Aproximar" onClick={() => viewport.setZoom(viewport.zoom + 0.25)}>
          +
        </button>
      </div>

      <div className="vc-group theme-picker" onMouseDown={(e) => e.stopPropagation()}>
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
                  setThemeMenu(() => false)
                }}
              >
                <span className="theme-check">{theme === t.id ? '✓' : ''}</span>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="vc-group">
        <button type="button" onClick={() => void store.saveNow()}>
          Salvar
        </button>
      </div>
    </div>
  )
}

/** "da nota" / "do terminal" — o rótulo do item vem sem artigo. */
function articleFor(label: string): string {
  const feminine = /^(nota|legenda|árvore)/.test(label)
  return `${feminine ? 'da' : 'do'} ${label}`
}
