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
 * ─── Onde o `--settings` mora ───
 *
 * Não aqui. Este módulo só CONTRIBUI o bloco `statusLine`; quem é dono do
 * arquivo, do caminho e da anexação ao comando é terminal/agent-settings.ts,
 * porque o Artesão passou a escrever no mesmo arquivo.
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
import type { AgentUsage, StoredAccountUsage, UUID } from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID } from '@shared/types'
import { parseStatusLine } from '@shared/agent-usage'
import { log } from '../logger'
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
//
// Quem responde "este comando é Claude Code?" é `isClaudeCommandLine`, em
// shared/terminal-presets.ts: a pergunta também é do diálogo, e duas cópias
// divergem. Aqui ficou só o bloco que este módulo contribui.

/**
 * O bloco que este módulo contribui ao `settings.json` do terminal.
 *
 * `padding: 0` de propósito: a barra é do usuário, e o Atelier não tem por que
 * mexer no espaçamento dela. `refreshInterval` também fica de fora — o Claude
 * Code já re-executa o comando a cada mensagem nova, e um timer por cima disso
 * seria um processo a mais por agente por nada.
 *
 * Quem o compõe com os outros blocos e grava o arquivo é
 * terminal/agent-settings.ts.
 */
export function statusLineBlock(): object {
  return { statusLine: { type: 'command', command: 'atelier statusline' } }
}
