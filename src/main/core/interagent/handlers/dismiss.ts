/**
 * `atelier dismiss "Name"` — o agente desfaz o que ele mesmo recrutou.
 *
 * O contrário do `recruit`, e com a mesma assimetria de sempre: criar é barato,
 * remover é definitivo. Por isso a permissão é estreita — só o terminal que
 * recrutou pode dispensar, pelo `recruitedBy` gravado no nó. Um agente não pode
 * dispensar o terminal do usuário nem o de um colega, mesmo estando cabeado a
 * ele: seria apagar trabalho alheio em andamento, e o cabo existe para
 * conversar, não para mandar.
 *
 * Dispensar MATA o processo. Um agente ocupado morre no meio do que estava
 * fazendo — daí a recusa quando ele não está ocioso, com a saída dele à mão
 * (`atelier check`) para o chamador decidir. `--force` é o modo de dizer "eu
 * sei, mate assim mesmo".
 */
import type { UUID } from '@shared/types'
import { nodeDisplayName } from '../../models/node-content'
import { terminals } from '../../terminal/terminal-manager'
import { forgetTerminal } from '../../connection/skill-injector'
import { notifyRenderer } from '../../../ipc/notify'
import { findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier dismiss "Name" [--force]'

/**
 * As três recusas, separadas do resto para poderem ser testadas sem PTY: o
 * estado "ocupado" só existe com um processo vivo, e é justamente a regra que
 * ninguém quer descobrir quebrada em produção.
 *
 * Devolve a mensagem de recusa, ou null quando pode dispensar.
 */
export function dismissRefusal(p: {
  name: string
  callerId: UUID
  targetId: UUID
  recruitedBy: UUID | null
  busy: boolean
  force: boolean
}): string | null {
  if (p.targetId === p.callerId) {
    return 'error: an agent cannot dismiss itself — ask the user to close this terminal.'
  }
  if (p.recruitedBy !== p.callerId) {
    return [
      `error: '${p.name}' was not recruited by you, so you cannot dismiss it.`,
      'Only the terminal that ran `atelier recruit` can undo it; ask the user to remove the node.'
    ].join(' ')
  }
  if (p.busy && !p.force) {
    return [
      `error: '${p.name}' is still working.`,
      `Run 'atelier check "${p.name}"' to see what it is doing,`,
      'then dismiss it with --force if you really want to kill it.'
    ].join(' ')
  }
  return null
}

export async function handleDismiss(argv: string[], terminalId: UUID | null): Promise<string> {
  const force = argv.includes('--force')
  const args = argv.filter((a) => a !== '--force')
  if (args.length < 2) return USAGE

  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  const targetName = args[1]

  // O chamador não está entre os próprios nós conectados, então pedir para se
  // dispensar cairia num "not found" que não explica nada. A pergunta é
  // legítima e merece a resposta certa.
  const caller = ws.node(tid)
  if (caller && nodeDisplayName(caller.content).toLowerCase().includes(targetName.toLowerCase())) {
    return 'error: an agent cannot dismiss itself — ask the user to close this terminal.'
  }

  const target = findConnectedNode(tid, targetName, 'terminal')
  if (!target || target.content.type !== 'terminal') {
    return `error: agent '${targetName}' not found. Use 'atelier list' to see connected agents.`
  }
  const name = nodeDisplayName(target.content)

  // Ocupado é o agente com processo vivo que ainda não voltou a ficar ocioso;
  // matá-lo no meio de uma edição de arquivo é o dano que não tem desfazer.
  const session = terminals.get(target.id)
  const busy = session !== undefined && !session.exited && !terminals.isIdle(target.id)

  const refusal = dismissRefusal({
    name,
    callerId: tid,
    targetId: target.id,
    recruitedBy: target.content.value.recruitedBy,
    busy,
    force
  })
  if (refusal) return refusal

  terminals.kill(target.id)
  forgetTerminal(target.id)
  // O scrollback em disco fica, como no botão de excluir da UI: é o registro do
  // que aquele agente fez, e o nó já não existe para reabri-lo.
  ws.removeNode(target.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  return `Dismissed '${name}': process killed and node removed from the canvas.`
}
