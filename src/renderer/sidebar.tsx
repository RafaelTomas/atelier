/**
 * Casca do painel lateral: escolhe entre Workspaces e Projetos.
 *
 * Abas e não duas seções empilhadas: a sidebar tem 220px de largura, e duas
 * áreas de rolagem numa coluna dessa largura deixam as duas inutilizáveis.
 */
import { useState } from 'react'
import { ProjectPanel } from './panels/project-panel'
import { WorkspacePanel } from './panels/workspace-panel'
import { store } from './state/store'

type Tab = 'workspaces' | 'projetos'

export function Sidebar(): JSX.Element {
  const [tab, setTab] = useState<Tab>('workspaces')

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <div className="segmented">
          <button
            type="button"
            className={tab === 'workspaces' ? 'segment is-active' : 'segment'}
            onClick={() => setTab('workspaces')}
          >
            Workspaces
          </button>
          <button
            type="button"
            className={tab === 'projetos' ? 'segment is-active' : 'segment'}
            onClick={() => setTab('projetos')}
          >
            Projetos
          </button>
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
    </aside>
  )
}
