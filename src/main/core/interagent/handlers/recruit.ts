/**
 * `atelier recruit` — o agente abre OUTRO agente, já cabeado a ele.
 *
 * Era o buraco da família: `portal open`, `note create`, `table create` e
 * `image create` já criavam nó conectado ao chamador; terminal, não. Sem isto
 * um agente que precisa de ajuda depende de um gesto manual do usuário no
 * canvas, o que é o oposto do que o canvas existe para fazer.
 *
 * O PTY NÃO é aberto aqui. Quem o abre é o renderer quando monta o nó
 * (`terminal:spawn`, bridge.ts) — é o mesmo caminho do terminal criado pelo
 * diálogo, e mantê-lo é o que garante que um agente recrutado receba o mesmo
 * ambiente, os mesmos cofres e a mesma expansão de `${vault:…}` que qualquer
 * outro. A consequência está na resposta ao chamador: o agente novo só começa a
 * existir quando o nó dele estiver na tela.
 */
import type { UUID } from '@shared/types'
import { QUICK_STARTS, presetById } from '@shared/terminal-presets'
import { claudeAccounts } from '../../claude/accounts'
import { Constants } from '../../constants'
import { makeTerminalContent } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { freeSpotRightOf } from '../../spawn-spot'
import { roles } from '../../state/role-store'
import { notifyRenderer } from '../../../ipc/notify'
import { requireTerminalId, workspaceForTerminal } from './context'

/** Mesmo tamanho do terminal criado pelo diálogo (defaultSize em bridge.ts). */
const TERMINAL_SIZE = { width: 560, height: 360 }

const USAGE =
  'error: usage: atelier recruit "Name" [--preset claude|codex|antigravity|opencode|shell] [--cwd /path] [--role "Role"] [--account "Account"]'

function takeFlags(argv: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--preset' || arg === '--cwd' || arg === '--role' || arg === '--account') {
      flags.set(arg.slice(2), argv[++i] ?? '')
    } else {
      rest.push(arg)
    }
  }
  return { rest, flags }
}

export async function handleRecruit(argv: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const { rest: args, flags } = takeFlags(argv)
  if (args.length < 2) return USAGE

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  const caller = ws.node(tid)
  if (!caller || caller.content.type !== 'terminal') {
    return 'error: calling terminal is not on this canvas'
  }

  // Teto de terminais por canvas. Um agente que recruta em laço encheria o
  // workspace de PTYs, e `dismiss` só desfaz o que o PRÓPRIO chamador criou —
  // o resto sobra como trabalho manual do usuário. Criar na mão continua livre:
  // o teto é do CLI, não do canvas.
  const existing = ws.nodes.filter((n) => n.content.type === 'terminal').length
  if (existing >= Constants.recruitMaxTerminals) {
    return `error: this canvas already has ${existing} terminals (limit for 'recruit' is ${Constants.recruitMaxTerminals}). Ask the user to remove one, or to create the terminal by hand.`
  }

  const presetId = flags.get('preset') ?? 'claude'
  const preset = presetById(presetId)
  if (!preset) {
    return `error: unknown preset '${presetId}'. Available: ${QUICK_STARTS.map((p) => p.id).join(', ')}.`
  }

  // Papel é opcional, mas um papel ERRADO é recusa: o nome que o agente digitou
  // provavelmente é o que ele queria, e atribuir outro (ou nenhum) em silêncio
  // faria o recrutado trabalhar fora do escopo que o chamador pretendia.
  const roleName = flags.get('role')
  let assignedRoleId: UUID | null = null
  if (roleName) {
    const visible = roles.visibleIn(ws.id)
    const match =
      visible.find((r) => r.name.toLowerCase() === roleName.toLowerCase()) ??
      visible.find((r) => r.name.toLowerCase().includes(roleName.toLowerCase()))
    if (!match) {
      const names = visible.map((r) => `'${r.name}'`).join(', ') || '(none defined)'
      return `error: role '${roleName}' not found. Available: ${names}.`
    }
    assignedRoleId = match.id
  }

  // Conta do Claude: mesma regra do papel — um nome que não existe é recusa, e
  // não a conta padrão em silêncio. Cair na padrão levaria o recrutado a rodar
  // logado como outra pessoa, que é o oposto do que quem passou a flag pediu.
  const accountName = flags.get('account')
  let claudeAccountId: string | null = null
  if (accountName) {
    const match = claudeAccounts.resolve(accountName)
    if (!match) {
      const names = claudeAccounts.all.map((a) => `'${a.label}'`).join(', ') || '(none created)'
      return `error: Claude account '${accountName}' not found. Available: ${names}.`
    }
    claudeAccountId = match === 'default' ? null : match.id
  }

  const name = args[1]
  // Sem `--cwd`, o recrutado nasce onde o chamador está: é quase sempre o que se
  // quer (ajuda no MESMO projeto), e herdar o diretório do workspace levaria o
  // agente novo para outro lugar sem ninguém pedir.
  const workingDirectory =
    flags.get('cwd') || caller.content.value.workingDirectory || ws.payload.workingDirectory || ''

  const content = makeTerminalContent(name, {
    agentType: preset.agentType,
    command: preset.command,
    icon: preset.icon,
    color: preset.color,
    workingDirectory,
    assignedRoleId,
    claudeAccountId,
    // Quem recrutou é quem pode dispensar — ver handlers/dismiss.ts.
    recruitedBy: tid
  })

  const spot = freeSpotRightOf(ws, caller, TERMINAL_SIZE)
  const node = makeCanvasNode({ ...spot, ...TERMINAL_SIZE }, { type: 'terminal', value: content })

  ws.addNode(node)
  ws.addConnection(tid, node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const where = workingDirectory || '(workspace default)'
  const role = assignedRoleId ? `, role '${roles.get(assignedRoleId)?.name}'` : ''
  const account = claudeAccountId ? `, Claude account '${claudeAccounts.labelFor(claudeAccountId)}'` : ''
  return [
    `Recruited '${name}' (${preset.label}) in ${where}${role}${account}, connected to this terminal.`,
    "It boots when its node is on screen — run 'atelier list' and wait for it to leave [not started]",
    "before asking it anything. When it is done, 'atelier dismiss' removes it."
  ].join('\n')
}
