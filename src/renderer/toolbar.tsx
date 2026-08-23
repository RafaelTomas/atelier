import { viewport } from './canvas/viewport'
import { store, useStore } from './state/store'

/** Cria o nó no centro da viewport atual. */
function centerOfViewport(): { x: number; y: number } {
  return viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
}

export function Toolbar(): JSX.Element {
  const { workspace, connectingFrom } = useStore()

  const add = (kind: 'terminal' | 'note' | 'text'): void => {
    const c = centerOfViewport()
    void store.addNode(kind, { x: c.x - 120, y: c.y - 80 })
  }

  return (
    <header className="toolbar">
      <div className="toolbar-title">{workspace?.name ?? '—'}</div>

      <div className="toolbar-actions">
        <button type="button" onClick={() => add('terminal')}>+ Terminal</button>
        <button type="button" onClick={() => add('note')}>+ Nota</button>
        <button type="button" onClick={() => add('text')}>+ Texto</button>

        <span className="toolbar-sep" />

        <button type="button" onClick={() => viewport.setZoom(viewport.zoom - 0.25)}>−</button>
        <button type="button" onClick={() => viewport.setZoom(1)}>100%</button>
        <button type="button" onClick={() => viewport.setZoom(viewport.zoom + 0.25)}>+</button>

        <span className="toolbar-sep" />

        <button type="button" onClick={() => void window.atelier.workspace.saveNow()}>Salvar</button>
      </div>

      {connectingFrom && (
        <div className="connecting-hint">
          clique no nó de destino para conectar · Esc cancela
        </div>
      )}
    </header>
  )
}
