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
import type { TerminalSpawnOptions, UUID } from '@shared/types'
import { Constants } from '../constants'
import { log } from '../logger'
import { defaultShell } from '../models/node-content'
import { atelierBinDir } from '../interagent/cli-install'
import { persistence } from '../persistence/persistence-manager'
import { ipcSocketPath } from '../persistence/paths'

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

  /**
   * Ambiente injetado no PTY — é o contrato que faz o `atelier` funcionar
   * dentro do terminal (espelha SwiftTermProvider.swift:116-134).
   */
  private buildEnv(terminalId: UUID, role?: { id: UUID; name: string } | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    env.ATELIER_TERMINAL_ID = terminalId
    env.ATELIER_SOCKET = ipcSocketPath()
    env.ATELIER_SERVER_PORT = String(this.serverPort)
    env.TERM = 'xterm-256color'

    // Responsabilidade atribuída: o nome fica no ambiente para prompts e
    // scripts; o texto inteiro sai em `atelier role`, que lê do RoleStore.
    if (role) {
      env.ATELIER_ROLE_ID = role.id
      env.ATELIER_ROLE = role.name
    }

    const bin = atelierBinDir()
    const sep = process.platform === 'win32' ? ';' : ':'
    env.ATELIER_CLI = bin.cliPath
    env.PATH = [bin.dir, env.PATH ?? ''].filter(Boolean).join(sep)
    return env
  }

  async spawn(opts: TerminalSpawnOptions): Promise<TerminalSession | null> {
    const existing = this.sessions.get(opts.nodeId)
    if (existing && !existing.exited) return existing

    const pty = await loadPty()
    if (!pty) return null

    const shell = opts.shellPath || defaultShell()
    const cwd = opts.workingDirectory || process.env.HOME || process.cwd()

    let proc: IPty
    try {
      proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd,
        env: this.buildEnv(opts.nodeId, opts.role) as Record<string, string>
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
      exited: false
    }

    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-SCROLLBACK_LIMIT)
      session.lastOutputAt = Date.now()
      this.emit('data', session.id, data)
      void persistence.appendScrollback(session.workspaceId, session.id, data).catch(() => undefined)
    })

    proc.onExit(({ exitCode }) => {
      session.exited = true
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

  write(id: UUID, data: string): void {
    const session = this.sessions.get(id)
    if (!session || session.exited) return
    session.pty.write(data)
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

/** Remove sequências ANSI para que a saída do CLI seja texto limpo. */
export function stripAnsi(input: string): string {
  const csi = new RegExp('\\x1b\\[[0-9;?]*[ -/]*[@-~]', 'g')
  const osc = new RegExp('\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', 'g')
  const single = new RegExp('\\x1b[@-Z\\\\-_]', 'g')
  return input.replace(osc, '').replace(csi, '').replace(single, '')
}

export const terminals = new TerminalManager()
