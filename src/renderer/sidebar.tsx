/**
 * Casca do painel lateral: escolhe entre Workspaces e Projetos, e é o que se
 * arrasta para mudar a largura.
 *
 * Abas e não duas seções empilhadas: numa coluna dessa largura, duas áreas de
 * rolagem deixam as duas inutilizáveis.
 */
import { useEffect, useRef } from 'react'
import { ProjectPanel } from './panels/project-panel'
import { WorkspacePanel } from './panels/workspace-panel'
import { useState } from 'react'
import { store, useStore } from './state/store'

type Tab = 'workspaces' | 'projetos'

const TABS: Array<[Tab, string]> = [
  ['workspaces', 'Workspaces'],
  ['projetos', 'Projetos']
]

/** Padrão, e os limites do arrasto. O teto relativo é aplicado à parte. */
export const SIDEBAR_WIDTH = { default: 220, min: 180, max: 480 }

/** Fração da janela que a sidebar nunca passa — numa tela pequena, o teto fixo
 *  de 480px engoliria o canvas. */
const MAX_FRACTION = 0.4

function clampWidth(px: number): number {
  const ceiling = Math.min(SIDEBAR_WIDTH.max, window.innerWidth * MAX_FRACTION)
  return Math.round(Math.max(SIDEBAR_WIDTH.min, Math.min(ceiling, px)))
}

function applyWidth(px: number): void {
  document.documentElement.style.setProperty('--sidebar-width', `${px}px`)
}

export function Sidebar(): JSX.Element {
  const { prefs } = useStore()
  const [tab, setTab] = useState<Tab>('workspaces')
  const dragging = useRef(false)

  // A largura vem das preferências e vai direto para o CSS var. Não entra na
  // store: durante o arrasto isso seria um set() por frame, e cada set()
  // notifica TODOS os assinantes, canvas incluído.
  useEffect(() => {
    if (prefs) applyWidth(clampWidth(prefs.sidebarWidth))
  }, [prefs?.sidebarWidth])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragging.current = true
    // Sem captura o arrasto morre assim que o ponteiro entra no canvas — que é
    // onde ele passa quase todo o gesto.
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    applyWidth(clampWidth(e.clientX))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    // Uma gravação só, no fim do gesto.
    void store.setSidebarWidth(clampWidth(e.clientX))
  }

  const resetWidth = (): void => {
    applyWidth(SIDEBAR_WIDTH.default)
    void store.setSidebarWidth(SIDEBAR_WIDTH.default)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <div className="segmented">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'segment is-active' : 'segment'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => store.toggleSidebar()}
          title="Recolher painel"
        >
          «
        </button>
      </div>

      {tab === 'workspaces' ? <WorkspacePanel /> : <ProjectPanel />}

      <div
        className="sidebar-resizer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={resetWidth}
        title="Arraste para redimensionar · duplo clique para o padrão"
      />
    </aside>
  )
}
