/** `atelier list` — agentes, notas e portais conectados ao chamador. */
import type { UUID } from '@shared/types'
import { nodeDisplayName } from '../../models/node-content'
import { terminals } from '../../terminal/terminal-manager'
import { connectedNodes, requireTerminalId } from './context'

export async function handleList(_args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const nodes = connectedNodes(tid)
  if (nodes.length === 0) {
    return 'No connected agents, notes or portals.\nConnect this terminal to another node on the canvas first.'
  }

  const lines: string[] = []

  const agents = nodes.filter((n) => n.content.type === 'terminal')
  if (agents.length > 0) {
    lines.push('Connected agents:')
    for (const node of agents) {
      const session = terminals.get(node.id)
      const status = session ? (session.exited ? 'exited' : terminals.isIdle(node.id) ? 'idle' : 'working') : 'not started'
      lines.push(`  ${nodeDisplayName(node.content)}  [${status}]  (${node.id.slice(0, 8)})`)
    }
  }

  const notes = nodes.filter((n) => n.content.type === 'stickyNote')
  if (notes.length > 0) {
    lines.push('', 'Connected notes:')
    for (const node of notes) lines.push(`  ${nodeDisplayName(node.content)}`)
  }

  const portals = nodes.filter((n) => n.content.type === 'portal')
  if (portals.length > 0) {
    lines.push('', 'Connected portals:')
    for (const node of portals) {
      const portal = node.content.type === 'portal' ? node.content.value : null
      lines.push(`  ${nodeDisplayName(node.content)}  ${portal?.currentURL ?? ''}`)
    }
  }

  return lines.join('\n')
}
