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

  const { state, waiting } = terminals.agentState(target.id)
  const tail = terminals.tail(target.id, lines)
  const head = `--- ${nodeDisplayName(target.content)} [${state}] last ${lines} lines ---`

  // Quando o agente está parado pedindo, a instrução vem ANTES da tela. Ler o
  // scrollback de um diálogo aberto é justamente o que não resolve, e o que o
  // coordenador tenta fazer por reflexo — a resposta tem de ser dada no nó.
  if (state !== 'waiting') return [head, tail].join('\n')
  const asked = waiting?.detail ? `: ${waiting.detail}` : ''
  return [
    head,
    `[waiting] ${nodeDisplayName(target.content)} stopped and is asking the USER${asked}`,
    'It will not move until someone answers IN THE NODE. Re-reading this screen,',
    "or sending another 'ask', will not unblock it — the second one interrupts it.",
    '',
    tail
  ].join('\n')
}
