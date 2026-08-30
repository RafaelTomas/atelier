/**
 * A `statusLine` do Claude Code como canal de telemetria do Atelier.
 *
 * O Claude Code roda um comando a cada mensagem nova e entrega no stdin dele um
 * JSON com o estado da sessão: modelo, tokens na janela, tamanho da janela,
 * custo em dólares, linhas mudadas e as janelas de limite com hora de reset.
 * Nada disso existe na tela em forma legível — `agent-status.ts` raspa `103
 * tok` de uma linha de texto e não sabe sequer se a janela é de 200k ou de 1M.
 *
 * O comando que o Atelier instala é `atelier statusline`. Ele devolve o payload
 * por AQUI, pelo mesmo socket e com o mesmo `X-Terminal-ID` do resto do CLI —
 * zero protocolo novo.
 *
 * ─── Por que `--settings`, e não escrever no ~/.claude do usuário ───
 *
 * O `claude` aceita `--settings <arquivo>`, que sobrepõe apenas as chaves
 * passadas e vale só para AQUELA sessão. Escrever `statusLine` no settings.json
 * da conta seria uma alteração permanente na configuração do usuário, feita por
 * um app de canvas, que sobreviveria ao Atelier fechado e apareceria nos
 * terminais que ele abre por fora. O arquivo gerado aqui vive no diretório de
 * dados do Atelier, um por terminal, e é reescrito a cada boot do PTY.
 *
 * ─── Por que o encadeamento ───
 *
 * A `statusLine` é uma só: instalar a nossa APAGA a que o usuário tenha. Por
 * isso `ATELIER_STATUSLINE_INNER` carrega o comando original, o CLI o executa
 * com o mesmo stdin e imprime a saída dele. Quem já tinha uma barra de status
 * continua vendo exatamente a mesma barra.
 *
 * Módulo sem `electron` — o smoke headless exercita a montagem.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentUsage, StoredAccountUsage, UUID } from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID } from '@shared/types'
import { parseStatusLine } from '@shared/agent-usage'
import { log } from '../logger'
import { dataDir } from '../persistence/paths'
import { persistence } from '../persistence/persistence-manager'

/**
 * A última leitura publicada por cada terminal.
 *
 * Em memória, e nunca no workspace: é estado de SESSÃO, como o `terminalStatus`
 * raspado. Gravá-lo faria o arquivo afirmar, na próxima abertura, um custo e um
 * contexto de uma sessão que já morreu.
 */
const readings = new Map<UUID, AgentUsage>()

export function setUsage(terminalId: UUID, usage: AgentUsage): void {
  readings.set(terminalId, usage)
}

export function getUsage(terminalId: UUID): AgentUsage | undefined {
  return readings.get(terminalId)
}

/**
 * Terminal morreu: a leitura dele não vale mais para o painel.
 *
 * O ledger da CONTA continua — ele não é do terminal, e a janela de limite que
 * ele publicou segue valendo até o `resetsAt` dela.
 */
export function forgetUsage(terminalId: UUID): void {
  readings.delete(terminalId)
  terminalAccounts.delete(terminalId)
}

/** Só para teste — o registro é global ao processo. */
export function resetUsage(): void {
  readings.clear()
  terminalAccounts.clear()
  accountLimits.clear()
}

// ─── O ledger por conta ───────────────────────────────────────────────────────
//
// A leitura por TERMINAL acima morre com o PTY, e é o certo: custo e contexto
// são da sessão. As janelas de limite, não — elas são da CONTA e trazem a
// própria validade no `resetsAt`. Sem guardá-las, a conta em que o usuário não
// tem terminal aberto agora apareceria vazia no painel de perfis, que é
// exatamente a conta sobre a qual ele precisa decidir se abre mais um agente.
//
// O que se guarda é só isso: janela, percentual e prazo. Custo de sessão morta
// não entra (ver StoredAccountUsage, em shared/types.ts).

/**
 * Em que conta cada terminal subiu. Quem sabe disso é o `terminal:spawn`, no
 * bridge, que já resolve o `CLAUDE_CONFIG_DIR` — a `statusLine` chega aqui só
 * com o id do terminal, e sem este mapa a leitura não teria a quem pertencer.
 */
const terminalAccounts = new Map<UUID, string>()

/** A última leitura de limites de cada conta. Espelha claude-usage.json. */
const accountLimits = new Map<string, StoredAccountUsage>()

let saveTimer: NodeJS.Timeout | null = null

/**
 * Cinco segundos de espera antes de gravar. Um agente publica a `statusLine` a
 * cada mensagem, e com seis terminais abertos isso é um punhado de escritas por
 * minuto num arquivo que ninguém lê no meio da sessão. O que importa é ele
 * estar em disco na PRÓXIMA abertura do app.
 */
const SAVE_DEBOUNCE_MS = 5000

/** O terminal subiu nesta conta. `null` é a padrão — ela também tem ledger. */
export function setTerminalAccount(terminalId: UUID, accountId: string | null): void {
  terminalAccounts.set(terminalId, accountId || DEFAULT_CLAUDE_ACCOUNT_ID)
}

/** O ledger inteiro, para o renderer. Quem julga validade é a UI (activeWindows). */
export function accountUsage(): StoredAccountUsage[] {
  return [...accountLimits.values()]
}

/** Lido no boot, antes do primeiro spawn — como a lista de contas. */
export async function loadAccountUsage(): Promise<void> {
  for (const entry of await persistence.loadClaudeUsage()) {
    accountLimits.set(entry.accountId, entry)
  }
  log.debug('statusline', `${accountLimits.size} conta(s) com leitura de limite guardada`)
}

/** Grava agora o que estiver pendente. Chamado no shutdown. */
export async function flushAccountUsage(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (accountLimits.size === 0) return
  try {
    await persistence.saveClaudeUsage(accountUsage())
  } catch (err) {
    log.warn('statusline', 'não deu para gravar claude-usage.json', err)
  }
}

/**
 * A leitura de limites vai para a conta do terminal que a publicou.
 *
 * Leitura mais VELHA que a guardada é ignorada: as publicações de dois
 * terminais da mesma conta chegam intercaladas, e deixar a última a chegar
 * vencer faria o percentual andar para trás na tela.
 */
function rememberAccountLimits(terminalId: UUID, usage: AgentUsage): void {
  if (usage.limits.length === 0) return
  const accountId = terminalAccounts.get(terminalId) ?? DEFAULT_CLAUDE_ACCOUNT_ID
  const seen = accountLimits.get(accountId)
  if (seen && seen.at > usage.at) return
  accountLimits.set(accountId, { accountId, limits: usage.limits, at: usage.at })
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushAccountUsage()
  }, SAVE_DEBOUNCE_MS)
  // O app pode fechar antes do timer: `unref` evita segurar o processo por
  // causa de uma gravação de telemetria, e o `flushAccountUsage` do shutdown é
  // quem garante que ela aconteça.
  saveTimer.unref?.()
}

/**
 * O payload cru vira leitura. Devolve `null` quando o texto nem JSON é: aí não
 * há o que registrar, e sobrescrever a leitura anterior com nada apagaria um
 * dado que ainda valia.
 */
export function recordStatusLine(terminalId: UUID, raw: string): AgentUsage | null {
  const usage = parseStatusLine(raw)
  if (!usage) return null
  readings.set(terminalId, usage)
  rememberAccountLimits(terminalId, usage)
  return usage
}

// ─── A instalação no agente ───────────────────────────────────────────────────

/**
 * Presets que entendem `--settings` e `statusLine`. É feature do Claude Code:
 * Codex, Antigravity e OpenCode não a têm, e para eles o raspador de tela
 * continua sendo a única fonte — ver o cabeçalho de shared/agent-usage.ts.
 *
 * O teste é sobre o PRIMEIRO token do comando, não sobre o texto inteiro: o
 * usuário pode ter escrito `claude --resume` ou `claude -p "..."` no preset, e
 * as duas continuam sendo Claude Code.
 */
export function isClaudeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? ''
  // Sem diretório e sem extensão: `/usr/local/bin/claude` e `claude.cmd` contam.
  const base = (first.split(/[\\/]/).pop() ?? '').replace(/\.(cmd|exe|bat|ps1)$/i, '')
  return base === 'claude'
}

/** Onde mora o settings gerado deste terminal. */
export function statusLineSettingsPath(terminalId: UUID): string {
  return join(dataDir(), 'statusline', `${terminalId}.json`)
}

/**
 * O conteúdo do arquivo de settings.
 *
 * `padding: 0` de propósito: a barra é do usuário, e o Atelier não tem por que
 * mexer no espaçamento dela. `refreshInterval` também fica de fora — o Claude
 * Code já re-executa o comando a cada mensagem nova, e um timer por cima disso
 * seria um processo a mais por agente por nada.
 */
export function statusLineSettings(): string {
  return JSON.stringify({ statusLine: { type: 'command', command: 'atelier statusline' } }, null, 2)
}

/**
 * Grava o settings do terminal e devolve o comando com `--settings` anexado.
 *
 * Devolve o comando INTACTO em três casos, e cada um é uma recusa deliberada:
 *
 *  - não é Claude Code — não há `statusLine` para instalar;
 *  - o comando já traz um `--settings` — o do usuário vence, e sobrepor o dele
 *    em silêncio trocaria a configuração que ele escreveu à mão;
 *  - a gravação falhou — um `--settings` apontando para arquivo inexistente
 *    faria o `claude` recusar-se a subir, e um monitor mais rico não vale um
 *    agente que não abre.
 */
export async function withStatusLine(
  command: string,
  terminalId: UUID,
  /** `CLAUDE_CONFIG_DIR` da conta, ou ausente para a conta padrão (~/.claude). */
  claudeConfigDir?: string
): Promise<{ command: string; innerCommand: string | null }> {
  if (!command || !isClaudeCommand(command)) return { command, innerCommand: null }
  if (/(^|\s)--settings(\s|=)/.test(command)) return { command, innerCommand: null }

  const path = statusLineSettingsPath(terminalId)
  try {
    await mkdir(join(dataDir(), 'statusline'), { recursive: true })
    await writeFile(path, statusLineSettings(), 'utf8')
  } catch {
    return { command, innerCommand: null }
  }

  // Aspas duplas: o comando é DIGITADO no shell do PTY, que pode ser sh, zsh,
  // PowerShell ou cmd. As quatro entendem aspas duplas em volta de um caminho
  // com espaço — o `~` do Windows ("C:\Users\Meu Nome\...") é o caso comum.
  return {
    command: `${command} --settings "${path}"`,
    innerCommand: await existingStatusLine(claudeConfigDir)
  }
}

/**
 * A `statusLine` que o usuário já tinha, se tinha.
 *
 * Vai para `ATELIER_STATUSLINE_INNER`, e o CLI a executa com o mesmo stdin,
 * imprimindo a saída dela: quem já configurou uma barra de status continua
 * vendo a MESMA barra dentro do Atelier. Sem isto, ligar o monitor apagaria em
 * silêncio um pedaço da interface que o usuário montou.
 *
 * Só o tipo `command` é encadeado. Qualquer outra forma que a chave venha a
 * aceitar é ignorada em vez de adivinhada — executar às cegas o que está numa
 * chave que não entendemos é pior do que não encadear.
 */
async function existingStatusLine(claudeConfigDir?: string): Promise<string | null> {
  const dir = claudeConfigDir || join(homedir(), '.claude')
  try {
    const raw = await readFile(join(dir, 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const line = (parsed as Record<string, unknown>).statusLine
    if (!line || typeof line !== 'object') return null
    const { type, command } = line as Record<string, unknown>
    if (type !== 'command' || typeof command !== 'string' || !command) return null
    // O nosso próprio comando não se encadeia consigo: um usuário que copiou
    // `atelier statusline` para o settings dele criaria um laço infinito de
    // processos, cada um esperando o stdin do seguinte.
    if (/\batelier\b.*\bstatusline\b/.test(command)) return null
    return command
  } catch {
    return null
  }
}
