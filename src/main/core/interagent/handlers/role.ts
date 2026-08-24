/**
 * `atelier role` — a responsabilidade atribuída ao terminal chamador.
 *
 * É por aqui que o agente descobre o próprio foco: o diálogo de novo terminal
 * grava `assignedRoleId` no nó, e este handler devolve o texto inteiro.
 *
 *   atelier role          instruções da minha responsabilidade
 *   atelier role list     as responsabilidades disponíveis neste workspace
 */
import type { UUID } from '@shared/types'
import { roleBriefing } from '../../models/role'
import { roles } from '../../state/role-store'
import { workspaceForTerminal, requireTerminalId } from './context'

export async function handleRole(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const ws = workspaceForTerminal(tid)

  if (args[1] === 'list') {
    const available = roles.visibleIn(ws?.id ?? null)
    if (available.length === 0) return 'No roles defined yet.'
    return [
      'Available roles:',
      ...available.map((r) => `  ${r.name}${r.workspaceId === null ? '  [global]' : ''}`)
    ].join('\n')
  }

  if (args.length > 1) {
    return `error: unknown subcommand '${args[1]}'. Try 'atelier role' or 'atelier role list'.`
  }

  const node = ws?.node(tid)
  const assignedId = node?.content.type === 'terminal' ? node.content.value.assignedRoleId : null
  const role = roles.get(assignedId)

  if (!role) {
    return 'No role assigned to this terminal.\nAssign one in the terminal dialog, or run `atelier role list` to see what exists.'
  }
  return roleBriefing(role)
}
