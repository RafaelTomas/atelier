/** `atelier check "Agent" [lines]` — últimas linhas da saída do agente. */
import type { UUID } from '@shared/types'
import { nodeDisplayName } from '../../models/node-content'
import { terminals } from '../../terminal/terminal-manager'
import { findConnectedNode, requireTerminalId } from './context'

export async function handleCheck(args: string[], terminalId: UUID | null): Promise<string> {
  if (args.length < 2) return 'error: usage: atelier check "Agent" [lines]'

  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const targetName = args[1]
  const lines = Math.min(Math.max(Number(args[2]) || 30, 1), 500)

  const target = findConnectedNode(tid, targetName, 'terminal')
  if (!target) {
    return `error: agent '${targetName}' not found. Use 'atelier list' to see connected agents.`
  }

  const session = terminals.get(target.id)
  if (!session) return `error: agent '${nodeDisplayName(target.content)}' has no running terminal.`

  const status = session.exited ? 'exited' : terminals.isIdle(target.id) ? 'idle' : 'working'
  const tail = terminals.tail(target.id, lines)

  return [`--- ${nodeDisplayName(target.content)} [${status}] last ${lines} lines ---`, tail].join('\n')
}
