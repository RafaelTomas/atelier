/**
 * Casca do nó — porte de NodeShellView.
 *
 * Posiciona em coordenadas de canvas (o contêiner pai é que tem o transform),
 * desenha header, borda de seleção, alça de resize e o ponto de conexão.
 */
import type { AgentRole, CanvasNode, TerminalTheme, UUID } from '@shared/types'
import { Icon } from '../node-icons'
import { store } from '../state/store'
import { NoteNode } from './note-node'
import { TerminalNode } from './terminal-node'
import { TextNode } from './text-node'
import { PortalNode, portalLabel } from './portal-node'
import { PlaceholderNode } from './placeholder-node'

interface Props {
  node: CanvasNode
  selected: boolean
  workspaceId: UUID
  /** Responsabilidade do terminal, resolvida pelo canvas (null se não tem). */
  role?: AgentRole | null
  /** Temas de terminal do usuário — vêm de cima para não assinar a store por nó. */
  customThemes?: TerminalTheme[]
}

function title(node: CanvasNode): string {
  switch (node.content.type) {
    case 'terminal':
      return node.content.value.name
    case 'stickyNote':
      return node.content.value.fileName?.replace(/\.md$/, '') ?? 'Note'
    case 'portal':
      // O host, não o nome: vários portais abertos ficariam todos "Portal".
      return portalLabel(node.content.value)
    case 'fileTree':
      return node.content.value.name
    default:
      return node.content.type
  }
}

/** Text é o único sem chrome — igual ao app nativo. */
function isChromeless(node: CanvasNode): boolean {
  return node.content.type === 'text'
}

export function NodeShell({
  node,
  selected,
  workspaceId,
  role = null,
  customThemes = []
}: Props): JSX.Element {
  const { frame } = node
  const terminal = node.content.type === 'terminal' ? node.content.value : null

  const body = ((): JSX.Element => {
    switch (node.content.type) {
      case 'terminal':
        return (
          <TerminalNode
            node={node}
            content={node.content.value}
            workspaceId={workspaceId}
            customThemes={customThemes}
          />
        )
      case 'stickyNote':
        return <NoteNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'text':
        return <TextNode node={node} content={node.content.value} />
      case 'portal':
        return <PortalNode node={node} content={node.content.value} workspaceId={workspaceId} />
      default:
        return <PlaceholderNode type={node.content.type} />
    }
  })()

  return (
    <div
      data-node-id={node.id}
      className={[
        'node',
        `node-${node.content.type}`,
        selected ? 'is-selected' : '',
        isChromeless(node) ? 'is-chromeless' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        zIndex: node.zIndex
      }}
    >
      {!isChromeless(node) && (
        <div className="node-header">
          {terminal && (
            <span className="node-icon" style={{ color: terminal.color }}>
              <Icon name={terminal.icon} size={14} />
            </span>
          )}
          <span className="node-title">{title(node)}</span>
          {terminal?.isManager && (
            <span className="node-badge is-manager" title="Maestro deste canvas">
              maestro
            </span>
          )}
          {role && (
            <span className="node-badge" style={{ color: role.color }} title={role.instructions || role.name}>
              {role.name}
            </span>
          )}
          <div className="node-header-actions">
            <button
              type="button"
              className="node-btn"
              title="Conectar a outro nó"
              onMouseDown={(e) => {
                e.stopPropagation()
                store.startConnecting(node.id)
              }}
            >
              ⇄
            </button>
            <button
              type="button"
              className="node-btn"
              title="Remover nó"
              onMouseDown={(e) => {
                e.stopPropagation()
                void store.removeNode(node.id)
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="node-body">{body}</div>

      <div data-resize-handle className="resize-handle" />
    </div>
  )
}
