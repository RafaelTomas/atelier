/**
 * Casca do nó — porte de NodeShellView.
 *
 * Posiciona em coordenadas de canvas (o contêiner pai é que tem o transform),
 * desenha header, borda de seleção, alça de resize e o ponto de conexão.
 */
import type { CanvasNode, UUID } from '@shared/types'
import { store } from '../state/store'
import { NoteNode } from './note-node'
import { TerminalNode } from './terminal-node'
import { TextNode } from './text-node'
import { PlaceholderNode } from './placeholder-node'

interface Props {
  node: CanvasNode
  selected: boolean
  workspaceId: UUID
}

function title(node: CanvasNode): string {
  switch (node.content.type) {
    case 'terminal':
      return node.content.value.name
    case 'stickyNote':
      return node.content.value.fileName?.replace(/\.md$/, '') ?? 'Note'
    case 'portal':
      return node.content.value.name
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

export function NodeShell({ node, selected, workspaceId }: Props): JSX.Element {
  const { frame } = node

  const body = ((): JSX.Element => {
    switch (node.content.type) {
      case 'terminal':
        return <TerminalNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'stickyNote':
        return <NoteNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'text':
        return <TextNode node={node} content={node.content.value} />
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
          <span className="node-title">{title(node)}</span>
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
