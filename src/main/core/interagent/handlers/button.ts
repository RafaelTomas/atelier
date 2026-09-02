/**
 * `atelier button <propose|list|remove>` — o agente PROPÕE um botão no canvas.
 *
 * Espelha handlers/table.ts: terminal chamador, workspace dele, nó posicionado
 * à direita de quem chamou, `workspace:changed` no fim. Duas diferenças, e as
 * duas são decisões, não detalhes:
 *
 *   1. Sem `addConnection` — mas não porque o par seja proibido: botão↔terminal
 *      é `terminal + widget`, que já cai em `data` (ver connectionKindForTypes).
 *      É que no `propose` não há terminal para cabear ainda. O alvo de um botão
 *      de comando ou prompt vai como UUID em `view.target`; o de um botão de
 *      AGENTE não vai a lugar nenhum, porque o terminal só existe depois do
 *      clique — e é o renderer que cabeia os dois no spawn (store.runAgentButton).
 *      Esse cabo não é decoração: é onde o botão guarda qual agente reusar.
 *   2. Tudo nasce PENDENTE. Um botão guarda uma linha de comando e a dispara
 *      com um clique; se o agente pudesse criar um já armado, ele teria
 *      execução arbitrária no shell do usuário disfarçada de UI, e o usuário
 *      clicaria num `play` sem ter lido o que está embaixo. O aceite acontece
 *      no canvas, que é onde o comando fica visível.
 */
import type { CanvasNode, UUID } from '@shared/types'
import {
  buttonActionSummary,
  readButtonConfig,
  writeButtonConfig,
  type ButtonConfig
} from '@shared/types'
import { QUICK_STARTS, isArtisanCapable, presetById } from '@shared/terminal-presets'
import { claudeAccounts } from '../../claude/accounts'
import { roles } from '../../state/role-store'
import { resolvePresetModel } from './recruit'
import { Constants } from '../../constants'
import { makeWidgetContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { notifyRenderer } from '../../../ipc/notify'
import { requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier button <propose|edit|list|remove> …'

const PROPOSE_USAGE =
  'error: usage: atelier button propose "Label" (--command "npm run dev" | --prompt "text" --target "Agent" | --url http://… | --agent "Name" [--preset claude] [--model sonnet] [--role "Role"] [--account "Account"] [--prompt "text"] [--artisan] [--no-reuse]) [--icon play] [--color "#34C759"] [--cwd <path>] [--confirm]'

export async function handleButton(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'propose':
      return proposeButton(args, tid)
    case 'edit':
      return editButton(args, tid)
    case 'list':
      return listButtons(tid)
    case 'remove':
      return removeButton(args, tid)
    default:
      return USAGE
  }
}

const FLAGS = ['command', 'prompt', 'url', 'icon', 'color', 'cwd', 'target', 'agent', 'preset', 'model', 'role', 'account', 'label']

const EDIT_USAGE =
  'error: usage: atelier button edit "Label" [--prompt "…"] [--command "…"] [--url …] [--agent "Name"] [--preset claude] [--model sonnet] [--cwd <path>] [--role "Role"] [--account "Account"] [--artisan|--no-artisan] [--no-reuse] [--confirm|--no-confirm] [--label "New label"] [--icon play] [--color "#34C759"]'

function takeFlags(args: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : null
    if (name === 'confirm') flags.set('confirm', '1')
    else if (name === 'no-reuse') flags.set('no-reuse', '1')
    else if (name === 'artisan') flags.set('artisan', '1')
    else if (name === 'no-artisan') flags.set('no-artisan', '1')
    else if (name === 'no-confirm') flags.set('no-confirm', '1')
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
  const agentName = flags.get('agent')
  // Um botão sem ação é um nó inerte que ninguém sabe consertar a não ser
  // apagando — recusar aqui é mais barato do que criá-lo.
  if (!command && !prompt && !url && agentName === undefined) return PROPOSE_USAGE

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const workspaceId = ws.id
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  let target: UUID | null = null
  const targetName = flags.get('target')
  if (targetName) {
    const node = findTerminal(tid, targetName)
    if (!node) return `error: terminal '${targetName}' not found on this canvas.`
    target = node.id
  }

  // O botão de AGENTE abre o próprio alvo, então `--target` ali é contradição,
  // não redundância: uma das duas intenções seria ignorada em silêncio.
  if (agentName !== undefined && targetName) {
    return 'error: --agent opens its own terminal — drop --target.'
  }
  if (agentName !== undefined && (command || url)) {
    return 'error: --agent is exclusive with --command and --url. Use --prompt for what to say to the agent.'
  }
  if (prompt && agentName === undefined && !target) {
    return 'error: --prompt needs --target "Agent" — a prompt has to reach an agent that is already running. To open a new one, use --agent "Name".'
  }

  // Preset, modelo, papel e conta: MESMAS regras do recruit, e de propósito —
  // um botão de agente é um recruit gravado no canvas. Cada nome que não existe
  // é recusa aqui, e não no clique: o erro tem de sair enquanto alguém está
  // lendo o terminal, não quando o botão for apertado.
  const agent = resolveAgentFlags(flags, workspaceId, agentName === undefined ? null : agentName)
  if (typeof agent === 'string') return agent
  const { preset, model, roleId, accountId, artisan } = agent

  const action: ButtonConfig['action'] =
    agentName !== undefined ? 'agent' : prompt ? 'prompt' : url ? 'url' : 'command'

  const config: ButtonConfig = {
    label,
    icon:
      flags.get('icon') ||
      (action === 'agent' ? 'sparkle' : prompt ? 'burst' : url ? 'link' : 'play'),
    color: flags.get('color') || '#34C759',
    action,
    command,
    prompt,
    url,
    agentName: agentName ?? '',
    preset,
    model,
    roleId,
    accountId,
    artisan,
    reuseAgent: flags.get('no-reuse') !== '1',
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


/**
 * Preset, modelo, papel, conta e Artesão de um botão de agente — MESMAS regras
 * do `recruit`, e de propósito: um botão de agente é um recruit gravado no
 * canvas, e duas gramáticas para a mesma coisa envelheceriam separadas.
 *
 * Cada nome que não existe é recusa AQUI, e não no clique: o erro tem de sair
 * enquanto alguém está lendo o terminal, não quando o botão for apertado no
 * meio de uma apresentação.
 *
 * `base` é a config atual num `edit` (só as flags passadas mudam) ou `null` num
 * `propose`. `name` null = não é botão de agente; devolve tudo vazio.
 */
function resolveAgentFlags(
  flags: Map<string, string>,
  workspaceId: UUID,
  name: string | null,
  base: ButtonConfig | null = null
):
  | string
  | { preset: string; model: string; roleId: string; accountId: string; artisan: boolean } {
  const empty = { preset: '', model: '', roleId: '', accountId: '', artisan: false }
  if (name === null) return base && base.action === 'agent'
    ? {
        preset: base.preset,
        model: base.model,
        roleId: base.roleId,
        accountId: base.accountId,
        artisan: base.artisan
      }
    : empty
  if (!name.trim()) return 'error: --agent needs a name for the terminal it opens.'

  // `||`, não `??`: um botão criado pelo diálogo grava `preset` VAZIO e o
  // runtime resolve como 'claude' na hora do clique (store.runAgentButton). Com
  // `??` o vazio passava direto e o edit recusava com "unknown preset ''" — um
  // botão que funciona perfeitamente, impossível de editar.
  const preset = flags.get('preset') || base?.preset || 'claude'
  if (!presetById(preset)) {
    return `error: unknown preset '${preset}'. Available: ${QUICK_STARTS.map((p) => p.id).join(', ')}.`
  }

  // O modelo só sobrevive se o preset continuar o mesmo: um alias de Claude não
  // significa nada no Codex. `(base?.preset || 'claude')` pela razão acima.
  let model = (base?.preset || 'claude') === preset ? (base?.model ?? '') : ''
  const rawModel = flags.get('model')
  if (rawModel !== undefined) {
    const selected = resolvePresetModel(preset, rawModel)
    if (!selected.ok) return selected.error
    // Guarda o ALIAS quando veio um, e o id quando veio um id: é o que o
    // diálogo mostra selecionado, e o renderer resolve de novo na hora de
    // montar o comando.
    model = selected.alias ?? selected.id
  }

  let roleId = base?.roleId ?? ''
  const roleName = flags.get('role')
  if (roleName !== undefined) {
    const visible = roles.visibleIn(workspaceId)
    const match =
      visible.find((r) => r.name.toLowerCase() === roleName.toLowerCase()) ??
      visible.find((r) => r.name.toLowerCase().includes(roleName.toLowerCase()))
    if (!match) {
      const names = visible.map((r) => `'${r.name}'`).join(', ') || '(none defined)'
      return `error: role '${roleName}' not found. Available: ${names}.`
    }
    roleId = match.id
  }

  let accountId = base?.accountId ?? ''
  const accountName = flags.get('account')
  if (accountName !== undefined) {
    const match = claudeAccounts.resolve(accountName)
    if (!match) {
      const names = claudeAccounts.all.map((a) => `'${a.label}'`).join(', ') || '(none created)'
      return `error: Claude account '${accountName}' not found. Available: ${names}.`
    }
    accountId = match === 'default' ? '' : match.id
  }

  // Artesão num preset sem agente é recusa, não silêncio: quem passou a flag
  // espera um nó que delega, e um shell vestido de Artesão não delega nada.
  let artisan = base?.artisan ?? false
  if (flags.get('artisan') === '1') artisan = true
  if (flags.get('no-artisan') === '1') artisan = false
  if (artisan) {
    const chosen = presetById(preset)!
    if (!isArtisanCapable({ agentType: chosen.agentType, command: chosen.command })) {
      return `error: --artisan does not apply to the '${preset}' preset — a plain shell has nobody to instruct.`
    }
  }

  return { preset, model, roleId, accountId, artisan }
}

/**
 * `atelier button edit "Label"` — muda um botão que já está no canvas.
 *
 * O `remove` recusa botão aceito porque ele é do USUÁRIO: ele leu o comando e o
 * quis ali. Editar tem o mesmo problema, e a resposta NÃO é recusar — é devolver
 * o botão ao estado pendente sempre que o que ele EXECUTA muda. O usuário relê e
 * aceita de novo, que é exatamente a promessa que o aceite faz.
 *
 * Mexer só na aparência (rótulo, ícone, cor) não repende: nada do que o usuário
 * leu quando aceitou mudou, e forçar um segundo aceite para trocar uma cor
 * ensinaria a clicar em Aceitar sem ler — que é o oposto do que o aceite serve.
 */
function editButton(argv: string[], tid: UUID): string {
  const { rest, flags } = takeFlags(argv)
  const name = rest[2]
  if (!name) return EDIT_USAGE

  const ws = workspaceForTerminal(tid)
  const node = findButton(tid, name)
  if (!ws || !node || node.content.type !== 'widget') {
    return `error: button '${name}' not found. Use 'atelier button list'.`
  }
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const before = readButtonConfig(node.content.value.view)

  const agentName = flags.get('agent')
  const agent = resolveAgentFlags(
    flags,
    ws.id,
    agentName ?? (before.action === 'agent' ? before.agentName : null),
    before
  )
  if (typeof agent === 'string') return agent

  let target = before.target
  const targetName = flags.get('target')
  if (targetName !== undefined) {
    const found = findTerminal(tid, targetName)
    if (!found) return `error: terminal '${targetName}' not found on this canvas.`
    target = found.id
  }

  const after: ButtonConfig = {
    ...before,
    label: flags.get('label') ?? before.label,
    icon: flags.get('icon') ?? before.icon,
    color: flags.get('color') ?? before.color,
    command: flags.get('command') ?? before.command,
    prompt: flags.get('prompt') ?? before.prompt,
    url: flags.get('url') ?? before.url,
    cwd: flags.get('cwd') ?? before.cwd,
    agentName: agentName ?? before.agentName,
    ...agent,
    target,
    reuseAgent: flags.get('no-reuse') === '1' ? false : before.reuseAgent,
    confirm: flags.get('confirm') === '1' ? true : flags.get('no-confirm') === '1' ? false : before.confirm
  }

  // O que o usuário leu quando aceitou. Rótulo, ícone e cor ficam de fora: são
  // como o botão APARECE, não o que ele faz.
  const EXECUTABLE = [
    'action',
    'command',
    'prompt',
    'url',
    'cwd',
    'target',
    'agentName',
    'preset',
    'model',
    'roleId',
    'accountId',
    'artisan',
    'reuseAgent',
    'confirm'
  ] as const
  const changed = EXECUTABLE.filter((k) => before[k] !== after[k])
  if (changed.length === 0 && after.label === before.label && after.icon === before.icon && after.color === before.color) {
    return `Nothing to change on '${before.label}'.`
  }

  const rearm = changed.length > 0 && !before.pending
  if (rearm) {
    after.pending = true
    after.proposedBy = nodeDisplayName(caller.content)
  }

  ws.updateContent(node.id, (n) => {
    if (n.content.type === 'widget') n.content.value.view = writeButtonConfig(after)
  })
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  if (rearm) {
    return [
      `Edited '${after.label}' (${changed.join(', ')}) — it is back to PENDING and does nothing until the user accepts it again.`,
      'That is on purpose: the user accepted the old action after reading it, and what this button runs has changed.',
      'Tell them to press Accept on the node to re-arm it.'
    ].join('\n')
  }
  return changed.length > 0
    ? `Edited pending button '${after.label}' (${changed.join(', ')}). Still waiting for the user to accept it.`
    : `Edited the appearance of '${after.label}'. It stays armed — nothing it runs changed.`
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
    const what = buttonActionSummary(config)
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
