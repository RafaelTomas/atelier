/**
 * O consumo do Codex lido de onde ele é ESCRITO: os rollouts no disco.
 *
 * Sondar o App Server era perguntar ao processo errado. O servidor que o
 * Atelier levanta é um leitor — ele nunca executa um turno, e por isso nunca
 * recebe as notificações de quem gasta. Quem gasta são os processos `codex` dos
 * nós do canvas, e cada um deles grava, a cada turno, um evento `token_count`
 * no rollout da sessão, com o bloco `rate_limits` inteiro: percentual usado,
 * janela, hora do reset, plano, créditos.
 *
 * É a publicação que o Codex parecia não ter. O comentário do painel de monitor
 * diz que o Claude anda sozinho porque PUBLICA pela `statusLine`, e que ao
 * Codex só sobrava a raspagem de tela; o rollout é o equivalente dele, e estava
 * no disco o tempo todo.
 *
 * O que se ganha ao ler daqui, e não do App Server:
 *
 *  - nenhum subprocesso e nenhuma requisição, então some junto o retry de
 *    `spawn` em máquina onde o `codex` não sobe;
 *  - o número anda no INSTANTE do turno, em vez de no próximo tique de um
 *    relógio;
 *  - enxerga também o `codex` que o usuário rodou fora do Atelier, porque todos
 *    escrevem no mesmo lugar.
 *
 * O custo, e é honesto declará-lo: isto acopla o Atelier a um formato interno
 * do Codex. Por isso tudo aqui é MELHOR-ESFORÇO — qualquer surpresa na forma do
 * arquivo devolve `null`, e quem chama continua tendo o App Server para o ↻ e
 * para o arranque frio. Nada aqui pode derrubar o monitor.
 */
import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../logger'
import { codexHome } from './codex-presence'

/** Só a cauda do arquivo é lida: rollout é append-only e cresce sem limite. */
const TAIL_BYTES = 64 * 1024

/**
 * Um turno grava vários eventos seguidos. Sem espera, um único turno dispararia
 * meia dúzia de leituras do mesmo arquivo para chegar ao mesmo número.
 */
const DEBOUNCE_MS = 400

/**
 * O relógio de parede e o agendador, num objeto só para o teste poder trocá-los.
 *
 * A virada precisa acontecer numa hora do CALENDÁRIO, não daqui a N
 * milissegundos fixos; e um teste que dependesse do `setTimeout` real teria que
 * esperar de verdade até a meia-noite. Isolar as duas primitivas aqui deixa o
 * teste controlar o tempo sem `sinon` nem mexer no relógio do processo.
 *
 * Isto é LOCAL a este arquivo de propósito. O nó de relógio do canvas tem o seu
 * próprio coordenador, no renderer, e o plano rejeita uni-los: seriam um serviço
 * entre processos, IPC de registro e política de shutdown para dois consumidores
 * com necessidades diferentes. Dois timeouts pequenos e independentes custam
 * menos. A única peça compartilhável é a disciplina de testar funções que
 * recebem `now` — e disciplina não pede infraestrutura.
 */
export interface RolloutClock {
  now(): number
  setTimer(fn: () => void, ms: number): NodeJS.Timeout
  clearTimer(t: NodeJS.Timeout): void
}

const wallClock: RolloutClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t)
}

/**
 * Quanto falta, em milissegundos, até a próxima meia-noite LOCAL.
 *
 * Não é "somar 24h ao instante atual": num dia de mudança de horário de verão o
 * relógio de parede anda 23h ou 25h entre uma meia-noite e a seguinte, e somar
 * 24h faria o nó de relógio disparar uma hora cedo (ou tarde) e, pior, acumular
 * essa hora a cada virada. `setHours(24, 0, 0, 0)` pede ao próprio calendário
 * local o instante "00:00 do dia seguinte" — o motor de datas resolve o salto —
 * e a diferença de timestamps devolve a duração REAL, seja ela qual for.
 */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime()
}

export interface RolloutReading {
  /** Pronto para `fromCodexRateLimits` — o mesmo formato que o App Server dá. */
  limits: unknown
  /** Pronto para `mergeCodexAccount`, já em camelCase. */
  account: unknown
  at: string
}

export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'sessions')
}

/** O maior nome de subdiretório — os rollouts moram em `sessions/AAAA/MM/DD`. */
async function newestChild(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    if (dirs.length === 0) return null
    // Ordem alfabética resolve porque os nomes são numéricos e preenchidos com
    // zero à esquerda. Nada de `Date` aqui: o disco já está ordenado.
    return dirs.sort().at(-1) ?? null
  } catch {
    return null
  }
}

/**
 * O diretório do dia mais recente. Descer por ano/mês/dia, e não varrer a
 * árvore, mantém isto em três `readdir` — a pasta de sessões de quem usa o
 * Codex todo dia tem centenas de arquivos.
 */
export async function newestDayDir(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const root = codexSessionsDir(env)
  const year = await newestChild(root)
  if (!year) return null
  const month = await newestChild(join(root, year))
  if (!month) return null
  const day = await newestChild(join(root, year, month))
  if (!day) return null
  return join(root, year, month, day)
}

/** O rollout escrito por último — o que tem a leitura mais fresca. */
async function newestRollout(dir: string): Promise<string | null> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
    let best: { path: string; mtime: number } | null = null
    for (const name of names) {
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (!best || info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs }
      } catch {
        // Arquivo sumiu entre o listar e o medir: só não concorre.
      }
    }
    return best?.path ?? null
  } catch {
    return null
  }
}

/** Lê os últimos `TAIL_BYTES` do arquivo. */
async function readTail(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * O último `token_count` com `rate_limits` da cauda, traduzido.
 *
 * Varre de trás para frente porque o que interessa é a leitura mais NOVA, e ela
 * é a última linha do arquivo. A primeira linha da cauda quase sempre está
 * cortada ao meio — o `JSON.parse` dela falha e é descartada em silêncio, que é
 * o comportamento correto e não um erro a registrar.
 */
export function parseRolloutTail(text: string): RolloutReading | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('token_count')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload = asRecord(event.payload)
    if (payload?.type !== 'token_count') continue
    const raw = asRecord(payload.rate_limits)
    if (!raw) continue

    const limitId = typeof raw.limit_id === 'string' && raw.limit_id ? raw.limit_id : 'codex'
    const credits = asRecord(raw.credits)
    const individual = asRecord(raw.individual_limit)

    return {
      // `fromCodexRateLimits` já sabe abrir `primary`/`secondary` de dentro de
      // um balde; embrulhar no `rateLimitsByLimitId` é o que dispensa um
      // segundo parser só para o disco.
      limits: { rateLimitsByLimitId: { [limitId]: raw } },
      // O merge compartilhado lê camelCase, o disco escreve snake_case. A
      // tradução mora AQUI, e não lá, para o caminho do App Server continuar
      // com exatamente o formato que ele sempre teve.
      account: {
        rateLimits: {
          planType: raw.plan_type ?? null,
          spendControlReached: raw.spend_control_reached ?? null,
          rateLimitReachedType: raw.rate_limit_reached_type ?? null,
          credits: credits
            ? {
                hasCredits: credits.has_credits ?? false,
                unlimited: credits.unlimited ?? false,
                balance: credits.balance ?? null
              }
            : null,
          individualLimit: individual
            ? {
                limit: individual.limit ?? null,
                used: individual.used ?? null,
                remainingPct: individual.remaining_pct ?? null,
                resetsAt: individual.resets_at ?? null
              }
            : null
        }
      },
      at:
        typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString()
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Uma leitura avulsa, sem observar nada. É o que o arranque usa. */
export async function readLatestRollout(
  env: NodeJS.ProcessEnv = process.env
): Promise<RolloutReading | null> {
  try {
    const dir = await newestDayDir(env)
    if (!dir) return null
    const file = await newestRollout(dir)
    if (!file) return null
    return parseRolloutTail(await readTail(file))
  } catch (err) {
    log.warn('codex', 'falha lendo rollout do Codex', err)
    return null
  }
}

/**
 * Observa os rollouts e avisa a cada leitura nova.
 *
 * Observa a pasta `sessions` inteira em modo recursivo, e é de propósito: o
 * diretório do dia MUDA à meia-noite, e observar só o de hoje faria a tira
 * congelar na virada até alguém reabrir o painel. Onde o modo recursivo não
 * existe, cai para o diretório do dia mais um TEMPORIZADOR DE VIRADA:
 * apontado para a próxima meia-noite local que, ao disparar, larga o observador
 * do dia velho, arma um no diretório novo e força uma leitura — a única forma
 * de a tira não congelar na virada quando o SO não entrega observação
 * recursiva. Cada disparo recalcula a espera até a meia-noite SEGUINTE do zero
 * (ver `msUntilNextLocalMidnight`), então um dia de horário de verão não
 * desalinha o agendamento.
 */
export class CodexRolloutWatcher {
  private watcher: FSWatcher | null = null
  private dayWatcher: FSWatcher | null = null
  private midnightTimer: NodeJS.Timeout | null = null
  private clock: RolloutClock = wallClock
  private timer: NodeJS.Timeout | null = null
  private last = ''
  private fallback: string | null = null

  /**
   * Só para teste: força o ramo de fallback mesmo onde o SO aceitaria a
   * observação recursiva. Também serve de escotilha para uma plataforma que
   * aceite `{ recursive: true }` sem de fato entregar os eventos das subpastas.
   */
  useRecursiveWatch = true

  onReading: ((reading: RolloutReading) => void) | null = null

  /** Só para teste: o diretório do dia que o nó de relógio observa agora. */
  get fallbackDir(): string | null {
    return this.fallback
  }

  async start(env: NodeJS.ProcessEnv = process.env, clock: RolloutClock = wallClock): Promise<void> {
    if (this.watcher || this.dayWatcher) return
    this.clock = clock
    const root = codexSessionsDir(env)
    try {
      if (!this.useRecursiveWatch) throw new Error('fallback forçado')
      this.watcher = watch(root, { recursive: true }, () => this.schedule(env))
    } catch {
      if (!(await this.armDayFallback(env))) return
    }
    // A leitura inaugural é AGUARDADA, não agendada. Duas razões: o observador
    // só fala quando algo muda, e quem abre o app com o Codex parado ficaria
    // olhando o retrato antigo até o próximo turno; e quem chama decide levantar
    // o App Server justamente olhando se já existe leitura viva — agendar faria
    // essa decisão ser tomada antes da resposta chegar, e o subprocesso subiria
    // à toa em toda abertura.
    await this.emit(env)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.midnightTimer) {
      this.clock.clearTimer(this.midnightTimer)
      this.midnightTimer = null
    }
    this.watcher?.close()
    this.watcher = null
    this.dayWatcher?.close()
    this.dayWatcher = null
    this.fallback = null
    this.last = ''
  }

  /**
   * Arma o observador do diretório do dia e o nó de relógio. Devolve `false`
   * quando não há sequer um diretório de dia para observar — aí não há o que
   * fazer, nem faz sentido acordar à meia-noite para reencontrar o nada.
   */
  private async armDayFallback(env: NodeJS.ProcessEnv): Promise<boolean> {
    const day = await newestDayDir(env)
    if (!day) return false
    try {
      this.dayWatcher = watch(day, () => this.schedule(env))
    } catch (err) {
      log.warn('codex', 'nao foi possivel observar os rollouts', err)
      return false
    }
    this.fallback = day
    this.armMidnight(env)
    return true
  }

  /** (Re)agenda o disparo para a próxima meia-noite local, sempre recalculada. */
  private armMidnight(env: NodeJS.ProcessEnv): void {
    if (this.midnightTimer) this.clock.clearTimer(this.midnightTimer)
    const delay = msUntilNextLocalMidnight(new Date(this.clock.now()))
    this.midnightTimer = this.clock.setTimer(() => void this.rollover(env), delay)
    this.midnightTimer.unref?.()
  }

  /**
   * A virada: o diretório do dia acabou de mudar de nome. Troca o observador
   * para o diretório novo, rearma o relógio para a meia-noite seguinte (do
   * zero, para não herdar o desvio de um dia de 23h/25h) e força uma leitura,
   * porque nada mais vai avisar que o arquivo de hoje passou a morar noutro
   * lugar.
   */
  private async rollover(env: NodeJS.ProcessEnv): Promise<void> {
    this.midnightTimer = null
    this.dayWatcher?.close()
    this.dayWatcher = null
    const day = await newestDayDir(env)
    if (day) {
      try {
        this.dayWatcher = watch(day, () => this.schedule(env))
        this.fallback = day
      } catch (err) {
        log.warn('codex', 'nao foi possivel reobservar os rollouts na virada', err)
      }
    }
    this.armMidnight(env)
    await this.emit(env)
  }

  private schedule(env: NodeJS.ProcessEnv, delay = DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.emit(env), delay)
    this.timer.unref?.()
  }

  private async emit(env: NodeJS.ProcessEnv): Promise<void> {
    this.timer = null
    const reading = await readLatestRollout(env)
    if (!reading) return
    // Um turno mexe no arquivo várias vezes sem mudar o percentual. Comparar
    // antes de avisar evita repintar o monitor à toa.
    const stamp = JSON.stringify(reading.limits) + reading.at
    if (stamp === this.last) return
    this.last = stamp
    this.onReading?.(reading)
  }
}
