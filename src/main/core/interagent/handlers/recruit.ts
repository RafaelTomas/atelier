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
  'error: usage: atelier recruit "Name" [--preset claude|codex|antigravity|opencode|shell | --command "cmd"] [--cwd /path] [--role "Role"] [--account "Account"] [--model opus|sonnet|haiku|luna|terra|sol|model-id]'

/**
 * O modelo vai CONCATENADO num comando que é escrito no PTY do recrutado, então
 * ele passa por aqui antes: um nome com `;`, `$(` ou aspas deixaria de ser um
 * argumento e viraria comando no shell do outro agente. Aliases conhecidos são
 * atalhos, não a lista toda — um id completo (`claude-haiku-4-5-20251001`)
 * também passa, porque fechar a lista a envelheceria a cada modelo novo.
 */
const MODEL_TOKEN = /^[a-z0-9][a-z0-9.-]*$/
const MODEL_FLAG_RE = /(^|\s)(--model|-m)(\s|=)|(^|\s)-c\s+model=/

const FLAGS = ['--preset', '--cwd', '--role', '--account', '--model', '--command']

function takeFlags(argv: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (FLAGS.includes(arg)) {
      flags.set(arg.slice(2), argv[++i] ?? '')
    } else {
      rest.push(arg)
    }
  }
  return { rest, flags }
}

export function resolvePresetModel(
  presetId: string,
  raw: string
): { ok: true; id: string; alias: string | null } | { ok: false; error: string } {
  const preset = presetById(presetId)
  if (!preset?.model) {
    return { ok: false, error: `error: --model does not apply to the '${presetId}' preset.` }
  }

  const model = raw.trim().toLowerCase()
  if (!MODEL_TOKEN.test(model)) {
    const aliases = Object.keys(preset.model.aliases).join(', ')
    return {
      ok: false,
      error: `error: invalid model '${raw}'. Use an alias (${aliases}) or a model id.`
    }
  }

  const resolved = preset.model.aliases[model]
  return { ok: true, id: resolved ?? model, alias: resolved ? model : null }
}

export function commandWithPresetModel(
  presetId: string,
  raw: string
): { ok: true; command: string; id: string; alias: string | null } | { ok: false; error: string } {
  const preset = presetById(presetId)
  if (!preset) return { ok: false, error: `error: unknown preset '${presetId}'.` }
  if (MODEL_FLAG_RE.test(preset.command)) {
    return {
      ok: false,
      error: `error: preset '${presetId}' already chooses a model in its command. Remove that model from the preset command or omit --model.`
    }
  }
  const selected = resolvePresetModel(presetId, raw)
  if (!selected.ok) return selected
  return {
    ok: true,
    command: `${preset.command} ${preset.model?.flag ?? '--model'} ${selected.id}`,
    id: selected.id,
    alias: selected.alias
  }
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

  /**
   * `--command` sobe um comando livre em vez de um dos cinco presets.
   *
   * NÃO é privilégio novo: quem chama já tem um shell no próprio PTY e pode
   * rodar o que quiser nele. O que sai é um guarda-corpo — a lista fixa de
   * presets — e o que fica no lugar é a VISIBILIDADE: o nó aparece no canvas
   * com o comando à vista no editor, o que é mais do que se pode dizer de
   * qualquer coisa que o agente rodasse escondido no próprio terminal. O teto
   * de `recruitMaxTerminals` continua valendo.
   *
   * O caso que motivou a flag é recriar um agente RETOMANDO a sessão dele
   * (`claude --resume <id>`), que nenhum preset expressa.
   */
  const freeCommand = flags.get('command')
  if (freeCommand !== undefined && flags.get('preset') !== undefined) {
    return "error: --command and --preset are mutually exclusive. Use one or the other."
  }
  if (freeCommand !== undefined && !freeCommand.trim()) {
    return 'error: --command needs a command to run.'
  }

  // Com `--command` o nó nasce com a aparência do preset `shell`: ele não é um
  // dos cinco agentes conhecidos, e vesti-lo de Claude seria mentir sobre o que
  // está rodando ali.
  const presetId = freeCommand !== undefined ? 'shell' : (flags.get('preset') ?? 'claude')
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

  // Modelo: quem declara a capacidade é o PRESET (`model` em terminal-presets),
  // e não um `if` por agente aqui. Claude e Codex têm seletor; Antigravity,
  // OpenCode e shell não, e neles a flag é recusada em vez de ignorada — aceitar
  // em silêncio faria quem pediu o modelo barato achar que economizou.
  const model = flags.get('model')
  let resolvedModel: { id: string; alias: string | null } | null = null
  let presetCommand = preset.command
  if (model !== undefined) {
    if (freeCommand !== undefined) {
      return 'error: --model does not apply to --command. Put the flag in the command itself.'
    }
    const selected = commandWithPresetModel(presetId, model)
    if (!selected.ok) {
      return selected.error
    }
    resolvedModel = { id: selected.id, alias: selected.alias }
    presetCommand = selected.command
  }

  const name = args[1]
  // Sem `--cwd`, o recrutado nasce onde o chamador está: é quase sempre o que se
  // quer (ajuda no MESMO projeto), e herdar o diretório do workspace levaria o
  // agente novo para outro lugar sem ninguém pedir.
  const workingDirectory =
    flags.get('cwd') || caller.content.value.workingDirectory || ws.payload.workingDirectory || ''

  const content = makeTerminalContent(name, {
    agentType: preset.agentType,
    // O modelo entra no COMANDO, e não num campo novo do terminal: o comando já
    // é texto livre, já aparece no diálogo de edição e já passa pelo mesmo
    // `resolveTemplate` do spawn. Um campo próprio duplicaria isso em types,
    // bridge, store e diálogo sem o usuário ganhar nada que já não veja.
    command: freeCommand ?? presetCommand,
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
  const what = freeCommand !== undefined ? `command '${freeCommand}'` : preset.label
  const role = assignedRoleId ? `, role '${roles.get(assignedRoleId)?.name}'` : ''
  const account = claudeAccountId ? `, Claude account '${claudeAccounts.labelFor(claudeAccountId)}'` : ''
  const onModel = resolvedModel
    ? `, model '${resolvedModel.id}'${resolvedModel.alias ? ` (alias '${resolvedModel.alias}')` : ''}`
    : ''
  return [
    `Recruited '${name}' (${what}) in ${where}${role}${account}${onModel}, connected to this terminal.`,
    "It boots when its node is on screen — run 'atelier list' and wait for it to leave [not started]",
    "before asking it anything. When it is done, 'atelier dismiss' removes it."
  ].join('\n')
}
