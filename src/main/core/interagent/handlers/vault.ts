/**
 * `atelier vault` — o cofre visto pelo agente.
 *
 * Cinco verbos. `create` põe um cofre VAZIO no canvas — é o nó, não segredo
 * nenhum: o `.vault` só passa a existir quando a primeira chave é gravada, e um
 * nó a mais é reversível com um clique. Ele entrou porque o cofre era o único
 * nó conectável que o agente não conseguia criar, e o padrão do canvas é que
 * todo nó possa ser criado e cabeado (ver
 * docs/2026-09-08-PLANO-todo-no-cabeado-e-com-referencia.md).
 *
 * Dos outros quatro, um só escreve: `set` CRIA uma chave, e só
 * isso. Não sobrescreve, não apaga, não liga `inEnv` e não declara `origin` —
 * as duas coisas que dariam poder à entrada continuam sendo decisão do usuário
 * no nó. É a resposta ao risco de sempre (um agente que grava segredo é vetor
 * de exfiltração) sem fechar a porta inteira: acrescentar é reversível e fica
 * na trilha; trocar por baixo o valor de uma chave em uso não seria.
 *
 * `list` e `env` nunca revelam valor. `get` revela — e é o único caminho em que
 * o segredo entra no contexto do agente, o que faz dele o único que precisa de
 * aviso, de trilha de auditoria e de mascaramento do scrollback daí em diante.
 * `set` também mascara: o valor foi digitado na linha de comando.
 */
import type { UUID } from '@shared/types'
import {
  connectedVaults,
  createSecret,
  envExportForTerminal,
  envForTerminal,
  findConnectedVault,
  getSecret,
  listKeys
} from '../../vault/vault-manager'
import { makeSecretVaultContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { defaultSize, minSize } from '../../node-sizes'
import { resolveFrame, takePlacementFlags } from '../../spawn-spot'
import { notifyRenderer } from '../../../ipc/notify'
import { requireTerminalId, workspaceForTerminal, resolveLayoutTarget } from './context'

const USAGE =
  'error: usage: atelier vault <list|get|set|env|create> …\n' +
  '  env [--export]     key names, or export lines to eval into your shell\n' +
  '  create "Name"      an EMPTY vault node on the canvas, cabled to you'

export async function handleVault(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'list':
      return listVaults(tid)
    case 'get':
      return getValue(args, tid)
    case 'set':
      return setValue(args, tid)
    case 'env':
      return listEnv(args, tid)
    case 'create':
      return createVault(args, tid)
    default:
      return USAGE
  }
}

/**
 * Os cofres ligados e as chaves de cada um — nomes, `env` e a origem quando há.
 *
 * A origem aparece porque ela decide o que o agente pode fazer com a chave: sem
 * ela, `portal login` recusa, e saber disso antes de tentar poupa uma ida.
 */
async function listVaults(tid: UUID): Promise<string> {
  const vaults = connectedVaults(tid)
  if (vaults.length === 0) {
    return 'No connected vaults.\nAsk the user to draw a cable from a vault node to this terminal.'
  }

  const lines: string[] = ['Connected vaults:']
  for (const vault of vaults) {
    const entries = await listKeys(vault)
    if (typeof entries === 'string') {
      lines.push(`  ${vault.label}  — locked (OS keychain unavailable)`)
      continue
    }
    lines.push(`  ${vault.label}  (${entries.length} key${entries.length === 1 ? '' : 's'})`)
    for (const entry of entries) {
      const flags = [entry.inEnv ? 'env' : null, entry.origin ? `origin ${entry.origin}` : null]
        .filter(Boolean)
        .join(', ')
      lines.push(`    ${entry.key}${flags ? `  [${flags}]` : ''}`)
    }
  }
  lines.push('')
  lines.push("Values are never listed. Use 'atelier vault get \"Vault\" <key>' when you need one.")
  return lines.join('\n')
}

async function getValue(args: string[], tid: UUID): Promise<string> {
  const [, , vaultName, key] = args
  if (!vaultName || !key) return 'error: usage: atelier vault get "Vault" <key>'

  const result = await getSecret(tid, vaultName, key)
  if (typeof result === 'string') return result

  // O aviso vem DEPOIS do valor, para o agente que corta a saída ainda pegar o
  // que pediu, e é curto de propósito: repreender a cada leitura ensina o
  // agente a ignorar o texto.
  return (
    `${result.value}\n\n` +
    '(this value is now in your context; prefer the injected env var when there is one — ' +
    "'atelier vault env' lists them — and never echo it into a file or another terminal)"
  )
}

/**
 * `atelier vault set "Cofre" CHAVE VALOR` — acrescenta uma chave.
 *
 * O valor é o RESTO da linha, não só o quarto argumento: segredo com espaço é
 * comum, e obrigar o agente a citar corretamente daria erro silencioso (a chave
 * gravada com metade do valor) em vez de recusa.
 *
 * A resposta não repete o valor. Ela diz o que o usuário vai ver no nó — e o
 * que a entrada NÃO pode fazer, porque é a pergunta seguinte do agente que
 * acabou de gravar uma senha de site e vai tentar usá-la no portal.
 */
async function setValue(args: string[], tid: UUID): Promise<string> {
  const [, , vaultName, key] = args
  const value = args.slice(4).join(' ')
  if (!vaultName || !key || !value) {
    return 'error: usage: atelier vault set "Vault" <KEY> <value>'
  }

  const result = await createSecret(tid, vaultName, key, value)
  if (typeof result === 'string') return result

  return (
    `Stored ${result.key} in '${result.vault.label}'.\n` +
    'It was created inert: no origin (so it cannot be typed by portal login) and not in the ' +
    'environment of any terminal. Ask the user to set those in the vault node if the key needs them.\n' +
    'Creating is the only write you have — you cannot change or delete a key. If the value ' +
    'you stored is a placeholder, say so: the user swaps the secret with the pencil button on ' +
    'the key, keeping the origin, the note and the env flag.'
  )
}

/**
 * Quais chaves já estão no ambiente DESTE PTY.
 *
 * Não lê `process.env` do main: o que vale é o que os cofres ligados injetariam
 * num spawn agora. A diferença aparece quando o cabo foi ligado depois do boot
 * — e é exatamente esse o caso em que o agente precisa ser avisado de que a
 * variável só existirá no próximo boot do terminal.
 */
async function listEnv(args: string[], tid: UUID): Promise<string> {
  const wantsExport = args.includes('--export')
  const name = args.slice(2).find((a) => !a.startsWith('--'))

  // `--export` CARREGA as chaves no shell de quem chama, em vez de listar
  // nomes. É o único caminho que existe para um cofre cabeado DEPOIS do boot do
  // PTY: o ambiente do processo já nasceu, e um cabo novo não alcança processo
  // vivo. Sem isto, sobrava `vault get`, que traz o segredo para o contexto do
  // agente — exatamente o que a skill desaconselha.
  //
  // O valor não passa pela tela: quem imprime é um `$( )`, e o CLI recusa
  // quando a saída é um terminal (ver resources/atelier.cjs).
  if (wantsExport) {
    const result = await envExportForTerminal(tid)
    if (result.error) return `error: ${result.error}`
    if (!result.script) {
      return (
        '# no vault keys are exposed to this terminal\n' +
        '# a key only exports when its "in env" toggle is on in the vault node'
      )
    }
    return result.script
  }

  const result = await envForTerminal(tid)
  if (result.error) return `error: ${result.error}`

  const scoped = name ? await keysOfNamed(tid, name) : result.keys
  if (typeof scoped === 'string') return scoped
  if (scoped.length === 0) {
    return (
      'No vault keys are exposed to this terminal.\n' +
      'A key enters the environment only when its "in env" toggle is on in the vault node, ' +
      'and only from the next terminal boot after the cable was drawn.'
    )
  }
  return [
    'Vault keys in this environment:',
    ...scoped.map((k) => `  $${k}`),
    // A dica só aparece quando ela resolve algo: as chaves existem no cofre mas
    // podem não estar NESTE processo, porque o cabo veio depois do boot.
    'If they are not set in your shell, the cable came after this terminal booted.',
    'Load them without printing any value:  eval "$(atelier vault env --export)"'
  ].join('\n')
}

async function keysOfNamed(tid: UUID, name: string): Promise<string[] | string> {
  const vault = findConnectedVault(tid, name)
  if (!vault) return `error: vault '${name}' not found. Use 'atelier vault list'.`
  const entries = await listKeys(vault)
  if (typeof entries === 'string') return entries
  return entries.filter((e) => e.inEnv).map((e) => e.key)
}

/**
 * `atelier vault create "Nome"` — um cofre VAZIO no canvas, já cabeado.
 *
 * O único verbo desta família que cria nó, e ele não é uma abertura no cuidado
 * escrito no topo do arquivo: aquele cuidado é sobre GRAVAR segredo, e continua
 * inteiro — `set` segue sendo a única escrita, a chave nasce inerte, e não há
 * como alterar nem apagar. Um cofre sem chave não tem nada a proteger e nem
 * arquivo em disco (ver `makeSecretVaultContent`).
 *
 * Nome repetido NÃO é recusado, ao contrário da árvore de arquivos: dois cofres
 * chamados "AWS" para contas diferentes é arranjo legítimo, e a busca por nome
 * dos outros verbos resolve pelo id quando o nome é ambíguo. O que a resposta
 * faz é AVISAR, para o agente não achar que criou um segundo por engano.
 */
function createVault(argv: string[], tid: UUID): string {
  const { rest: args, placement } = takePlacementFlags(argv)
  const name = args.slice(2).join(' ').trim()
  if (!name) return 'error: usage: atelier vault create "Name" [--at x,y]'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const content = makeSecretVaultContent(name)
  const size = defaultSize('secretVault')
  const lugar = resolveFrame(ws, caller, size, placement, {
    find: (nome) => resolveLayoutTarget(ws, caller, tid, nome),
    displayName: (n) => nodeDisplayName(n.content),
    floor: [minSize('secretVault').width, minSize('secretVault').height]
  })
  if ('error' in lugar) return lugar.error
  const node = makeCanvasNode(lugar.frame, {
    type: 'secretVault',
    value: content
  })

  ws.addNode(node)
  ws.addConnection(tid, node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const homonimos = ws.nodes.filter(
    (n) => n.content.type === 'secretVault' && n.content.value.name === name && n.id !== node.id
  ).length

  return [
    `Created vault '${name}' (${node.id.slice(0, 8)}), empty and connected to this terminal.`,
    homonimos > 0
      ? `⚠ ${homonimos} other vault${homonimos === 1 ? '' : 's'} on this canvas already answer to '${name}' — address this one by id if a verb picks the wrong one.`
      : '',
    "Keys are added with 'atelier vault set' — each one inert (no origin, not in any environment)",
    'until the user grants it those in the node.'
  ]
    .filter(Boolean)
    .join('\n')
}
