/**
 * O cofre visto por quem o consome: o CLI do agente, o boot do PTY e o
 * `portal login`.
 *
 * O `persistence-manager` sabe ler e gravar o `.vault` cifrado; este módulo
 * responde às perguntas que importam — QUAIS cofres este terminal enxerga, o
 * valor pode ser entregue, este segredo pode ser digitado NESTA página — e é o
 * único lugar onde um valor sai do arquivo para alguém.
 *
 * A REGRA DE ESCOPO É UMA SÓ, e é a mesma de nota, portal e tabela: só o que
 * está ligado por cabo ao chamador existe. Cofre no outro canto do canvas não
 * é "negado", é invisível — e é por isso que as funções daqui recebem sempre
 * o id de quem pergunta.
 *
 * ESCRITA pelo agente: existe UMA, `createSecret`, e ela só CRIA. Não
 * sobrescreve chave existente, não apaga, não liga `inEnv` e não declara
 * `origin` — os dois campos que dão poder a uma entrada (entrar no ambiente de
 * todo terminal ligado, poder ser digitada numa página) continuam sendo decisão
 * do usuário no nó. A entrada criada por agente nasce inerte: só `vault get` a
 * alcança, e a nota dela diz de onde veio. Editar e apagar seguem sendo os
 * canais `vault:*` do bridge, isto é, a UI.
 */
import type { CanvasNode, SecretVaultContent, UUID } from '@shared/types'
import { notifyRenderer } from '../../ipc/notify'
import type { VaultEntry, VaultFile } from '@shared/vault'
import { isValidKeyName, sameOrigin, withNewEntry } from '@shared/vault'
import { nodeDisplayName } from '../models/node-content'
import { persistence } from '../persistence/persistence-manager'
import { appState } from '../state/app-state'
import type { WorkspaceManager } from '../state/workspace-manager'
import { rememberSecret } from './masking'

export interface ConnectedVault {
  nodeId: UUID
  content: SecretVaultContent
  label: string
}

/** O workspace que contém o nó — não necessariamente o ativo. */
function workspaceOf(nodeId: UUID): WorkspaceManager | null {
  for (const ws of appState.workspaces.values()) {
    if (ws.node(nodeId)) return ws
  }
  return null
}

function asVault(node: CanvasNode | undefined): ConnectedVault | null {
  if (!node || node.content.type !== 'secretVault') return null
  return { nodeId: node.id, content: node.content.value, label: nodeDisplayName(node.content) }
}

/** Cofres ligados por cabo a este nó (um terminal, ou um portal). */
export function connectedVaults(nodeId: UUID): ConnectedVault[] {
  const ws = workspaceOf(nodeId)
  if (!ws) return []
  return ws
    .connectedNodeIds(nodeId)
    .map((id) => asVault(ws.node(id)))
    .filter((v): v is ConnectedVault => v !== null)
}

/**
 * Cofre pelo nome, dentro do escopo do chamador. Mesma busca fuzzy dos outros
 * handlers (exato → substring → prefixo do id), para o agente poder escrever o
 * nome como o vê no canvas.
 */
export function findConnectedVault(nodeId: UUID, name: string): ConnectedVault | null {
  const list = connectedVaults(nodeId)
  const needle = name.toLowerCase().trim()
  return (
    list.find((v) => v.label.toLowerCase() === needle) ??
    list.find((v) => v.label.toLowerCase().includes(needle)) ??
    list.find((v) => v.nodeId.toLowerCase().startsWith(needle.slice(0, 8))) ??
    null
  )
}

/** O arquivo decifrado de um cofre, ou null se ilegível (chaveiro, versão). */
async function fileOf(vault: ConnectedVault): Promise<VaultFile | null> {
  const ws = workspaceOf(vault.nodeId)
  if (!ws) return null
  return persistence.readVault(ws.id, vault.content.id)
}

function entryOf(file: VaultFile, key: string): VaultEntry | null {
  return file.entries.find((e) => e.key === key) ?? null
}

/**
 * A projeção sem valor — o que o renderer e o workspace.json podem ver.
 *
 * Mora aqui, e não no bridge, porque o `.vault` passou a ter dois escritores: a
 * UI e o `atelier vault set`. Espelho escrito em dois lugares é espelho que
 * diverge.
 */
export function keyRefs(file: VaultFile): SecretVaultContent['keys'] {
  return file.entries.map((e) => ({
    key: e.key,
    inEnv: e.inEnv,
    origin: e.origin,
    note: e.note,
    updatedAt: e.updatedAt,
    source: e.source
  }))
}

/**
 * Espelha os NOMES de chave no conteúdo do nó. `file: null` = o cofre não pôde
 * ser lido; o nó fica `locked` e a lista antiga é preservada, porque ela ainda
 * descreve o que há no arquivo — apagá-la faria o usuário achar que perdeu as
 * chaves quando o que faltou foi o chaveiro do SO.
 */
export function syncVaultKeys(workspaceId: UUID, nodeId: UUID, file: VaultFile | null): void {
  const ws = appState.workspaces.get(workspaceId)
  if (!ws) return
  ws.updateContent(nodeId, (node) => {
    if (node.content.type !== 'secretVault') return
    node.content.value.locked = file === null
    if (file) node.content.value.keys = keyRefs(file)
  })
}

// ─── Leitura pelo agente ──────────────────────────────────────────────────────

export interface SecretResult {
  value: string
  vault: ConnectedVault
}

/**
 * O valor, para o `atelier vault get`.
 *
 * Devolve string de erro em vez de lançar porque o chamador é um handler de
 * CLI: a frase vai inteira para o terminal do agente, e uma frase que explica
 * o que fazer vale mais que uma stack.
 *
 * Efeito colateral deliberado: o valor entregue passa a ser mascarado no
 * scrollback deste terminal. O agente tem o segredo no contexto — é escolha
 * dele —, mas ele não precisa ficar gravado em claro no disco também.
 */
export async function getSecret(
  terminalId: UUID,
  vaultName: string,
  key: string
): Promise<SecretResult | string> {
  const vault = findConnectedVault(terminalId, vaultName)
  if (!vault) {
    return `error: vault '${vaultName}' not found. Use 'atelier vault list' to see connected vaults.`
  }
  const file = await fileOf(vault)
  if (!file) return lockedMessage(vault)
  const entry = entryOf(file, key)
  if (!entry) {
    const known = file.entries.map((e) => e.key).join(', ') || '(no keys yet)'
    return `error: key '${key}' not found in '${vault.label}'. Keys: ${known}`
  }

  rememberSecret(terminalId, entry.value)
  await logAccess(vault, terminalId, `get ${entry.key}`)
  return { value: entry.value, vault }
}

/** As chaves de um cofre — nomes, nunca valores. */
export async function listKeys(vault: ConnectedVault): Promise<VaultEntry[] | string> {
  const file = await fileOf(vault)
  if (!file) return lockedMessage(vault)
  return file.entries
}

function lockedMessage(vault: ConnectedVault): string {
  return (
    `error: vault '${vault.label}' is locked — the OS keychain is unavailable, ` +
    'or the file was written by a newer version of the Atelier. Ask the user to check the node.'
  )
}

// ─── Escrita pelo agente ──────────────────────────────────────────────────────

/**
 * `atelier vault set` — acrescenta UMA chave a um cofre ligado.
 *
 * Três travas, e nenhuma delas é conveniência:
 *
 *  1. ESCOPO. Só cofre ligado por cabo a quem pede, como toda a leitura. Um
 *     agente não escreve em cofre que ele nem enxerga.
 *  2. SÓ CRIA. Chave existente é recusada com o nome dela. Trocar o valor de uma
 *     chave que o usuário já usa, sem que a lista do nó mude de aparência, é a
 *     edição silenciosa que este comando não pode permitir — e é por isso que
 *     não existe `--force`.
 *  3. NASCE INERTE. `origin: null` e `inEnv: false`, sempre. A entrada serve a
 *     `vault get` e nada mais até o usuário decidir o contrário; ligar `inEnv`
 *     aqui colocaria o segredo no ambiente de todo terminal ligado ao cofre, e
 *     declarar `origin` abriria o `portal login` para ele.
 *
 * A nota registra a procedência — é o que o usuário lê no nó para saber que
 * aquela entrada não foi ele quem digitou.
 */
export async function createSecret(
  terminalId: UUID,
  vaultName: string,
  key: string,
  value: string
): Promise<{ vault: ConnectedVault; key: string } | string> {
  const vault = findConnectedVault(terminalId, vaultName)
  if (!vault) {
    return `error: vault '${vaultName}' not found. Use 'atelier vault list' to see connected vaults.`
  }
  if (!isValidKeyName(key)) {
    return (
      `error: '${key}' is not a valid key name. Use letters, digits and _, starting with a ` +
      'letter or _ — the key becomes an environment variable.'
    )
  }
  if (!value) return 'error: an empty value is not a secret.'

  const ws = workspaceOf(vault.nodeId)
  if (!ws) return lockedMessage(vault)
  const file = await fileOf(vault)
  if (!file) {
    syncVaultKeys(ws.id, vault.nodeId, null)
    return lockedMessage(vault)
  }

  const entry: VaultEntry = {
    key,
    value,
    origin: null,
    inEnv: false,
    note: `criada pelo agente do terminal ${terminalId.slice(0, 8)}`,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    // O agente teve o valor em claro: a entrada já nasce pedindo troca.
    source: 'agent'
  }
  const next = withNewEntry(file, entry)
  if (!next) {
    return (
      `error: '${key}' already exists in '${vault.label}'. Creating is the only write you have: ` +
      'ask the user to delete it in the vault node if it needs a new value.'
    )
  }
  if (!(await persistence.writeVault(ws.id, vault.content.id, next))) {
    syncVaultKeys(ws.id, vault.nodeId, null)
    return lockedMessage(vault)
  }

  syncVaultKeys(ws.id, vault.nodeId, next)
  // O nó aberto no canvas mostra a chave nova sem esperar um remonte: quem
  // escreveu foi o agente, e o usuário precisa ver isso acontecer.
  notifyRenderer('vault:changed', { workspaceId: ws.id, nodeId: vault.nodeId })
  // O valor passa a ser mascarado no scrollback deste terminal pelo mesmo
  // motivo do `get`: ele foi digitado no comando, e o eco do shell o gravaria
  // em claro no disco.
  rememberSecret(terminalId, value)
  await logAccess(vault, terminalId, `set ${key}`)
  return { vault, key }
}

// ─── Ambiente do PTY ──────────────────────────────────────────────────────────

export interface EnvResult {
  env: Record<string, string>
  /** Chaves que entraram, para o `atelier vault env` listar sem revelar valor. */
  keys: string[]
  /** Colisão entre dois cofres: o spawn é recusado com esta frase. */
  error?: string
}

/**
 * As variáveis que os cofres ligados a este terminal injetam no PTY.
 *
 * Colisão de nome entre dois cofres NÃO é resolvida por precedência: escolher
 * um valor em silêncio faria o agente rodar contra o banco errado sem ninguém
 * perceber. O spawn falha com o nome da chave e dos dois cofres.
 */
export async function envForTerminal(terminalId: UUID): Promise<EnvResult> {
  const env: Record<string, string> = {}
  const keys: string[] = []
  const from = new Map<string, string>()

  for (const vault of connectedVaults(terminalId)) {
    const file = await fileOf(vault)
    if (!file) continue
    for (const entry of file.entries) {
      if (!entry.inEnv) continue
      const owner = from.get(entry.key)
      if (owner && owner !== vault.label) {
        return {
          env: {},
          keys: [],
          error:
            `chave '${entry.key}' existe em dois cofres ligados a este terminal ` +
            `('${owner}' e '${vault.label}'). Renomeie uma delas ou desligue um cabo.`
        }
      }
      from.set(entry.key, vault.label)
      env[entry.key] = entry.value
      keys.push(entry.key)
    }
  }
  return { env, keys }
}

/**
 * Expande `${vault:Cofre/CHAVE}` no comando, no momento de escrever no PTY.
 *
 * O `workspace.json` guarda o template, nunca o valor — é a diferença entre um
 * arquivo em claro com `psql "${vault:prod/DB_URL}"` e um com a senha dentro.
 * Referência que não resolve derruba o comando inteiro: rodar `psql ""` seria
 * pior que não rodar, porque o erro apareceria longe da causa.
 */
const TEMPLATE = /\$\{vault:([^/}]+)\/([^}]+)\}/g

export async function resolveTemplate(
  terminalId: UUID,
  command: string
): Promise<{ command: string } | { error: string }> {
  const found = [...command.matchAll(TEMPLATE)]
  if (found.length === 0) return { command }

  let out = command
  for (const [literal, vaultName, key] of found) {
    const secret = await getSecretForTemplate(terminalId, vaultName.trim(), key.trim())
    if ('error' in secret) return { error: secret.error }
    out = out.split(literal).join(secret.value)
  }
  return { command: out }
}

/**
 * Como o `getSecret`, sem o efeito de mascaramento e sem auditoria de leitura
 * pelo agente: aqui quem lê é o Atelier, para escrever no PTY. O valor não
 * passa pelo contexto de ninguém — mas ENTRA no scrollback pelo eco do shell,
 * e é por isso que ele também é lembrado para mascarar.
 */
async function getSecretForTemplate(
  terminalId: UUID,
  vaultName: string,
  key: string
): Promise<{ value: string } | { error: string }> {
  const vault = findConnectedVault(terminalId, vaultName)
  if (!vault) return { error: `'${vaultName}' não é um cofre ligado a este terminal` }
  const file = await fileOf(vault)
  if (!file) return { error: lockedMessage(vault) }
  const entry = entryOf(file, key)
  if (!entry) return { error: `o cofre '${vault.label}' não tem a chave '${key}'` }
  rememberSecret(terminalId, entry.value)
  await logAccess(vault, terminalId, `template ${entry.key}`)
  return { value: entry.value }
}

// ─── Portal ───────────────────────────────────────────────────────────────────

/**
 * O segredo que pode ser digitado NESTA página, e a recusa quando não pode.
 *
 * Três travas, nesta ordem, e nenhuma delas é dispensável:
 *
 *  1. o cofre precisa estar ligado ao TERMINAL que pediu e ao PORTAL onde vai
 *     ser digitado — um cabo só não basta;
 *  2. a entrada precisa declarar `origin`. `null` significa "não autorizado em
 *     portal nenhum", que é o padrão de toda entrada nova;
 *  3. a origem declarada precisa bater com a da página no momento de digitar.
 *
 * A terceira é a que impede o ataque que o modelo de ameaça descreve: o agente
 * navega o portal para um site que ele controla e manda `portal login`. Sem a
 * comparação, o Atelier digitaria a senha do GitHub no formulário do atacante —
 * o agente nunca veria o valor, e não precisaria, porque o site veria.
 */
export async function secretForPortal(
  terminalId: UUID,
  portalNodeId: UUID,
  vaultName: string,
  key: string,
  pageURL: string
): Promise<SecretResult | string> {
  const vault = findConnectedVault(terminalId, vaultName)
  if (!vault) {
    return `error: vault '${vaultName}' not found. Use 'atelier vault list' to see connected vaults.`
  }
  const alsoOnPortal = connectedVaults(portalNodeId).some((v) => v.nodeId === vault.nodeId)
  if (!alsoOnPortal) {
    return (
      `error: vault '${vault.label}' is not connected to that portal. ` +
      'Ask the user to draw a cable from the vault node to the portal node.'
    )
  }

  const file = await fileOf(vault)
  if (!file) return lockedMessage(vault)
  const entry = entryOf(file, key)
  if (!entry) {
    const known = file.entries.map((e) => e.key).join(', ') || '(no keys yet)'
    return `error: key '${key}' not found in '${vault.label}'. Keys: ${known}`
  }

  if (!entry.origin) {
    return (
      `error: key '${key}' declares no origin, so it cannot be typed into any page. ` +
      'Ask the user to set the origin of that key in the vault node (for example https://github.com).'
    )
  }
  if (!sameOrigin(entry.origin, pageURL)) {
    return (
      `error: key '${key}' is only allowed on ${entry.origin}, and this portal is on ` +
      `${originLabel(pageURL)}. Nothing was typed.`
    )
  }

  // O agente não recebe o valor — mas a página passa a tê-lo, e ele pode ler a
  // página. Mascarar a partir daqui é o que impede o segredo de voltar pelo
  // `portal read` do próximo comando.
  rememberSecret(terminalId, entry.value)
  await logAccess(vault, terminalId, `login ${entry.key} → ${entry.origin}`)
  return { value: entry.value, vault }
}

/** Os valores dos cofres ligados a um portal — o filtro do que ele devolve. */
export async function valuesForPortal(portalNodeId: UUID): Promise<string[]> {
  const out: string[] = []
  for (const vault of connectedVaults(portalNodeId)) {
    const file = await fileOf(vault)
    if (!file) continue
    for (const entry of file.entries) out.push(entry.value)
  }
  return out
}

function originLabel(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url || '(página em branco)'
  }
}

// ─── Auditoria ────────────────────────────────────────────────────────────────

/**
 * Uma linha por acesso em `vaults/access.log`: quando, qual terminal, qual
 * cofre, qual chave. NUNCA o valor — o log é arquivo em claro, e um log que
 * guarda o segredo desfaz o cofre inteiro.
 */
async function logAccess(vault: ConnectedVault, terminalId: UUID, what: string): Promise<void> {
  const ws = workspaceOf(vault.nodeId)
  if (!ws) return
  const line = `${new Date().toISOString()}\t${terminalId.slice(0, 8)}\t${vault.content.id}\t${what}\n`
  await persistence.appendVaultAccess(ws.id, line).catch(() => undefined)
}
