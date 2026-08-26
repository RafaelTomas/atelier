/**
 * Casca do painel lateral: escolhe entre Workspaces, Projetos e Arquivos, e é o
 * que se arrasta para mudar a largura.
 *
 * Abas e não seções empilhadas: numa coluna dessa largura, três áreas de
 * rolagem deixariam as três inutilizáveis.
 */
import { useEffect, useRef } from 'react'
import { IconBranch, IconCube, IconFolder, IconWindows } from './icons'
import { FilesPanel } from './panels/files-panel'
import { GitPanel } from './panels/git-panel'
import { ProjectPanel } from './panels/project-panel'
import { WorkspacePanel } from './panels/workspace-panel'
import { store, useStore, type SidebarTab } from './state/store'

/**
 * Ícone em vez de rótulo, e o nome só no hover.
 *
 * Com quatro abas os rótulos não cabiam: pedem ~162px de texto num pill de
 * ~166px na largura padrão, e qualquer recuo lateral os fazia truncar
 * ("Worksp…"). Um nome pela metade não identifica nada — o ícone identifica, e
 * o nome inteiro fica a um hover de distância.
 *
 * A legenda é em inglês porque é o vocabulário do domínio aqui: workspace,
 * project, file, git são os mesmos termos do formato em disco e do CLI.
 */
interface Tab {
  id: SidebarTab
  icon: (p: { size?: number }) => JSX.Element
  /** Legenda do hover, e também o nome acessível do botão. */
  label: string
}

const TABS: Tab[] = [
  { id: 'workspaces', icon: IconWindows, label: 'Workspaces' },
  { id: 'projetos', icon: IconCube, label: 'Projects' },
  { id: 'arquivos', icon: IconFolder, label: 'Files' },
  { id: 'git', icon: IconBranch, label: 'Git' }
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
  const { prefs, sidebarTab: tab } = useStore()
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
    <aside className="floating sidebar">
      <div className="sidebar-tabs">
        <div className="segmented">
          {TABS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'segment is-active' : 'segment'}
              title={label}
              aria-label={label}
              aria-pressed={tab === id}
              onClick={() => store.setSidebarTab(id)}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn ghost-btn"
          onClick={() => store.toggleSidebar()}
          title="Recolher painel"
        >
          «
        </button>
      </div>

      {tab === 'workspaces' && <WorkspacePanel />}
      {tab === 'projetos' && <ProjectPanel />}
      {tab === 'arquivos' && <FilesPanel />}
      {tab === 'git' && <GitPanel />}

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
