/**
 * O nó de relógio: contrato persistido, codec defensivo e máquina de estados.
 *
 * Módulo PURO. Nada aqui lê `Date.now()` por conta própria — o instante entra
 * por argumento em toda função que precisa dele. Não é preciosismo de teste: é
 * a única forma de provar que um cronômetro aberto há duas horas soma duas
 * horas, sem relógio falso global e sem esperar duas horas.
 *
 * ─── Onde o tempo mora, e onde ele NÃO mora ─────────────────────────────────
 *
 * `WidgetContent.view` guarda CONFIGURAÇÃO e CHECKPOINTS SEMÂNTICOS: modo,
 * durações, `running`/`paused`/`finished`, âncoras absolutas (`startedAt`,
 * `deadlineAt`), acumulado, voltas, fase, ciclo, geração e a última transição
 * tratada. Esses campos mudam ao iniciar, pausar, zerar, registrar volta,
 * editar uma configuração, terminar um timer ou trocar uma fase. NÃO mudam a
 * cada segundo.
 *
 * O que aparece na tela — hora atual, decorrido, restante, progresso — é
 * DERIVADO em memória de `now` mais esses checkpoints, e nunca entra no
 * workspace. Gravar `00:24:59` e um segundo depois `00:24:58` sujaria o
 * autosave, conflitaria com o app nativo Swift e faria o canvas inteiro receber
 * uma mudança que só interessa a alguns caracteres de um nó.
 *
 * ─── Por que âncora absoluta, e não um contador ─────────────────────────────
 *
 * Nenhum modo soma "mais 1000" a um acumulador. `setInterval` deriva quando o
 * event loop está ocupado e para durante suspensão; depois de uma sessão longa
 * o erro seria a soma de todos os atrasos. Aqui um callback que chegue 380 ms
 * tarde apenas desenha o valor certo — ele não carrega 380 ms de erro adiante:
 *
 *     cronômetro = accumulatedMs + (now - startedAt)
 *     timer      = max(0, deadlineAt - now)
 *     pomodoro   = fase/ciclos derivados de now e do deadline da fase
 *
 * `performance.now()` foi descartado como fonte principal: ele é ótimo para uma
 * sessão curta, mas não sobrevive ao fechamento do app e seu comportamento ao
 * suspender não é uniforme entre sistemas. O custo do `Date.now()` é que uma
 * correção manual grande no relógio do sistema também corrige cronômetro e
 * deadlines — preferível a um relógio civil e um timer discordando sobre quanto
 * tempo de parede passou.
 *
 * ─── O preço de `view` ser [String: String] ─────────────────────────────────
 *
 * O mesmo do botão: tudo é string, e este arquivo é o ÚNICO lugar que sabe
 * disso. Valor ausente, inválido ou gravado por uma versão futura cai num
 * padrão seguro — nunca `NaN` na tela — e as chaves que este binário não
 * conhece ATRAVESSAM o save intactas (ver `writeClockConfig`), porque o
 * contrário trocaria em silêncio a configuração de quem abriu o arquivo numa
 * versão mais nova.
 */

// ─── Limites ──────────────────────────────────────────────────────────────────

/**
 * Piso de uma duração configurável. Existe por uma razão mecânica, não
 * estética: `reconcile` avança o pomodoro em laço enquanto o deadline ficou
 * para trás, e uma fase de zero milissegundos seria um laço infinito. Um
 * segundo também é o menor intervalo que o mostrador consegue distinguir.
 */
export const MIN_DURATION_MS = 1_000

/** Teto de uma duração configurável: 24 horas. Acima disso não é um timer. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000

/**
 * Teto de um instante absoluto aceito do disco (2100-01-01). Um `deadlineAt`
 * absurdo — lixo, ou um relógio de sistema que deu um salto — passa a ser um
 * número grande porém finito, em vez de virar `Infinity` e envenenar cada
 * subtração derivada dele.
 */
export const MAX_EPOCH_MS = 4_102_444_800_000

/**
 * Teto de voltas. Volta é um gesto humano e de baixa frequência, então cabe em
 * `view`; uma lista sem teto transformaria aos poucos um widget pequeno num
 * documento arbitrariamente grande, dentro do `workspace.json` que o app nativo
 * também grava. Um arquivo próprio em `clocks/` foi considerado e rejeitado:
 * acrescentaria cópia, backup, limpeza e concorrência de arquivo para guardar
 * poucos números.
 */
export const MAX_LAPS = 100

/**
 * Trava do laço de reconciliação do pomodoro. Com `MIN_DURATION_MS` o laço já
 * termina, mas um `deadlineAt` corrompido somado a uma fase de 1s daria milhões
 * de voltas antes de alcançar o agora. 20 mil fases é mais de um ano de foco de
 * 25 minutos: quem chegar aqui não está esperando uma contagem correta, está
 * esperando o app não travar.
 */
const MAX_ADVANCE_STEPS = 20_000

/**
 * A cor do LED aceso. Vermelho porque é o display de painel mais comum, e
 * porque foi ele que serviu de referência ao desenho do mostrador.
 *
 * Só ESTA cor é guardada. O vermelho apagado das barras em repouso e o brilho
 * em volta são DERIVADOS dela no CSS, por `color-mix` — guardar as três seria
 * três chances de ficarem incoerentes entre si, e obrigaria a UI a oferecer
 * três escolhas onde existe uma.
 */
export const DEFAULT_CLOCK_COLOR = '#ff3b2f'

export const DEFAULT_TIMER_MS = 25 * 60 * 1000
export const DEFAULT_FOCUS_MS = 25 * 60 * 1000
export const DEFAULT_BREAK_MS = 5 * 60 * 1000

// ─── Contrato ─────────────────────────────────────────────────────────────────

/**
 * Quatro modos no MESMO objeto, e não quatro `WidgetKind`.
 *
 * Eles são quatro estados de uma ferramenta só, selecionados por `mode`. Quatro
 * kinds duplicariam criação, título, estilos e compatibilidade sem criar quatro
 * domínios diferentes — e cada kind novo é um item a mais na lista que o app
 * nativo precisa conhecer.
 */
export type ClockMode = 'clock' | 'stopwatch' | 'timer' | 'pomodoro'

export const CLOCK_MODES: ClockMode[] = ['clock', 'stopwatch', 'timer', 'pomodoro']

/** Relógio NÃO tem estado: enquanto o nó existe, ele mostra o agora. */
export type RunState = 'idle' | 'running' | 'paused'

/** O timer tem um quarto estado que os outros não têm: ele ACABA. */
export type TimerState = RunState | 'finished'

export type PomodoroPhase = 'focus' | 'break'

export interface StopwatchConfig {
  state: RunState
  /** Milissegundos já acumulados ANTES da corrida atual. */
  accumulatedMs: number
  /** Instante absoluto em que a corrida atual começou. 0 quando não corre. */
  startedAt: number
  /** Durações das voltas, em ms, na ordem em que foram registradas. */
  laps: number[]
  /**
   * O decorrido no instante da última volta.
   *
   * Âncora própria, e não a soma da lista, por causa do TETO: passadas cem
   * voltas a mais antiga sai, a soma deixa de representar todo o tempo já
   * dividido, e a volta seguinte nasceria com a duração da volta descartada
   * somada dentro dela. Um campo a mais em `view` compra a correção da volta
   * 101 em diante.
   */
  lastLapMs: number
}

export interface TimerConfig {
  state: TimerState
  /** A duração CONFIGURADA — para onde "zerar" volta. */
  durationMs: number
  /** Instante absoluto do fim. Só vale em `running`. */
  deadlineAt: number
  /** O que sobrava quando pausou. Só vale em `paused`. */
  remainingMs: number
  /**
   * Geração da execução. Zerar inicia uma geração nova, e é ela que separa
   * "este fim" de "o fim anterior" na identidade do evento.
   */
  generation: number
  /** Geração cujo fim JÁ foi tratado. É o que torna o disparo no máximo um. */
  firedGeneration: number
}

export interface PomodoroConfig {
  state: RunState
  focusMs: number
  breakMs: number
  phase: PomodoroPhase
  deadlineAt: number
  remainingMs: number
  /**
   * Ciclos de foco CONCLUÍDOS. Contado quando o foco TERMINA, não quando
   * começa: a contagem responde ao que foi feito, não ao que foi iniciado.
   */
  cycles: number
  generation: number
  /** Quantas fronteiras de fase esta geração já atravessou. */
  sequence: number
  /** A maior sequência já tratada — manualmente ou por evento disparado. */
  firedSequence: number
}

export interface ClockConfig {
  mode: ClockMode
  /** Só apresentação. O FUSO é sempre o do sistema naquele momento. */
  hour12: boolean
  /** Cor do LED aceso, `#rrggbb`. O resto do visor é derivado dela. */
  color: string
  stopwatch: StopwatchConfig
  timer: TimerConfig
  pomodoro: PomodoroConfig
}

export function defaultClockConfig(): ClockConfig {
  return {
    mode: 'clock',
    hour12: false,
    color: DEFAULT_CLOCK_COLOR,
    stopwatch: { state: 'idle', accumulatedMs: 0, startedAt: 0, laps: [], lastLapMs: 0 },
    timer: {
      state: 'idle',
      durationMs: DEFAULT_TIMER_MS,
      deadlineAt: 0,
      remainingMs: DEFAULT_TIMER_MS,
      generation: 0,
      firedGeneration: -1
    },
    pomodoro: {
      state: 'idle',
      focusMs: DEFAULT_FOCUS_MS,
      breakMs: DEFAULT_BREAK_MS,
      phase: 'focus',
      deadlineAt: 0,
      remainingMs: DEFAULT_FOCUS_MS,
      cycles: 0,
      generation: 0,
      sequence: 0,
      firedSequence: 0
    }
  }
}

// ─── Codec ────────────────────────────────────────────────────────────────────

/**
 * As chaves que ESTE binário conhece. Tudo em `view` que não está nesta lista é
 * copiado de volta no save sem ser lido — ver `writeClockConfig`.
 */
const KNOWN_KEYS = [
  'mode',
  'hour12',
  'color',
  'swState',
  'swAccum',
  'swStartedAt',
  'swLaps',
  'swLastLap',
  'tState',
  'tDuration',
  'tDeadlineAt',
  'tRemaining',
  'tGen',
  'tFiredGen',
  'pState',
  'pFocus',
  'pBreak',
  'pPhase',
  'pDeadlineAt',
  'pRemaining',
  'pCycles',
  'pGen',
  'pSeq',
  'pFiredSeq'
] as const

/** Inteiro dentro de [min, max]. O que não for número finito cai no padrão. */
function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function pick<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback
}

/**
 * As voltas viajam como um array JSON DENTRO de uma string, porque `view` é
 * `[String: String]` dos dois lados e um array de verdade não caberia ali. JSON
 * quebrado, tipo errado ou lista longa demais devolvem uma lista vazia ou
 * truncada — nunca uma exceção subindo até a renderização do canvas.
 */
function readLaps(raw: string | undefined): number[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .slice(0, MAX_LAPS)
    .map((v) => Math.round(Math.min(v, MAX_EPOCH_MS)))
}

/**
 * `#rrggbb`, ou o padrão. A validação é estreita de propósito: este valor vira
 * uma custom property escrita inline no nó, e aceitar uma string qualquer seria
 * deixar o `view` de um arquivo decidir o que entra no `style` de um elemento.
 * A forma curta `#rgb` é expandida em vez de recusada — é o que um humano
 * digita, e recusá-la só devolveria vermelho sem explicar por quê.
 */
export function readHexColor(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(value)) return value
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
  }
  return DEFAULT_CLOCK_COLOR
}

export function setClockColor(config: ClockConfig, color: string): ClockConfig {
  return { ...config, color: readHexColor(color) }
}

export function readClockConfig(view: Record<string, string>): ClockConfig {
  const d = defaultClockConfig()
  const focusMs = int(view.pFocus, d.pomodoro.focusMs, MIN_DURATION_MS, MAX_DURATION_MS)
  const breakMs = int(view.pBreak, d.pomodoro.breakMs, MIN_DURATION_MS, MAX_DURATION_MS)
  const durationMs = int(view.tDuration, d.timer.durationMs, MIN_DURATION_MS, MAX_DURATION_MS)
  const phase = pick(view.pPhase, ['focus', 'break'] as const, 'focus')
  return {
    mode: pick(view.mode, CLOCK_MODES, 'clock'),
    hour12: view.hour12 === '1',
    color: readHexColor(view.color),
    stopwatch: {
      state: pick(view.swState, ['idle', 'running', 'paused'] as const, 'idle'),
      accumulatedMs: int(view.swAccum, 0, 0, MAX_EPOCH_MS),
      startedAt: int(view.swStartedAt, 0, 0, MAX_EPOCH_MS),
      laps: readLaps(view.swLaps),
      lastLapMs: int(view.swLastLap, 0, 0, MAX_EPOCH_MS)
    },
    timer: {
      state: pick(view.tState, ['idle', 'running', 'paused', 'finished'] as const, 'idle'),
      durationMs,
      deadlineAt: int(view.tDeadlineAt, 0, 0, MAX_EPOCH_MS),
      // Ausente cai na duração configurada, e não em zero: um timer `paused`
      // cujo restante se perdeu deve voltar cheio, nunca vencido.
      remainingMs: int(view.tRemaining, durationMs, 0, MAX_DURATION_MS),
      generation: int(view.tGen, 0, 0, Number.MAX_SAFE_INTEGER),
      firedGeneration: int(view.tFiredGen, -1, -1, Number.MAX_SAFE_INTEGER)
    },
    pomodoro: {
      state: pick(view.pState, ['idle', 'running', 'paused'] as const, 'idle'),
      focusMs,
      breakMs,
      phase,
      deadlineAt: int(view.pDeadlineAt, 0, 0, MAX_EPOCH_MS),
      remainingMs: int(view.pRemaining, phase === 'focus' ? focusMs : breakMs, 0, MAX_DURATION_MS),
      cycles: int(view.pCycles, 0, 0, Number.MAX_SAFE_INTEGER),
      generation: int(view.pGen, 0, 0, Number.MAX_SAFE_INTEGER),
      sequence: int(view.pSeq, 0, 0, Number.MAX_SAFE_INTEGER),
      firedSequence: int(view.pFiredSeq, 0, 0, Number.MAX_SAFE_INTEGER)
    }
  }
}

/**
 * Chave vazia ou igual ao padrão é OMITIDA — um `view` enxuto é o que o app
 * nativo e o diff do arquivo de workspace mostram, e é a mesma disciplina do
 * `writeButtonConfig`.
 *
 * `previous` é o `view` que estava no nó, e o que ele traz de DESCONHECIDO
 * atravessa intacto. Sem isso, abrir num Atelier antigo um relógio configurado
 * por um novo apagaria a configuração no primeiro save — perda silenciosa, o
 * pior tipo de bug de formato.
 */
export function writeClockConfig(
  config: ClockConfig,
  previous: Record<string, string> = {}
): Record<string, string> {
  const view: Record<string, string> = {}
  for (const [key, value] of Object.entries(previous)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) view[key] = value
  }

  view.mode = config.mode
  if (config.hour12) view.hour12 = '1'
  if (config.color !== DEFAULT_CLOCK_COLOR) view.color = config.color

  const sw = config.stopwatch
  if (sw.state !== 'idle') view.swState = sw.state
  if (sw.accumulatedMs > 0) view.swAccum = String(Math.round(sw.accumulatedMs))
  if (sw.startedAt > 0) view.swStartedAt = String(Math.round(sw.startedAt))
  if (sw.laps.length > 0) {
    view.swLaps = JSON.stringify(sw.laps.slice(0, MAX_LAPS).map((v) => Math.round(v)))
  }
  if (sw.lastLapMs > 0) view.swLastLap = String(Math.round(sw.lastLapMs))

  const t = config.timer
  if (t.state !== 'idle') view.tState = t.state
  view.tDuration = String(Math.round(t.durationMs))
  if (t.deadlineAt > 0) view.tDeadlineAt = String(Math.round(t.deadlineAt))
  if (t.remainingMs !== t.durationMs) view.tRemaining = String(Math.round(t.remainingMs))
  if (t.generation > 0) view.tGen = String(t.generation)
  if (t.firedGeneration >= 0) view.tFiredGen = String(t.firedGeneration)

  const p = config.pomodoro
  if (p.state !== 'idle') view.pState = p.state
  view.pFocus = String(Math.round(p.focusMs))
  view.pBreak = String(Math.round(p.breakMs))
  if (p.phase !== 'focus') view.pPhase = p.phase
  if (p.deadlineAt > 0) view.pDeadlineAt = String(Math.round(p.deadlineAt))
  const phaseMs = p.phase === 'focus' ? p.focusMs : p.breakMs
  if (p.remainingMs !== phaseMs) view.pRemaining = String(Math.round(p.remainingMs))
  if (p.cycles > 0) view.pCycles = String(p.cycles)
  if (p.generation > 0) view.pGen = String(p.generation)
  if (p.sequence > 0) view.pSeq = String(p.sequence)
  if (p.firedSequence > 0) view.pFiredSeq = String(p.firedSequence)

  return view
}

// ─── Derivação: o que a tela mostra, e que nunca é gravado ────────────────────

/** `accumulatedMs + (now - startedAt)` enquanto corre; só o acumulado quando não. */
export function stopwatchElapsedMs(config: ClockConfig, now: number): number {
  const sw = config.stopwatch
  if (sw.state !== 'running') return Math.max(0, sw.accumulatedMs)
  // `now - startedAt` pode ser negativo se o relógio do sistema andou para trás
  // entre o início e agora. O piso em zero é o que impede um decorrido negativo
  // aparecer no mostrador.
  return Math.max(0, sw.accumulatedMs + Math.max(0, now - sw.startedAt))
}

/** `max(0, deadlineAt - now)` enquanto corre; o restante congelado quando não. */
export function timerRemainingMs(config: ClockConfig, now: number): number {
  const t = config.timer
  if (t.state === 'running') return Math.max(0, t.deadlineAt - now)
  if (t.state === 'finished') return 0
  if (t.state === 'paused') return Math.max(0, t.remainingMs)
  return Math.max(0, t.durationMs)
}

export function pomodoroRemainingMs(config: ClockConfig, now: number): number {
  const p = config.pomodoro
  if (p.state === 'running') return Math.max(0, p.deadlineAt - now)
  if (p.state === 'paused') return Math.max(0, p.remainingMs)
  return p.phase === 'focus' ? p.focusMs : p.breakMs
}

export function pomodoroPhaseMs(config: ClockConfig): number {
  return config.pomodoro.phase === 'focus' ? config.pomodoro.focusMs : config.pomodoro.breakMs
}

/** 0..1. `null` onde progresso não significa nada (relógio e cronômetro). */
export function clockProgress(config: ClockConfig, now: number): number | null {
  if (config.mode === 'timer') {
    const total = config.timer.durationMs
    if (total <= 0) return null
    return clamp01(1 - timerRemainingMs(config, now) / total)
  }
  if (config.mode === 'pomodoro') {
    const total = pomodoroPhaseMs(config)
    if (total <= 0) return null
    return clamp01(1 - pomodoroRemainingMs(config, now) / total)
  }
  return null
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

// ─── Máquina de estados: reconciliação com o agora ────────────────────────────

export type ClockEventKind = 'timerFinished' | 'phaseChanged'

/**
 * A identidade de um evento. É ela que torna o disparo NO MÁXIMO UMA VEZ: o
 * coordenador guarda a última identidade tratada em memória e grava geração e
 * sequência no checkpoint ANTES de chamar o botão. Se o app cair na janela
 * estreita entre gravar e executar, a ação se perde — o que é o risco menor.
 * Repetir um comando, um prompt ou uma URL de efeito externo seria o maior.
 */
export interface ClockEvent {
  kind: ClockEventKind
  generation: number
  sequence: number
  /** Só em `phaseChanged`: a fase que COMEÇOU depois da transição. */
  phase?: PomodoroPhase
  /** Quantas fronteiras foram coalescidas neste evento. 1 no caso ao vivo. */
  crossed: number
}

export interface Reconciliation {
  config: ClockConfig
  /** O checkpoint mudou e precisa ser persistido. */
  changed: boolean
  /** No máximo um evento por reconciliação — nunca uma rajada. */
  event: ClockEvent | null
}

/**
 * Traz o checkpoint até `now` e diz se algo deve ser disparado.
 *
 * `live` é a distinção inteira entre as duas políticas de reabertura, e ela não
 * é sobre duração — é sobre se o processo e a INTENÇÃO de automação estavam
 * vivos quando o tempo passou:
 *
 *  - `live: true` — um tique, ou o `resume` depois de uma suspensão com o
 *    Atelier aberto. O timer que atravessou zero gera UM evento; o pomodoro
 *    avança todos os ciclos necessários e coalesce as fronteiras perdidas em UM
 *    evento, nunca numa rajada que abriria vários terminais de uma vez.
 *  - `live: false` — o primeiro cálculo depois de abrir o app. O estado é
 *    reconciliado (o timer reabre em `finished`, o pomodoro na fase e na
 *    contagem que correspondem ao agora), mas NADA é disparado
 *    retroativamente: um comando ou uma URL pode não fazer mais sentido horas
 *    depois. O custo aceito é perder a automação que venceu sem nenhum processo
 *    do Atelier vivo, e a UI deve dizer que terminou com o app fechado para
 *    isso não parecer falha.
 *
 * O modo SELECIONADO manda: timer e pomodoro só emitem enquanto são o modo
 * ativo. O checkpoint do outro continua andando pelo relógio absoluto e é
 * reconciliado quando o usuário voltar a ele, pelas mesmas regras.
 */
export function reconcile(
  config: ClockConfig,
  now: number,
  opts: { live: boolean }
): Reconciliation {
  if (config.mode === 'timer') return reconcileTimer(config, now, opts.live)
  if (config.mode === 'pomodoro') return reconcilePomodoro(config, now, opts.live)
  // Relógio e cronômetro não têm o que reconciliar: o valor é derivado de
  // `now`, e nem um nem outro produz evento. Um cronômetro `running` continua
  // correndo enquanto o app está fechado de propósito — ele mede tempo de
  // parede, não "tempo em que o renderer recebeu tiques". Pausar antes de
  // fechar continua sendo o caminho para excluir esse intervalo.
  return { config, changed: false, event: null }
}

function reconcileTimer(config: ClockConfig, now: number, live: boolean): Reconciliation {
  const t = config.timer
  if (t.state !== 'running' || now < t.deadlineAt) {
    return { config, changed: false, event: null }
  }
  const fired = t.firedGeneration < t.generation
  const timer: TimerConfig = {
    ...t,
    state: 'finished',
    remainingMs: 0,
    // A geração é marcada como tratada nos DOIS caminhos. No caminho morto isso
    // é o que garante que o fim vencido com o app fechado não volte a disparar
    // no primeiro tique depois da abertura.
    firedGeneration: t.generation
  }
  return {
    config: { ...config, timer },
    changed: true,
    event:
      live && fired
        ? { kind: 'timerFinished', generation: t.generation, sequence: 0, crossed: 1 }
        : null
  }
}

function reconcilePomodoro(config: ClockConfig, now: number, live: boolean): Reconciliation {
  const p = config.pomodoro
  if (p.state !== 'running' || now < p.deadlineAt) {
    return { config, changed: false, event: null }
  }

  let phase = p.phase
  let cycles = p.cycles
  let sequence = p.sequence
  let deadlineAt = p.deadlineAt
  let crossed = 0

  while (now >= deadlineAt && crossed < MAX_ADVANCE_STEPS) {
    // O ciclo é contado quando o FOCO termina — o que foi concluído, não o que
    // foi iniciado.
    if (phase === 'focus') cycles++
    phase = phase === 'focus' ? 'break' : 'focus'
    sequence++
    crossed++
    deadlineAt += phase === 'focus' ? p.focusMs : p.breakMs
  }

  const pomodoro: PomodoroConfig = {
    ...p,
    phase,
    cycles,
    sequence,
    deadlineAt,
    remainingMs: Math.max(0, deadlineAt - now),
    firedSequence: sequence
  }
  return {
    config: { ...config, pomodoro },
    changed: true,
    // UM evento, com a sequência FINAL: várias fronteiras atravessadas numa
    // suspensão viram uma transição observada, não uma rajada.
    event:
      live && sequence > p.firedSequence
        ? {
            kind: 'phaseChanged',
            generation: p.generation,
            sequence,
            phase,
            crossed
          }
        : null
  }
}

/**
 * Quando o coordenador precisa acordar de novo, em ms a partir de `now`.
 *
 * `null` = nada a agendar por causa DESTE relógio. Quem chama toma o menor de
 * todos e arma UM `setTimeout` para o canvas inteiro — nunca um por nó.
 *
 * O alinhamento ao próximo segundo é o que faz o mostrador virar junto com o
 * relógio do sistema em vez de a cada segundo *desde a montagem*: dois relógios
 * no canvas que virassem em instantes diferentes seriam lidos como um bug.
 */
export function nextWakeMs(config: ClockConfig, now: number): number | null {
  const untilNextSecond = 1000 - (((now % 1000) + 1000) % 1000)
  switch (config.mode) {
    case 'clock':
      return untilNextSecond
    case 'stopwatch':
      return config.stopwatch.state === 'running' ? untilNextSecond : null
    case 'timer': {
      if (config.timer.state !== 'running') return null
      // O menor entre "o próximo segundo" e "o deadline": um deadline a 300 ms
      // daqui não pode esperar o tique do segundo cheio para virar `finished`.
      return Math.max(0, Math.min(untilNextSecond, config.timer.deadlineAt - now))
    }
    case 'pomodoro': {
      if (config.pomodoro.state !== 'running') return null
      return Math.max(0, Math.min(untilNextSecond, config.pomodoro.deadlineAt - now))
    }
  }
}

/** Só timer e pomodoro emitem. Relógio, cronômetro e voltas nunca disparam ação. */
export function emitsEvents(config: ClockConfig): boolean {
  return config.mode === 'timer' || config.mode === 'pomodoro'
}

// ─── Gestos ───────────────────────────────────────────────────────────────────
// Cada um devolve uma configuração NOVA. Todos recebem `now`: um gesto ancora
// um instante absoluto, e o instante é do chamador, não deste módulo.

export function setMode(config: ClockConfig, mode: ClockMode): ClockConfig {
  // Trocar de modo NÃO apaga o estado dos outros: um cronômetro pausado
  // continua pausado ao visitar o relógio. Só a apresentação e a emissão de
  // eventos seguem o modo ativo.
  return { ...config, mode }
}

export function setHour12(config: ClockConfig, hour12: boolean): ClockConfig {
  return { ...config, hour12 }
}

// Cronômetro ──────────────────────────────────────────────────────────────────

export function startStopwatch(config: ClockConfig, now: number): ClockConfig {
  const sw = config.stopwatch
  if (sw.state === 'running') return config
  return { ...config, stopwatch: { ...sw, state: 'running', startedAt: now } }
}

export function pauseStopwatch(config: ClockConfig, now: number): ClockConfig {
  const sw = config.stopwatch
  if (sw.state !== 'running') return config
  return {
    ...config,
    stopwatch: {
      ...sw,
      state: 'paused',
      // A corrida vira acumulado e a âncora some: sem isso, retomar somaria de
      // novo o intervalo já contabilizado.
      accumulatedMs: stopwatchElapsedMs(config, now),
      startedAt: 0
    }
  }
}

export function toggleStopwatch(config: ClockConfig, now: number): ClockConfig {
  return config.stopwatch.state === 'running'
    ? pauseStopwatch(config, now)
    : startStopwatch(config, now)
}

export function resetStopwatch(config: ClockConfig): ClockConfig {
  return {
    ...config,
    stopwatch: { state: 'idle', accumulatedMs: 0, startedAt: 0, laps: [], lastLapMs: 0 }
  }
}

/**
 * Registra uma volta: a DURAÇÃO desde a volta anterior, não o acumulado total —
 * é o que "volta" significa num cronômetro, e o total continua derivável somando
 * a lista.
 *
 * No teto, a volta mais antiga sai. Descartar a nova seria pior: quem
 * acabou de apertar o botão veria o gesto não fazer nada.
 */
export function lapStopwatch(config: ClockConfig, now: number): ClockConfig {
  const sw = config.stopwatch
  if (sw.state !== 'running') return config
  const total = stopwatchElapsedMs(config, now)
  const laps = [...sw.laps, Math.max(0, total - sw.lastLapMs)]
  return {
    ...config,
    stopwatch: {
      ...sw,
      laps: laps.length > MAX_LAPS ? laps.slice(laps.length - MAX_LAPS) : laps,
      lastLapMs: total
    }
  }
}

// Timer ───────────────────────────────────────────────────────────────────────

export function startTimer(config: ClockConfig, now: number): ClockConfig {
  const t = config.timer
  if (t.state === 'running') return config
  // Retomar nasce um deadline NOVO a partir do agora: o antigo já passou
  // durante a pausa e voltaria vencido.
  const remaining = t.state === 'paused' ? Math.max(0, t.remainingMs) : t.durationMs
  return { ...config, timer: { ...t, state: 'running', deadlineAt: now + remaining } }
}

export function pauseTimer(config: ClockConfig, now: number): ClockConfig {
  const t = config.timer
  if (t.state !== 'running') return config
  // O deadline vira restante — a troca inversa de `startTimer`, e é ela que faz
  // pausar/retomar não perder nem ganhar tempo.
  return {
    ...config,
    timer: { ...t, state: 'paused', remainingMs: Math.max(0, t.deadlineAt - now), deadlineAt: 0 }
  }
}

export function toggleTimer(config: ClockConfig, now: number): ClockConfig {
  return config.timer.state === 'running' ? pauseTimer(config, now) : startTimer(config, now)
}

/** Zerar volta à duração configurada e ABRE UMA GERAÇÃO NOVA de execução. */
export function resetTimer(config: ClockConfig): ClockConfig {
  const t = config.timer
  return {
    ...config,
    timer: {
      ...t,
      state: 'idle',
      deadlineAt: 0,
      remainingMs: t.durationMs,
      generation: t.generation + 1
    }
  }
}

/**
 * Editar a duração NÃO altera em silêncio um timer em andamento: quem está
 * correndo ou pausado precisa zerar antes. Recalcular o restante
 * proporcionalmente é surpreendente e não tem uma interpretação única.
 */
export function setTimerDuration(config: ClockConfig, durationMs: number): ClockConfig {
  const ms = clampDuration(durationMs)
  const t = config.timer
  if (t.state === 'running' || t.state === 'paused') return { ...config, timer: { ...t, durationMs: ms } }
  return { ...config, timer: { ...t, durationMs: ms, remainingMs: ms, state: 'idle', deadlineAt: 0 } }
}

// Pomodoro ────────────────────────────────────────────────────────────────────

export function startPomodoro(config: ClockConfig, now: number): ClockConfig {
  const p = config.pomodoro
  if (p.state === 'running') return config
  const remaining =
    p.state === 'paused' ? Math.max(0, p.remainingMs) : p.phase === 'focus' ? p.focusMs : p.breakMs
  return { ...config, pomodoro: { ...p, state: 'running', deadlineAt: now + remaining } }
}

export function pausePomodoro(config: ClockConfig, now: number): ClockConfig {
  const p = config.pomodoro
  if (p.state !== 'running') return config
  return {
    ...config,
    pomodoro: {
      ...p,
      state: 'paused',
      remainingMs: Math.max(0, p.deadlineAt - now),
      deadlineAt: 0
    }
  }
}

export function togglePomodoro(config: ClockConfig, now: number): ClockConfig {
  return config.pomodoro.state === 'running'
    ? pausePomodoro(config, now)
    : startPomodoro(config, now)
}

/**
 * "Avançar fase" é um gesto MANUAL e, por padrão, não dispara o botão: o cabo
 * representa o tempo que terminou, não todo clique de navegação. Por isso a
 * sequência nova já nasce marcada como tratada — configurar ou corrigir um
 * pomodoro nunca roda comandos.
 */
export function advancePomodoroPhase(config: ClockConfig, now: number): ClockConfig {
  const p = config.pomodoro
  const phase: PomodoroPhase = p.phase === 'focus' ? 'break' : 'focus'
  const cycles = p.phase === 'focus' ? p.cycles + 1 : p.cycles
  const duration = phase === 'focus' ? p.focusMs : p.breakMs
  const sequence = p.sequence + 1
  return {
    ...config,
    pomodoro: {
      ...p,
      phase,
      cycles,
      sequence,
      firedSequence: sequence,
      deadlineAt: p.state === 'running' ? now + duration : 0,
      remainingMs: duration
    }
  }
}

/** Zerar ciclos: volta ao foco, zera a contagem e abre uma geração nova. */
export function resetPomodoro(config: ClockConfig): ClockConfig {
  const p = config.pomodoro
  return {
    ...config,
    pomodoro: {
      ...p,
      state: 'idle',
      phase: 'focus',
      cycles: 0,
      deadlineAt: 0,
      remainingMs: p.focusMs,
      generation: p.generation + 1,
      sequence: 0,
      firedSequence: 0
    }
  }
}

export function setPomodoroDurations(
  config: ClockConfig,
  focusMs: number,
  breakMs: number
): ClockConfig {
  const p = config.pomodoro
  const focus = clampDuration(focusMs)
  const brk = clampDuration(breakMs)
  if (p.state === 'running' || p.state === 'paused') {
    return { ...config, pomodoro: { ...p, focusMs: focus, breakMs: brk } }
  }
  return {
    ...config,
    pomodoro: {
      ...p,
      focusMs: focus,
      breakMs: brk,
      remainingMs: p.phase === 'focus' ? focus : brk
    }
  }
}

export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_DURATION_MS
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(ms)))
}

// ─── Apresentação ─────────────────────────────────────────────────────────────

/**
 * A hora civil no fuso do SISTEMA, naquele momento.
 *
 * Sem timezone hardcoded e sem offset persistido: mudar de fuso e reabrir o
 * Atelier faz o relógio acompanhar o usuário, e horário de verão e viagem
 * tornariam um offset congelado errado.
 */
export function formatClockTime(now: number, hour12: boolean): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12
  }).format(new Date(now))
}

/** `MM:SS` abaixo de uma hora, `H:MM:SS` acima. Nunca `NaN`. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Com centésimos — o cronômetro é o único mostrador em que eles significam algo. */
export function formatStopwatch(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  const centis = Math.floor((safe % 1000) / 10)
  return `${formatDuration(safe)},${String(centis).padStart(2, '0')}`
}

/** Rótulo do modo — o cabeçalho do nó e o `atelier list` leem daqui. */
export function clockModeLabel(mode: ClockMode): string {
  switch (mode) {
    case 'stopwatch':
      return 'Cronômetro'
    case 'timer':
      return 'Timer'
    case 'pomodoro':
      return 'Pomodoro'
    default:
      return 'Relógio'
  }
}
