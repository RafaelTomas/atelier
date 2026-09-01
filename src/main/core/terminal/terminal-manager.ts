/**
 * Porte de Sources/Terminal/ (SwiftTermProvider + TerminalManager).
 *
 * Mantém os PTYs vivos FORA da árvore de UI — trocar de workspace no renderer
 * destrói as views, mas os processos continuam, igual ao app nativo.
 *
 * SwiftTerm → node-pty (ConPTY no Windows, forkpty no resto).
 */
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import type { AgentStatus, TerminalSpawnOptions, UUID } from '@shared/types'
import { Constants } from '../constants'
import { log } from '../logger'
import { defaultShell } from '../models/node-content'
import { atelierBinDir } from '../interagent/cli-install'
import { handleBrief } from '../interagent/handlers/brief'
import { persistence } from '../persistence/persistence-manager'
import { dataDir, ipcSocketPath } from '../persistence/paths'
import { childEnv, prependPath } from '../subprocess-env'
import { forgetTerminalSecrets, hasSecrets, maskForTerminal } from '../vault/masking'
import { uuid } from '../coding'
import { scanAgentStatus } from './agent-status'
import { bootArgs } from './boot-command'
import { SpawnRegistry } from './spawn-registry'
import { RESUME_SUPPORT, supportsResume, withSession } from './agent-resume'
import {
  clearSession,
  readSession,
  sessionIsUsable,
  transcriptState,
  writeSession
} from './session-store'
import { withAgentSettings } from './agent-settings'
import { forgetUsage } from './status-line'

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

/**
 * Um agente que morre antes disto, com código de erro, morreu na LARGADA — CLI
 * velho que não conhece `--session-id`, ou sessão que não existe mais porque o
 * `~/.claude` foi limpo. Aí o Atelier sobe de novo, sem as flags de sessão.
 *
 * Detectar por saída precoce, e não checando antes, é deliberado: checar
 * exigiria ler o diretório de sessões de OUTRO app — exatamente o que a decisão
 * de gerar o id nós mesmos existe para evitar.
 */
const EARLY_EXIT_MS = 3000

/**
 * Por quanto tempo, depois de um `--resume`, a tela é vigiada atrás da recusa do
 * agente.
 *
 * A saída precoce do PTY (acima) NÃO cobre este caso, e é o caso comum: o PTY é
 * o SHELL, e o comando do agente é digitado dentro dele. Quando o
 * `claude --resume` falha, quem sai com código de erro é o `claude`; o `cmd.exe`
 * continua vivo, `onExit` nunca dispara, e o nó fica com o erro vermelho e um
 * prompt pelado — sem agente e sem ninguém para reagir. Por isso a segunda
 * rede é a TELA.
 *
 * A janela é curta e vale só quando este boot pediu retomada: assim a frase não
 * é confundida com um agente que, mais tarde, esteja apenas FALANDO sobre ela.
 */
const RESUME_WATCH_MS = 20_000
/** Cauda da tela varrida atrás da recusa. Cabe a mensagem quebrada em linhas. */
const RESUME_WINDOW = 2_000

/** O diretório do nó. Uma regra só: o spawn e a recuperação usam a MESMA. */
function resolveCwd(opts: TerminalSpawnOptions): string {
  return opts.workingDirectory || process.env.HOME || process.env.USERPROFILE || process.cwd()
}

/**
 * Onde mora o brief renderizado deste terminal. Mesma pasta do `--settings` —
 * ela já deixou de ser só a barra de status, ver o cabeçalho de
 * terminal/agent-settings.ts.
 *
 * Exportada porque `handlers/list.ts` precisa do MESMO caminho para citá-lo no
 * cabeçalho: `ATELIER_BRIEF` é uma variável do ambiente do PTY, e o processo
 * main que responde `list` não herda o ambiente do filho — recalcular pela
 * mesma fórmula é o único jeito de main e PTY concordarem sem passar o valor
 * por um canal a mais.
 */
export function briefFilePath(terminalId: UUID): string {
  return join(dataDir(), 'agent-settings', `${terminalId}.brief.txt`)
}

/**
 * Grava o brief em texto puro e devolve o caminho — o canal universal do M1b
 * do plano de aderência (docs/2026-09-01-PLANO-aderencia-dos-agentes.md).
 *
 * `handleBrief` é a MESMA função que atende `atelier brief` pelo socket: o
 * texto aqui é idêntico ao que este nó receberia perguntando pelo CLI, só que
 * já em disco quando o agente sobe — todo preset sabe ler um arquivo, nenhum é
 * obrigado a ter hook de `SessionStart` (Claude Code é o único que tem).
 *
 * `null` na falha, e o boot segue sem `ATELIER_BRIEF`: um brief que não pôde
 * ser escrito não pode ser motivo para o PTY não subir.
 */
async function writeBriefFile(terminalId: UUID): Promise<string | null> {
  const path = briefFilePath(terminalId)
  try {
    await mkdir(join(dataDir(), 'agent-settings'), { recursive: true })
    await writeFile(path, handleBrief(['brief'], terminalId), 'utf8')
    return path
  } catch {
    return null
  }
}

export interface TerminalSession {
  id: UUID
  workspaceId: UUID
  pty: IPty
  agentType: string
  agentName: string
  /** Responsabilidade atribuída no momento do spawn — base do `atelier role`. */
  roleId: UUID | null
  /** A linha com que este PTY subiu, flags de sessão incluídas. */
  command: string
  /** Buffer em memória para `atelier check` e para reidratar o xterm na UI. */
  buffer: string
  lastOutputAt: number
  lastActiveAt: number
  exited: boolean
  /** O que o agente mostra na própria linha de status. */
  status: AgentStatus
  lastStatusScan: number
  /** Id da sessão do agente, quando o preset sabe retomar. */
  sessionId: UUID | null
  /** Este boot pediu `--resume`? Decide o que fazer numa saída precoce. */
  resumed: boolean
  startedAt: number
  /**
   * Já caímos para sessão limpa neste nó. Uma vez só: se o agente morrer de novo
   * na largada, o problema não é a flag de sessão, e reiniciar em laço seria
   * pior que deixar o erro à vista na tela do nó.
   */
  retriedClean: boolean
}

class TerminalManager extends EventEmitter {
  private sessions = new Map<UUID, TerminalSession>()
  /** Aberturas em voo, por nó. Ver spawn-registry.ts. */
  private inFlight = new SpawnRegistry<TerminalSession | null>()
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
    claudeConfigDir?: string,
    innerStatusLine?: string | null,
    isArtisan?: boolean,
    briefPath?: string | null
  ): NodeJS.ProcessEnv {
    return buildTerminalEnv({
      terminalId,
      serverPort: this.serverPort,
      role,
      extraEnv,
      claudeConfigDir,
      innerStatusLine,
      isArtisan,
      briefPath
    })
  }

  /**
   * Um nó, um PTY.
   *
   * A reserva por nodeId é SÍNCRONA e vem antes de tudo: `doSpawn()` tem três
   * `await` antes de registrar a sessão no mapa, e a guarda antiga — ler o mapa
   * aqui, escrever nele lá — deixava essa janela inteira aberta. Duas chamadas
   * passavam pelas duas, e o nó ganhava dois PTYs e dois ids de sessão.
   *
   * A correção mora aqui, e não no renderer que chama duas vezes, porque
   * `spawn()` é IPC: o menu do nó, uma rotina, um segundo painel do mesmo nó
   * reabririam o mesmo defeito. Quem é dono do recurso é quem protege.
   */
  async spawn(opts: TerminalSpawnOptions): Promise<TerminalSession | null> {
    const existing = this.sessions.get(opts.nodeId)
    if (existing && !existing.exited) return existing
    return this.inFlight.run(opts.nodeId, () => this.doSpawn(opts))
  }

  private async doSpawn(opts: TerminalSpawnOptions): Promise<TerminalSession | null> {
    const pty = await loadPty()
    if (!pty) return null

    const shell = opts.shellPath || defaultShell()
    const cwd = resolveCwd(opts)

    // O `settings.json` do agente entra ANTES do spawn: o `--settings` vai no
    // comando que será digitado, e a statusLine que o usuário já tinha vai no
    // ambiente, para o CLI encadeá-la. É o mesmo arquivo que leva os hooks do
    // Artesão. Num preset que não é Claude Code tudo volta intacto — ver
    // terminal/agent-settings.ts.
    const agent = await withAgentSettings(opts.command ?? '', opts.nodeId, {
      claudeConfigDir: opts.claudeConfigDir,
      artisan: opts.isArtisan === true
    })

    // O brief, pelo mesmo motivo do settings: precisa estar em disco ANTES do
    // spawn para o ambiente do PTY já nascer com `ATELIER_BRIEF` apontando
    // para ele. O nó já existe no workspace neste ponto (quem chama
    // `terminals.spawn` garante isso — ver ipc/bridge.ts), então
    // `connectedNodes` enxerga os cabos certos.
    const briefPath = await writeBriefFile(opts.nodeId)

    // A sessão do agente, pelo mesmo motivo: as flags entram no comando ANTES
    // de ele ser digitado. Ver terminal/agent-resume.ts e session-store.ts.
    const plan = await this.planSession(opts, cwd, agent.command)

    let proc: IPty
    try {
      proc = pty.spawn(shell, bootArgs(shell, plan.command), {
        name: 'xterm-256color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd,
        env: this.buildEnv(
          opts.nodeId,
          opts.role,
          opts.extraEnv,
          opts.claudeConfigDir,
          agent.innerCommand,
          opts.isArtisan === true,
          briefPath
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
      command: plan.command,
      buffer: '',
      lastOutputAt: Date.now(),
      lastActiveAt: 0,
      exited: false,
      status: { tokens: null, contextPct: null, limits: [] },
      lastStatusScan: 0,
      sessionId: plan.sessionId,
      resumed: plan.mode === 'resume',
      startedAt: Date.now(),
      retriedClean: false
    }

    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-SCROLLBACK_LIMIT)
      session.lastOutputAt = Date.now()
      this.emit('data', session.id, data)
      this.scanStatus(session)
      this.watchResumeFailure(session, opts)
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

      // Morreu na LARGADA depois de pedir sessão? A flag é a suspeita: CLI velho
      // que não conhece `--session-id`, ou sessão que não existe mais porque o
      // `~/.claude` foi limpo. Sobe de novo, limpo, uma única vez — insistir em
      // laço esconderia um erro real atrás de reinícios.
      const cedo = Date.now() - session.startedAt < EARLY_EXIT_MS
      if (cedo && exitCode !== 0 && session.sessionId && !session.retriedClean) {
        session.retriedClean = true
        const motivo = session.resumed
          ? 'a sessao anterior nao foi encontrada'
          : 'este agente nao aceita --session-id'
        void this.recoverClean(session, opts, motivo)
        return
      }

      // A leitura publicada era daquela SESSÃO: mantê-la faria o painel mostrar
      // o custo e o contexto de um agente que já morreu.
      forgetUsage(session.id)
      log.info('terminal', `PTY ${session.id.slice(0, 8)} saiu (código ${exitCode})`)
      this.emit('exit', session.id, exitCode)
    })

    this.sessions.set(session.id, session)
    log.info('terminal', `PTY ${session.id.slice(0, 8)} iniciado (${shell} em ${cwd})`)

    // O comando do agente já subiu COM o shell (ver boot-command.ts). O que
    // resta é o eco: a linha some do stdin, mas continua visível — é assim que
    // o usuário descobre com que comando o nó subiu. Pelo canal do Atelier,
    // que escreve na TELA e não na entrada de ninguém.
    if (plan.command) this.announce(session.id, plan.command)

    // O id só é gravado agora, com o PTY de pé e o comando entregue. Gravar
    // antes foi o que deixou o `session.json` com o id de um agente que nunca
    // subiu — e o boot seguinte pedindo `--resume` de uma conversa que não
    // existe.
    //
    // `plan.persist` cobre a sessão nova e a retomada ESCOLHIDA no diálogo (que
    // precisa virar a sessão do nó para os boots seguintes acharem pelo caminho
    // normal); a retomada da sessão já gravada não reescreve nada.
    if (plan.sessionId && plan.persist) {
      await writeSession(opts.workspaceId, opts.nodeId, {
        agentType: opts.agentType ?? '',
        sessionId: plan.sessionId,
        cwd,
        startedAt: plan.startedAt
      })
    }

    // Retomada NUNCA é silenciosa: o agente responderia com um contexto que o
    // usuário não sabe que existe. A linha vai pelo mesmo canal do aviso do
    // `atelier` — a tela do nó —, e nunca pelo stdin do agente.
    if (plan.mode === 'resume') {
      const quando = plan.startedAt ? ` de ${plan.startedAt.slice(0, 16).replace('T', ' ')}` : ''
      this.announce(session.id, `sessao retomada ${plan.sessionId?.slice(0, 8)}${quando}`)
    }
    return session
  }

  /**
   * Uma linha do Atelier na tela do nó — nunca no stdin do agente.
   *
   * Mesmo canal do aviso do `atelier`: o texto vai para o xterm e para o
   * scrollback, e o agente não o recebe como entrada. Escrever no stdin faria o
   * Atelier "digitar" no lugar do usuário.
   */
  private announce(id: UUID, text: string): void {
    const line = `\r\n\x1b[2m[atelier] ${text}\x1b[0m\r\n`
    this.emit('data', id, line)
    const session = this.sessions.get(id)
    if (session) session.buffer = (session.buffer + line).slice(-SCROLLBACK_LIMIT)
  }

  /**
   * Decide, ANTES do spawn, se o comando leva flags de sessão e quais.
   *
   * Devolve o comando já montado. Um `agentType` sem entrada na tabela de
   * retomada sai daqui com o comando intacto e `sessionId: null` — e aí nada
   * mais acontece: nem arquivo gravado, nem ação de retomar no menu.
   */
  private async planSession(
    opts: TerminalSpawnOptions,
    cwd: string,
    baseCommand: string
  ): Promise<{
    command: string
    sessionId: UUID | null
    mode: 'none' | 'new' | 'resume'
    startedAt: string
    /** Gravar este id como a sessão do nó? Sim para sessão nova e para a
     *  retomada escolhida no diálogo; não para a retomada da sessão que já
     *  estava gravada — reescrevê-la só perderia o `startedAt` original. */
    persist: boolean
  }> {
    // O comando que chega aqui é o do agente JÁ com o `--settings` da
    // statusLine. Montar as flags de sessão a partir de `opts.command` cru
    // descartaria aquele argumento em silêncio, e o monitor do nó ficaria vazio.
    const command = baseCommand
    const agentType = opts.agentType ?? ''
    const mode = opts.sessionMode ?? 'auto'

    if (!command.trim() || !supportsResume(agentType)) {
      return { command, sessionId: null, mode: 'none', startedAt: '', persist: false }
    }

    // "Sessão nova" é o gesto de DESISTIR do estado atual: apaga o id gravado
    // em vez de guardá-lo para depois, senão o boot seguinte ressuscitaria a
    // conversa que o usuário acabou de descartar.
    if (mode === 'clean') {
      await clearSession(opts.workspaceId, opts.nodeId)
    }

    const saved =
      mode === 'clean' ? null : await readSession(opts.workspaceId, opts.nodeId)

    // Uma sessão escolhida à mão no diálogo ("Retomar sessão"). Vem ANTES da
    // sessão gravada do nó: quem acabou de escolher uma no diálogo de edição
    // quer aquela, não a que o `--resume` automático pegaria. Vale uma vez —
    // `spawn` a grava como a sessão do nó e o `bridge` zera o campo do conteúdo.
    const escolhida = opts.resumeSessionId
    if (mode !== 'clean' && escolhida && escolhida !== saved?.sessionId) {
      const loc = RESUME_SUPPORT[agentType].transcript(
        opts.claudeConfigDir || join(homedir(), '.claude'),
        cwd,
        escolhida
      )
      // 'no' — pasta do projeto existe e o arquivo não — é a única resposta que
      // descarta. 'unknown' (regra de nome de outro app) retoma, como no resto
      // do módulo: a queda, se vier, é apanhada na tela pelo guarda de recusa.
      if ((await transcriptState(loc)) !== 'no') {
        return {
          command: withSession(command, agentType, escolhida, 'resume', RESUME_SUPPORT),
          sessionId: escolhida,
          mode: 'resume',
          startedAt: '',
          persist: true
        }
      }
    }

    const utilizavel =
      sessionIsUsable(saved, agentType, cwd, supportsResume) &&
      (await this.hasTranscript(saved, opts))

    if (utilizavel && saved) {
      return {
        command: withSession(command, agentType, saved.sessionId, 'resume', RESUME_SUPPORT),
        sessionId: saved.sessionId,
        mode: 'resume',
        startedAt: saved.startedAt,
        persist: false
      }
    }

    // Nada utilizável: gera o id e o ENTREGA ao agente. O Atelier sabe o id
    // antes de o agente existir, e sabe de quem ele é — é o ponto inteiro da
    // decisão (ver agent-resume.ts).
    const sessionId = uuid()
    const startedAt = new Date().toISOString()
    return {
      command: withSession(command, agentType, sessionId, 'new', RESUME_SUPPORT),
      sessionId,
      mode: 'new',
      startedAt,
      persist: true
    }
  }

  /**
   * Vale a pena pedir `--resume` deste id?
   *
   * `--session-id` só RESERVA o id: o Claude Code grava a transcrição na
   * primeira mensagem. Um nó aberto e nunca usado tinha id gravado e nenhuma
   * conversa — e voltava do restart com "No conversation found with session ID".
   * Aqui isso vira, de graça, uma sessão nova.
   *
   * A dúvida ('unknown') retoma: a pasta é de outro app, e uma regra de nome
   * errada não pode desligar a retomada de quem tem conversa de verdade.
   */
  private async hasTranscript(
    saved: { sessionId: UUID; cwd: string },
    opts: TerminalSpawnOptions
  ): Promise<boolean> {
    const entry = RESUME_SUPPORT[opts.agentType ?? '']
    if (!entry) return false
    const configDir = opts.claudeConfigDir || join(homedir(), '.claude')
    const cwd = saved.cwd || resolveCwd(opts)
    if (!cwd) return true
    const estado = await transcriptState(entry.transcript(configDir, cwd, saved.sessionId))
    if (estado === 'no') {
      log.info(
        'terminal',
        `sessao ${saved.sessionId.slice(0, 8)} sem transcricao em disco — subindo limpo`
      )
      await clearSession(opts.workspaceId, opts.nodeId)
      return false
    }
    return true
  }

  /**
   * A retomada foi recusada NA TELA: sobe um PTY novo, limpo.
   *
   * Antes daqui saía uma DIGITAÇÃO no stdin, apostando que o agente tinha
   * morrido e deixado um prompt de shell para trás. Quando ele não morre — um
   * Claude Code que recusa o `--resume` e mesmo assim abre uma sessão nova — a
   * linha ia parar dentro do prompt do próprio agente, exatamente o defeito que
   * a entrega por argumento existe para matar.
   *
   * Sem aposta: o que estiver no PTY morre, e o mecanismo passa a ser o mesmo do
   * `recoverClean()` — um só, em vez de dois.
   */
  private async recoverResume(session: TerminalSession, opts: TerminalSpawnOptions): Promise<void> {
    await this.settled(opts.nodeId)
    await clearSession(opts.workspaceId, opts.nodeId)
    this.announce(session.id, 'a sessao anterior nao foi encontrada — subindo uma sessao nova')

    // `retriedClean` já está marcado por quem chamou: o `onExit` deste kill não
    // volta para o caminho de recuperação.
    try {
      session.pty.kill()
    } catch {
      /* já morto */
    }
    session.exited = true
    this.sessions.delete(opts.nodeId)

    const fresh = await this.spawn({ ...opts, sessionMode: 'clean' })
    if (!fresh) {
      this.emit('exit', session.id, 1)
      return
    }
    fresh.retriedClean = true
  }

  /**
   * Espera a abertura deste nó assentar, quando ainda há uma em voo.
   *
   * O `onData`/`onExit` do PTY podem disparar ANTES de `doSpawn()` registrar a
   * sessão no mapa. Uma recuperação que apagasse o registro nessa janela seria
   * desfeita logo depois pelo `sessions.set` da abertura — e o nó ficaria com
   * uma sessão morta no mapa e outra viva sem ninguém apontando para ela.
   */
  private async settled(nodeId: UUID): Promise<void> {
    await this.inFlight.pending(nodeId)?.catch(() => undefined)
  }

  /**
   * Segunda rede da retomada: a frase de recusa na tela do nó.
   *
   * Só olha quando ESTE boot pediu `--resume`, dentro da janela inicial e uma
   * única vez — um agente que mais tarde escreva a mesma frase (falando sobre
   * ela, como neste próprio repositório) não derruba a sessão de ninguém.
   */
  private watchResumeFailure(session: TerminalSession, opts: TerminalSpawnOptions): void {
    if (!session.resumed || session.retriedClean) return
    if (Date.now() - session.startedAt > RESUME_WATCH_MS) {
      session.resumed = false
      return
    }
    const entry = RESUME_SUPPORT[opts.agentType ?? '']
    if (!entry?.resumeFailed(stripAnsi(session.buffer.slice(-RESUME_WINDOW)))) return

    session.retriedClean = true
    session.resumed = false
    void this.recoverResume(session, opts)
  }

  /**
   * O agente morreu na largada por causa da flag de sessão: sobe outro, limpo.
   *
   * O id gravado é apagado antes, senão o boot novo tentaria retomá-lo de novo e
   * cairia no mesmo lugar.
   */
  private async recoverClean(
    session: TerminalSession,
    opts: TerminalSpawnOptions,
    motivo: string
  ): Promise<void> {
    await this.settled(opts.nodeId)
    await clearSession(opts.workspaceId, opts.nodeId)
    this.sessions.delete(opts.nodeId)
    this.announce(opts.nodeId, `${motivo} — subindo uma sessao nova`)
    const fresh = await this.spawn({ ...opts, sessionMode: 'clean' })
    if (!fresh) {
      this.emit('exit', session.id, 1)
      return
    }
    // O nó não fica marcado como "sem retomada" para sempre: o id novo é gravado
    // no spawn limpo, e o boot seguinte volta a tentar `--resume`. O que não se
    // repete é a queda em laço DENTRO deste boot (`retriedClean`).
    fresh.retriedClean = true
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
  /**
   * A `statusLine` que o usuário já tinha configurada, quando tinha. Vira
   * `ATELIER_STATUSLINE_INNER`, e o CLI a executa com o mesmo stdin: a barra de
   * status do agente continua exatamente a que ele montou. Ver
   * terminal/agent-settings.ts.
   */
  innerStatusLine?: string | null
  /**
   * Nó marcado como Artesão. Vira `ATELIER_ARTESAO=1`, e é o sinal UNIVERSAL:
   * o bloqueio por hook é do Claude Code, mas a variável existe em qualquer
   * preset, e é por ela que o `atelier list` sabe abrir com o cabeçalho do
   * Artesão para um Codex que nunca verá um `SessionStart`.
   */
  isArtisan?: boolean
  /**
   * Caminho do brief já renderizado deste terminal, ou `null` se a gravação
   * falhou. Vira `ATELIER_BRIEF` — o canal universal do M1a/M1b do plano de
   * aderência: Claude Code recebe o mesmo conteúdo pelo hook `SessionStart`
   * (`atelier brief`), mas Codex, opencode, antigravity e o shell puro não têm
   * hook nenhum, e é por isso que o arquivo existe — todo preset sabe ler um.
   */
  briefPath?: string | null
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

  if (params.isArtisan) env.ATELIER_ARTESAO = '1'
  if (params.briefPath) env.ATELIER_BRIEF = params.briefPath

  if (params.claudeConfigDir) env.CLAUDE_CONFIG_DIR = params.claudeConfigDir
  if (params.innerStatusLine) env.ATELIER_STATUSLINE_INNER = params.innerStatusLine

  const bin = atelierBinDir()
  env.ATELIER_CLI = bin.cliPath
  // O DIRETÓRIO, não o arquivo. Prepender o bin aqui não basta: `bootArgs` sobe
  // o PTY com `-i`, o shell carrega o profile do usuário, e um profile que faz
  // `export PATH=<lista absoluta>` — o desta máquina faz — apaga o que
  // prependamos. Quem repõe é o próprio comando de boot, depois do profile ter
  // rodado, e para isso ele precisa do diretório no ambiente. Ver boot-command.ts.
  env.ATELIER_BIN = bin.dir
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
