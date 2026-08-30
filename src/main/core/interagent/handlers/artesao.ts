/**
 * `atelier artesao` — o verbo dos hooks do Artesão.
 *
 * NÃO é um verbo que um agente digita, e por isso está fora de `COMMANDS` no
 * roteador, como o `statusline`. Quem chama é o Claude Code, pelos hooks que o
 * Atelier instalou no `--settings` daquele terminal (ver
 * terminal/agent-settings.ts).
 *
 * Só `brief` chega até aqui. O `guard` — a recusa do `Task` — é respondido
 * LOCALMENTE pelo CLI, sem tocar no socket: um bloqueio não pode depender de o
 * app responder, senão bastaria o Atelier engasgar para o Artesão deixar de ser
 * Artesão. Ver o cabeçalho de resources/atelier.cjs.
 */
import type { UUID } from '@shared/types'
import { Constants } from '../../constants'
import { nodeDisplayName } from '../../models/node-content'
import { artisanDoctrine } from '../artisan-doctrine'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

export function handleArtesao(argv: string[], terminalId: UUID | null): string {
  const sub = argv[1]
  if (sub !== 'brief') {
    return `error: usage: atelier artesao brief (called by the Artisan hooks, not by hand)`
  }

  const tid = requireTerminalId(terminalId)
  // Sem id de terminal a doutrina ainda vale — ela só perde o bloco do canvas.
  // Devolver erro aqui deixaria o Artesão começar a sessão sem doutrina nenhuma,
  // que é o pior desfecho possível para um hook de `SessionStart`.
  if (!tid) return artisanDoctrine({ peers: [], slotsLeft: 0, boards: [] })

  const nodes = connectedNodes(tid)
  const peers = nodes
    .filter((n) => n.content.type === 'terminal')
    .map((n) => nodeDisplayName(n.content))
  const boards = nodes
    .filter((n) => n.content.type === 'widget' && n.content.value.kind === 'todo')
    .map((n) => nodeDisplayName(n.content))

  // O mesmo teto que o `recruit` aplica, contado do mesmo jeito: terminais no
  // workspace inteiro, não só os cabeados — ver handlers/recruit.ts.
  const ws = workspaceForTerminal(tid)
  const used = ws ? ws.nodes.filter((n) => n.content.type === 'terminal').length : 0
  const slotsLeft = Math.max(0, Constants.recruitMaxTerminals - used)

  return artisanDoctrine({ peers, slotsLeft, boards })
}
