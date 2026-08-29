/**
 * Porte de Sources/Terminal/ (SwiftTermProvider + TerminalManager).
 *
 * Mantém os PTYs vivos FORA da árvore de UI — trocar de workspace no renderer
 * destrói as views, mas os processos continuam, igual ao app nativo.
 *
 * SwiftTerm → node-pty (ConPTY no Windows, forkpty no resto).
 */
import { EventEmitter } from 'node:events'
import type { IPty } from 'node-pty'
import type { AgentStatus, TerminalSpawnOptions, UUID } from '@shared/types'
import { Constants } from '../constants'
import { log } from '../logger'
import { defaultShell } from '../models/node-content'
import { atelierBinDir } from '../interagent/cli-install'
import { persistence } from '../persistence/persistence-manager'
import { ipcSocketPath } from '../persistence/paths'
import { childEnv, prependPath } from '../subprocess-env'
import { forgetTerminalSecrets, hasSecrets, maskForTerminal } from '../vault/masking'
import { scanAgentStatus } from './agent-status'

/**
 * node-pty é módulo nativo. Carregado sob demanda, por duas razões:
 *   • o app ainda sobe (sem terminais) se o rebuild nativo tiver falhado
 *   • `import()` dinâmico resolve tanto no bundle CJS de produção quanto no
 *     dev server do electron-vite — `createRequire(import.meta.url)` NÃO:
 *     em dev o __filename do módulo não fica na árvore de node_modules do
 *     projeto e a resolução falha com MODULE_NOT_FOUND.
 */
let ptyModule: typeof import('node-pty') | null = null
let ptyLoadError: string | null = null

async function loadPty(): Promise<typeof import('node-pty') | null> {
  if (ptyModule) return ptyModule
  if (ptyLoadError) return null
  try {
    // Interop CJS: `import()` de um pacote CommonJS entrega o module.exports em
    // `default`. Sem este fallback, `pty.spawn` sai undefined.
    const mod = (await import('node-pty')) as unknown as {
      default?: typeof import('node-pty')
    } & typeof import('node-pty')
    ptyModule = mod.default ?? mod
    if (typeof ptyModule?.spawn !== 'function') {
      throw new Error('módulo carregou mas não expõe spawn()')
    }
    return ptyModule
  } catch (err) {
    ptyLoadError = (err as Error).message
    log.error('terminal', `node-pty não carregou: ${ptyLoadError}`)
    return null
  }
}

/** Motivo da última falha de carga, para a UI mostrar algo acionável. */
export function ptyUnavailableReason(): string | null {
  return ptyLoadError
}

const SCROLLBACK_LIMIT = 200_000 // caracteres mantidos em memória por terminal
/** Trecho final do buffer varrido atrás da linha de status do agente. */
const STATUS_WINDOW = 8_000
/** Varredura no máximo a cada 500ms: um agente falante emite dezenas de chunks/s. */
const STATUS_SCAN_INTERVAL = 500

export interface TerminalSession {
  id: UUID
  workspaceId: UUID
  pty: IPty
  agentType: string
  agentName: string
  /** Responsabilidade atribuída no momento do spawn — base do `atelier role`. */
  roleId: UUID | null
  command: string
  /** Buffer em memória para `atelier check` e para reidratar o xterm na UI. */
  buffer: string
  lastOutputAt: number
  lastActiveAt: number
  exited: boolean
  /** O que o agente mostra na própria linha de status. */
  status: AgentStatus
  lastStatusScan: number
}

class TerminalManager extends EventEmitter {
  private sessions = new Map<UUID, TerminalSession>()
  private serverPort = 0

  setServerPort(port: number): void {
    this.serverPort = port
  }

  get all(): TerminalSession[] {
    return [...this.sessions.values()]
  }

  get(id: UUID): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  /** Ambiente do PTY. A montagem é a função pura abaixo. */
  private buildEnv(
    terminalId: UUID,
    role?: { id: UUID; name: string } | null,
    extraEnv?: Record<string, string>,
    claudeConfigDir?: string
  ): NodeJS.ProcessEnv {
    return buildTerminalEnv({
      terminalId,
      serverPort: this.serverPort,
      role,
      extraEnv,
      claudeConfigDir
    })
  }

  async spawn(opts: TerminalSpawnOptions): Promise<TerminalSession | null> {
    const existing = this.sessions.get(opts.nodeId)
    if (existing && !existing.exited) return existing

    const pty = await loadPty()
    if (!pty) return null

    const shell = opts.shellPath || defaultShell()
    const cwd =
      opts.workingDirectory || process.env.HOME || process.env.USERPROFILE || process.cwd()

    let proc: IPty
    try {
      proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd,
        env: this.buildEnv(
          opts.nodeId,
          opts.role,
          opts.extraEnv,
          opts.claudeConfigDir
        ) as Record<string, string>
      })
    } catch (err) {
      ptyLoadError = `falha ao abrir PTY (${shell}): ${(err as Error).message}`
      log.error('terminal', ptyLoadError)
      return null
    }

    const session: TerminalSession = {
      id: opts.nodeId,
      workspaceId: opts.workspaceId,
      pty: proc,
      agentType: 'generic_shell',
      agentName: '',
      roleId: opts.role?.id ?? null,
      command: opts.command ?? '',
      buffer: '',
      lastOutputAt: Date.now(),
      lastActiveAt: 0,
      exited: false,
      status: { tokens: null, contextPct: null, limits: [] },
      lastStatusScan: 0
    }

    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-SCROLLBACK_LIMIT)
      session.lastOutputAt = Date.now()
      this.emit('data', session.id, data)
      this.scanStatus(session)
      // O que vai para o DISCO passa pela máscara; o que vai para a tela, não.
      // O usuário está olhando o próprio terminal e pediu aquele valor — quem
      // não deve ficar com ele em claro é o arquivo, que sobrevive à sessão e é
      // lido depois por quem reabrir o workspace. `hasSecrets` evita varrer
      // cada chunk quando nenhum segredo foi revelado a este terminal, que é o
      // caso comum.
      const chunk = hasSecrets(session.id) ? maskForTerminal(session.id, data) : data
      void persistence
        .appendScrollback(session.workspaceId, session.id, chunk)
        .catch(() => undefined)
    })

    proc.onExit(({ exitCode }) => {
      session.exited = true
      forgetTerminalSecrets(session.id)
      log.info('terminal', `PTY ${session.id.slice(0, 8)} saiu (código ${exitCode})`)
      this.emit('exit', session.id, exitCode)
    })

    this.sessions.set(session.id, session)
    log.info('terminal', `PTY ${session.id.slice(0, 8)} iniciado (${shell} em ${cwd})`)

    // Comando inicial do agente (claude, codex, …)
    if (opts.command) {
      setTimeout(() => this.write(session.id, `${opts.command}\r`), 300)
    }
    return session
  }

  /**
   * Lê a linha de status do agente e avisa quando algum número muda.
   *
   * Varre a cauda do buffer, não o chunk: a linha costuma vir partida entre
   * pacotes do PTY, e os números ficariam invisíveis pela metade. Campo que
   * some da tela não apaga o valor anterior — o agente redesenha a linha em
   * pedaços, e apagar a cada frame faria o rodapé piscar.
   */
  private scanStatus(session: TerminalSession): void {
    const now = Date.now()
    if (now - session.lastStatusScan < STATUS_SCAN_INTERVAL) return
    session.lastStatusScan = now

    const fresh = scanAgentStatus(session.buffer.slice(-STATUS_WINDOW))
    const next: AgentStatus = {
      tokens: fresh.tokens ?? session.status.tokens,
      contextPct: fresh.contextPct ?? session.status.contextPct,
      limits: fresh.limits.length > 0 ? fresh.limits : session.status.limits
    }
    if (JSON.stringify(next) === JSON.stringify(session.status)) return
    session.status = next
    this.emit('status', session.id, next)
  }

  /**
   * Devolve `false` quando não havia PTY vivo para receber. Quem escreve por
   * conta do usuário (colar um caminho, por exemplo) precisa saber disso: sem
   * o retorno, um terminal ainda não iniciado engoliria o texto em silêncio e
   * o clique pareceria não ter feito nada.
   */
  write(id: UUID, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.exited) return false
    session.pty.write(data)
    return true
  }

  resize(id: UUID, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session || session.exited) return
    try {
      session.pty.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      /* PTY pode ter morrido entre a checagem e o resize */
    }
  }

  kill(id: UUID): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty.kill()
    } catch {
      /* já morto */
    }
    this.sessions.delete(id)
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /** Metadados que o `atelier list` mostra. */
  setAgentInfo(id: UUID, info: { agentType?: string; agentName?: string }): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (info.agentType) session.agentType = info.agentType
    if (info.agentName) session.agentName = info.agentName
  }

  markActiveTask(id: UUID): void {
    const session = this.sessions.get(id)
    if (session) session.lastActiveAt = Date.now()
  }

  /** Últimas N linhas do buffer (base do `atelier check`). */
  tail(id: UUID, lines: number): string {
    const session = this.sessions.get(id)
    if (!session) return ''
    return stripAnsi(session.buffer).split('\n').slice(-lines).join('\n')
  }

  /** Está ocioso? Sem saída nova há agentIdleTimeoutMs. */
  isIdle(id: UUID): boolean {
    const session = this.sessions.get(id)
    if (!session) return true
    return Date.now() - session.lastOutputAt > Constants.agentIdleTimeoutMs
  }
}

/**
 * Ambiente injetado no PTY — o contrato que faz o `atelier` funcionar dentro do
 * terminal (espelha SwiftTermProvider.swift:116-134).
 *
 * Função à parte do TerminalManager porque a ORDEM aqui é uma regra de
 * segurança, não arrumação: tudo que o Atelier define entra antes das variáveis
 * dos cofres, e o laço no fim recusa qualquer chave que já exista. É isso que
 * impede um cofre de redefinir `ATELIER_SOCKET` (e sequestrar o canal do CLI) ou
 * `CLAUDE_CONFIG_DIR` (e rodar o agente logado como outra conta). Testável sem
 * node-pty — ver scripts/test-claude-accounts.mjs.
 */
export function buildTerminalEnv(params: {
  terminalId: UUID
  serverPort: number
  role?: { id: UUID; name: string } | null
  extraEnv?: Record<string, string>
  /** Ausente = a conta padrão: a variável NÃO é definida, e o `claude` usa ~/.claude. */
  claudeConfigDir?: string
}): NodeJS.ProcessEnv {
  const env = childEnv()
  env.ATELIER_TERMINAL_ID = params.terminalId
  env.ATELIER_SOCKET = ipcSocketPath()
  env.ATELIER_SERVER_PORT = String(params.serverPort)
  env.TERM = 'xterm-256color'

  // Responsabilidade atribuída: o nome fica no ambiente para prompts e
  // scripts; o texto inteiro sai em `atelier role`, que lê do RoleStore.
  if (params.role) {
    env.ATELIER_ROLE_ID = params.role.id
    env.ATELIER_ROLE = params.role.name
  }

  if (params.claudeConfigDir) env.CLAUDE_CONFIG_DIR = params.claudeConfigDir

  const bin = atelierBinDir()
  env.ATELIER_CLI = bin.cliPath
  // O bin do Atelier entra na frente; o PATH herdado (onde mora `claude`,
  // `codex`, `npm`…) continua inteiro graças ao `childEnv` acima.
  prependPath(env, bin.dir)

  // Os cofres por último, mas SEM poder pisar no que veio antes.
  if (params.extraEnv) {
    for (const [key, value] of Object.entries(params.extraEnv)) {
      if (key in env) {
        log.warn('vault', `chave '${key}' ignorada: já existe no ambiente do PTY`)
        continue
      }
      env[key] = value
    }
  }
  return env
}

/** Remove sequências ANSI para que a saída do CLI seja texto limpo. */
export function stripAnsi(input: string): string {
  const csi = new RegExp('\\x1b\\[[0-9;?]*[ -/]*[@-~]', 'g')
  const osc = new RegExp('\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', 'g')
  const single = new RegExp('\\x1b[@-Z\\\\-_]', 'g')
  return input.replace(osc, '').replace(csi, '').replace(single, '')
}

export const terminals = new TerminalManager()
