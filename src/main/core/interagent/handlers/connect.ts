/**
 * `atelier connect "A" "B"` — cabeia dois nós que JÁ estão cabeados a quem chama.
 *
 * O verbo existe por causa de um buraco descoberto montando a eval suite de
 * aderência: todo verbo que cria nó (`note create`, `portal open`,
 * `editor open`, `todo create`, `recruit`) conecta o novo nó ao CHAMADOR, e não
 * havia nenhuma forma de cabear dois nós que já existem — só o renderer fazia
 * isso, ou seja, só o usuário arrastando cabo. Um agente recém-recrutado nascia
 * vendo apenas quem o recrutou, e preparar um canvas para ele era gesto humano,
 * um por nó.
 *
 * FORA DE `COMMANDS`, e essa é a decisão que importa. Quem cabeia o canvas é o
 * usuário: os cabos são a estrutura que ele desenhou, e um agente que pudesse
 * religá-los mudaria o que os outros agentes enxergam sem ninguém ver. Este
 * verbo existe para o harness do eval montar a bancada de cada sujeito, e para
 * um coordenador que sabe o que está fazendo — não para o repertório que a skill
 * oferece.
 *
 * A regra de permissão é a mesma de todo handler daqui, e resolve sozinha o
 * risco: **os dois lados têm de estar conectados a quem chama**. Ninguém religa
 * o que não alcança; o que se pode fazer é encurtar caminho entre dois vizinhos
 * seus. Um Artesão com um portal e um recruta pode dar o portal ao recruta, e é
 * exatamente isso que o cenário do eval pede.
 */
import type { UUID } from '@shared/types'
import { log } from '../../logger'
import { nodeDisplayName } from '../../models/node-content'
import { notifyRenderer } from '../../../ipc/notify'
import { connectedNodes, findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier connect "NodeA" "NodeB"'

export async function handleConnect(args: string[], terminalId: UUID | null): Promise<string> {
  if (args.length < 3) return USAGE

  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no workspace'

  const [, nameA, nameB] = args
  const a = findConnectedNode(tid, nameA)
  const b = findConnectedNode(tid, nameB)

  // A mensagem diz o que ESTÁ ao alcance, porque o erro quase sempre é esse: o
  // nó existe no canvas e não está cabeado a quem chama.
  const reachable = (): string => {
    const names = connectedNodes(tid).map((n) => nodeDisplayName(n.content))
    return names.length ? `Connected to you: ${names.join(', ')}.` : 'Nothing is connected to you.'
  }

  if (!a) return `error: '${nameA}' is not connected to you. ${reachable()}`
  if (!b) return `error: '${nameB}' is not connected to you. ${reachable()}`
  if (a.id === b.id) return `error: '${nameA}' and '${nameB}' are the same node.`

  const labelA = nodeDisplayName(a.content)
  const labelB = nodeDisplayName(b.content)

  // `addConnection` devolve null por dois motivos diferentes, e o chamador
  // precisa saber qual: já existe o cabo, ou o par não é conectável (dois
  // portais, por exemplo). Confundir os dois manda um harness tentar de novo o
  // que nunca vai dar certo.
  const already = ws
    .connectionsFor(a.id)
    .some((c) => c.nodeIdA === b.id || c.nodeIdB === b.id)
  if (already) return `'${labelA}' and '${labelB}' are already connected.`

  const connection = ws.addConnection(a.id, b.id)
  if (!connection) {
    return `error: '${labelA}' (${a.content.type}) and '${labelB}' (${b.content.type}) cannot be cabled together.`
  }

  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  log.debug('connect', `${a.id.slice(0, 8)} ↔ ${b.id.slice(0, 8)} (${connection.kind})`)
  return `Connected '${labelA}' and '${labelB}'.`
}
