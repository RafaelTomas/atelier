/**
 * `atelier button <propose|list|remove>` — o agente PROPÕE um botão no canvas.
 *
 * Espelha handlers/table.ts: terminal chamador, workspace dele, nó posicionado
 * à direita de quem chamou, `workspace:changed` no fim. Duas diferenças, e as
 * duas são decisões, não detalhes:
 *
 *   1. Sem `addConnection` — widget não é conectável. Um cabo botão↔terminal
 *      pediria um array novo no payload do workspace (as conexões são guardadas
 *      por par de tipos), ou seja, a subida de schemaVersion que o formato do
 *      botão evitou. O alvo vai como UUID em `view.target`, escolhido no
 *      diálogo.
 *   2. Tudo nasce PENDENTE. Um botão guarda uma linha de comando e a dispara
 *      com um clique; se o agente pudesse criar um já armado, ele teria
 *      execução arbitrária no shell do usuário disfarçada de UI, e o usuário
 *      clicaria num `play` sem ter lido o que está embaixo. O aceite acontece
 *      no canvas, que é onde o comando fica visível.
 */
import type { CanvasNode, UUID } from '@shared/types'
import { readButtonConfig, writeButtonConfig, type ButtonConfig } from '@shared/types'
import { Constants } from '../../constants'
import { makeWidgetContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { notifyRenderer } from '../../../ipc/notify'
import { requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier button <propose|list|remove> …'

const PROPOSE_USAGE =
  'error: usage: atelier button propose "Label" (--command "npm run dev" | --prompt "text" --target "Agent" | --url http://…) [--icon play] [--color "#34C759"] [--cwd <path>] [--target "Terminal"] [--confirm]'

export async function handleButton(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'propose':
      return proposeButton(args, tid)
    case 'list':
      return listButtons(tid)
    case 'remove':
      return removeButton(args, tid)
    default:
      return USAGE
  }
}

const FLAGS = ['command', 'prompt', 'url', 'icon', 'color', 'cwd', 'target']

function takeFlags(args: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : null
    if (name === 'confirm') flags.set('confirm', '1')
    else if (name && FLAGS.includes(name)) flags.set(name, args[++i] ?? '')
    else rest.push(args[i])
  }
  return { rest, flags }
}

/** Botões deste workspace, na ordem em que estão no canvas. */
function buttonsOf(tid: UUID): CanvasNode[] {
  const ws = workspaceForTerminal(tid)
  if (!ws) return []
  return ws.nodes.filter((n) => n.content.type === 'widget' && n.content.value.kind === 'button')
}

/** Mesma busca fuzzy do findConnectedNode, mas sobre os botões do canvas —
 *  eles não são conectáveis, então não aparecem no escopo de conexão. */
function findButton(tid: UUID, name: string): CanvasNode | null {
  const needle = name.toLowerCase().trim()
  const candidates = buttonsOf(tid)
  return (
    candidates.find((n) => nodeDisplayName(n.content).toLowerCase() === needle) ??
    candidates.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle)) ??
    candidates.find((n) => n.id.toLowerCase().startsWith(needle.slice(0, 8))) ??
    null
  )
}

function findTerminal(tid: UUID, name: string): CanvasNode | null {
  const ws = workspaceForTerminal(tid)
  if (!ws) return null
  const needle = name.toLowerCase().trim()
  const terminals = ws.nodes.filter((n) => n.content.type === 'terminal')
  return (
    terminals.find((n) => nodeDisplayName(n.content).toLowerCase() === needle) ??
    terminals.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle)) ??
    null
  )
}

function proposeButton(argv: string[], tid: UUID): string {
  const { rest, flags } = takeFlags(argv)
  const label = rest[2]
  if (!label) return PROPOSE_USAGE

  const command = flags.get('command') ?? ''
  const prompt = flags.get('prompt') ?? ''
  const url = flags.get('url') ?? ''
  // Um botão sem ação é um nó inerte que ninguém sabe consertar a não ser
  // apagando — recusar aqui é mais barato do que criá-lo.
  if (!command && !prompt && !url) return PROPOSE_USAGE

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  let target: UUID | null = null
  const targetName = flags.get('target')
  if (targetName) {
    const node = findTerminal(tid, targetName)
    if (!node) return `error: terminal '${targetName}' not found on this canvas.`
    target = node.id
  }
  if (prompt && !target) {
    return 'error: --prompt needs --target "Agent" — a prompt has to reach an agent that is already running.'
  }

  const config: ButtonConfig = {
    label,
    icon: flags.get('icon') || (prompt ? 'burst' : url ? 'link' : 'play'),
    color: flags.get('color') || '#34C759',
    action: prompt ? 'prompt' : url ? 'url' : 'command',
    command,
    prompt,
    url,
    cwd: flags.get('cwd') ?? '',
    target,
    confirm: flags.get('confirm') === '1',
    pending: true,
    proposedBy: nodeDisplayName(caller.content)
  }

  const node = makeCanvasNode(
    {
      x: caller.frame.x + caller.frame.width + 60,
      y: caller.frame.y,
      width: Constants.buttonDefaultWidth,
      height: Constants.buttonDefaultHeight
    },
    { type: 'widget', value: makeWidgetContent('button', null, writeButtonConfig(config)) }
  )

  ws.addNode(node)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  // A resposta diz que o botão está PENDENTE, e em letras: sem isso o agente
  // reporta "criei o botão", o usuário não vê nada acontecer ao clicar, e a
  // culpa cai no lugar errado.
  return [
    `Proposed button '${label}' on the canvas — it is PENDING and does nothing yet.`,
    `The user has to press Accept on the node to arm it; the command is shown there for them to read first.`,
    `Tell them the button is waiting for approval.`
  ].join('\n')
}

function listButtons(tid: UUID): string {
  const buttons = buttonsOf(tid)
  if (buttons.length === 0) {
    return 'No buttons on this canvas.\nUse `atelier button propose "Label" --command "…"` to propose one.'
  }
  const lines = ['Buttons on this canvas:']
  for (const node of buttons) {
    if (node.content.type !== 'widget') continue
    const config = readButtonConfig(node.content.value.view)
    const what = config.action === 'prompt' ? config.prompt : config.action === 'url' ? config.url : config.command
    const state = config.pending ? 'pending' : 'armed'
    lines.push(`  ${config.label}  [${config.action}] ${what}  (${state}, ${node.id.slice(0, 8)})`)
  }
  return lines.join('\n')
}

function removeButton(argv: string[], tid: UUID): string {
  const name = argv[2]
  if (!name) return 'error: usage: atelier button remove "Label"'

  const ws = workspaceForTerminal(tid)
  const node = findButton(tid, name)
  if (!ws || !node || node.content.type !== 'widget') {
    return `error: button '${name}' not found. Use 'atelier button list'.`
  }

  const config = readButtonConfig(node.content.value.view)
  const caller = ws.node(tid)
  const me = caller ? nodeDisplayName(caller.content) : ''
  // Um agente desfaz a própria proposta, e só ela: um botão já aceito é do
  // USUÁRIO — ele leu o comando e o quis ali.
  if (!config.pending) {
    return `error: button '${config.label}' was accepted by the user — only they can remove it.`
  }
  if (config.proposedBy !== me) {
    return `error: button '${config.label}' was proposed by ${config.proposedBy ?? 'someone else'}, not by you.`
  }

  ws.removeNode(node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Removed pending button '${config.label}'.`
}
