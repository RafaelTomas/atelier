/**
 * `atelier vault` — o cofre visto pelo agente.
 *
 * Quatro verbos, e o quarto é o único que escreve: `set` CRIA uma chave, e só
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
  envForTerminal,
  findConnectedVault,
  getSecret,
  listKeys
} from '../../vault/vault-manager'
import { requireTerminalId } from './context'

const USAGE = 'error: usage: atelier vault <list|get|set|env> …'

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
    'Creating is the only write you have — you cannot change or delete a key.'
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
  const name = args[2]
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
  return ['Vault keys in this environment:', ...scoped.map((k) => `  $${k}`)].join('\n')
}

async function keysOfNamed(tid: UUID, name: string): Promise<string[] | string> {
  const vault = findConnectedVault(tid, name)
  if (!vault) return `error: vault '${name}' not found. Use 'atelier vault list'.`
  const entries = await listKeys(vault)
  if (typeof entries === 'string') return entries
  return entries.filter((e) => e.inEnv).map((e) => e.key)
}
