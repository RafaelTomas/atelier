/**
 * `atelier clock <create|set|list|remove>` — o agente CONFIGURA o relógio
 * inteiro; ARMAR continua sendo gesto do usuário.
 *
 * Molde de handlers/button.ts: terminal chamador, workspace dele, nó
 * posicionado à direita de quem chamou, `workspace:changed` no fim. A
 * diferença que importa é a autorização (ver a seção "O Artesão configura o
 * relógio inteiro; quem ARMA é o usuário" do plano):
 *
 *   - `defaultClockConfig()` já nasce `state: 'idle'` — não existe `--arm`
 *     aqui, e não é omissão: reduzir capacidade (`--disarm`) é seguro,
 *     aumentá-la é o gesto do usuário, exatamente como o botão propõe
 *     `pending` e só o clique do usuário arma.
 *   - mexer por CLI no que o relógio EXECUTA — modo, horário, dias, ou o
 *     alvo do cabo — desarma de novo, mesmo que o alarme já estivesse armado
 *     pelo usuário: ele leu a agenda antiga quando armou, e a agenda mudou.
 *     Mexer no que só APARECE (cor, 12/24 h) não desarma.
 *   - o invariante que o `WorkspaceManager` já aplica (`addConnection`
 *     recusa um `clockAction` para um botão `pending` ou `confirm: true`)
 *     fecha o furo óbvio de graça: um Artesão não consegue cabear um relógio
 *     ao botão que ele mesmo acabou de propor, só a um que o usuário já leu
 *     e aceitou. As recusas viram aqui mensagens que ENSINAM o que fazer.
 *
 * Toda a gramática — parsing de horário, dias e duração, o bitmask — mora em
 * `shared/clock.ts` (`parseAlarmTime`, `parseAlarmDays`, `parseDurationSpec`,
 * `setAlarm`, `disarmAlarm`…). Este arquivo só lê flags e chama essas
 * funções puras; não reimplementa nenhuma delas.
 */
import type { CanvasNode, UUID } from '@shared/types'
import { clockFireBlock, readButtonConfig } from '@shared/types'
import {
  ALARM_ALL_DAYS,
  ALARM_ONCE,
  ALARM_WEEKDAYS,
  ALARM_WEEKEND,
  CLOCK_MODES,
  type ClockConfig,
  type ClockMode,
  alarmIsArmed,
  defaultClockConfig,
  disarmAlarm,
  formatAlarmTime,
  formatDuration,
  parseAlarmDays,
  parseAlarmTime,
  parseDurationSpec,
  readClockConfig,
  setAlarm,
  setClockColor,
  setHour12,
  setMode,
  setPomodoroDurations,
  setTimerDuration,
  writeClockConfig
} from '@shared/clock'
import { makeWidgetContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { defaultSize } from '../../node-sizes'
import { freeSpotRightOf, nodeAt } from '../../spawn-spot'
import { notifyRenderer } from '../../../ipc/notify'
import { requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier clock <create|set|list|remove> …'

const SET_USAGE =
  'error: usage: atelier clock set "Clock" [--mode …] [--at-time HH:MM] [--days …] [--timer 25m] [--focus 25m] [--break 5m] [--color "#ff3b2f"] [--12h|--24h] [--name "New name"] [--on "Button"|--off] [--disarm]'

export async function handleClock(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'create':
      return createClock(args, tid)
    case 'set':
      return setClock(args, tid)
    case 'list':
      return listClocks(tid)
    case 'remove':
      return removeClock(args, tid)
    default:
      return USAGE
  }
}

const VALUE_FLAGS = ['mode', 'at-time', 'days', 'timer', 'focus', 'break', 'color', 'on', 'at', 'name', 'label']

function takeFlags(args: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : null
    if (name === '12h') flags.set('12h', '1')
    else if (name === '24h') flags.set('24h', '1')
    else if (name === 'off') flags.set('off', '1')
    else if (name === 'disarm') flags.set('disarm', '1')
    else if (name && VALUE_FLAGS.includes(name)) flags.set(name, args[++i] ?? '')
    else rest.push(args[i])
  }
  return { rest, flags }
}

function parsePoint(raw: string): { x: number; y: number } | 'invalid' {
  const parts = raw.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return 'invalid'
  return { x: parts[0], y: parts[1] }
}

/** Relógios deste workspace, na ordem em que estão no canvas. */
function clocksOf(tid: UUID): CanvasNode[] {
  const ws = workspaceForTerminal(tid)
  if (!ws) return []
  return ws.nodes.filter((n) => n.content.type === 'widget' && n.content.value.kind === 'clock')
}

/** Mesma busca fuzzy de handlers/button.ts: nome exato, depois substring, depois prefixo do id. */
function findClock(tid: UUID, name: string): CanvasNode | null {
  const needle = name.toLowerCase().trim()
  const candidates = clocksOf(tid)
  return (
    candidates.find((n) => nodeDisplayName(n.content).toLowerCase() === needle) ??
    candidates.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle)) ??
    candidates.find((n) => n.id.toLowerCase().startsWith(needle.slice(0, 8))) ??
    null
  )
}

/** Botões deste workspace — mesmo escopo que handlers/button.ts usa para o CLI achá-los. */
function buttonsOf(tid: UUID): CanvasNode[] {
  const ws = workspaceForTerminal(tid)
  if (!ws) return []
  return ws.nodes.filter((n) => n.content.type === 'widget' && n.content.value.kind === 'button')
}

function findButton(tid: UUID, name: string): CanvasNode | null {
  const needle = name.toLowerCase().trim()
  const candidates = buttonsOf(tid)
  return (
    candidates.find((n) => nodeDisplayName(n.content).toLowerCase() === needle) ??
    candidates.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle)) ??
    candidates.find((n) => n.id.toLowerCase().startsWith(needle.slice(0, 8))) ??
    null
  )
}

/**
 * Um botão como alvo de relógio: existe, não é `pending`, não pede
 * confirmação. As duas recusas são o invariante do `WorkspaceManager`
 * (`workspace-manager.ts:245`) traduzido em mensagem que ENSINA — ele barra
 * em silêncio, aqui é onde se diz por quê.
 */
function validateButtonTarget(tid: UUID, name: string): CanvasNode | string {
  const button = findButton(tid, name)
  if (!button || button.content.type !== 'widget') {
    return `error: button '${name}' not found. Use \`atelier button list\`.`
  }
  const cfg = readButtonConfig(button.content.value.view)
  switch (clockFireBlock(cfg)) {
    case 'pending':
      return `error: '${cfg.label}' is pending — the user has to accept it before a clock can fire it.`
    case 'confirm':
      // A saída NÃO é `--no-confirm`: isso tiraria a proteção do clique, que o
      // usuário ligou de propósito. `--unattended` responde a outra pergunta —
      // "pode rodar sem ninguém por perto" — e devolve o botão ao aceite dele.
      return [
        `error: '${cfg.label}' asks for confirmation on every run, so it cannot be fired`,
        'automatically yet. Let the user allow unattended runs on it',
        `(\`atelier button edit "${cfg.label}" --unattended\`, which sends the button back for`,
        'their approval), or pick another button. Do not use --no-confirm: that would drop the',
        'confirmation on their own clicks too.'
      ].join(' ')
    default:
      return button
  }
}

/** `Mon–Fri`, `daily`, `weekend`, `once`, ou a lista em inglês — o CLI é sempre inglês. */
function englishDaysLabel(days: number): string {
  if (days === ALARM_ONCE) return 'once'
  if (days === ALARM_ALL_DAYS) return 'daily'
  if (days === ALARM_WEEKDAYS) return 'Mon–Fri'
  if (days === ALARM_WEEKEND) return 'weekend'
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const picked: string[] = []
  for (let day = 0; day < 7; day++) {
    if ((days & (1 << day)) !== 0) picked.push(names[day])
  }
  return picked.join(', ')
}

/** Resumo de uma linha do modo ativo, para a resposta e para `list`. */
function describeMode(config: ClockConfig): string {
  switch (config.mode) {
    case 'alarm':
      return `alarm ${formatAlarmTime(config.alarm.minutesOfDay, config.hour12)}, ${englishDaysLabel(config.alarm.days)}`
    case 'timer':
      return `timer ${formatDuration(config.timer.durationMs)}`
    case 'pomodoro':
      return `pomodoro ${formatDuration(config.pomodoro.focusMs)} focus / ${formatDuration(config.pomodoro.breakMs)} break`
    case 'stopwatch':
      return 'stopwatch'
    case 'clock':
      return 'clock'
  }
}

/**
 * Aplica as flags de configuração — as MESMAS em `create` e `set` — a uma
 * config existente. Só toca no que EXECUTA e no que APARECE; o cabo (`--on`
 * / `--off`) e o rótulo (`--name` / `--label`) ficam de fora, porque não são
 * campos de `ClockConfig`.
 *
 * `--at-time` sem `--mode` implica `--mode alarm`: pedir os dois é
 * cerimônia, e esquecer o `--mode` produziria um relógio configurado que não
 * dispara — o pior resultado possível, porque parece certo.
 */
function applyConfigFlags(config: ClockConfig, flags: Map<string, string>, now: number): ClockConfig | string {
  let cfg = config

  const rawMode = flags.get('mode')
  const atTimeRaw = flags.get('at-time')
  const daysRaw = flags.get('days')

  let mode: ClockMode | null = null
  if (rawMode !== undefined) {
    if (!(CLOCK_MODES as string[]).includes(rawMode)) {
      return `error: unknown mode '${rawMode}'. Available: ${CLOCK_MODES.join(', ')}.`
    }
    mode = rawMode as ClockMode
  } else if (atTimeRaw !== undefined) {
    mode = 'alarm'
  }

  let minutesOfDay = cfg.alarm.minutesOfDay
  let days = cfg.alarm.days
  let touchAlarm = false
  if (atTimeRaw !== undefined) {
    const parsed = parseAlarmTime(atTimeRaw)
    if (parsed === null) return "error: --at-time takes HH:MM, as in '08:00'."
    minutesOfDay = parsed
    touchAlarm = true
  }
  if (daysRaw !== undefined) {
    const parsed = parseAlarmDays(daysRaw)
    if (parsed === null) {
      return "error: --days takes 'daily', 'weekdays'/'mon-fri', 'weekend', 'once', or a list like 'mon,wed,fri'."
    }
    days = parsed
    touchAlarm = true
  }

  if (mode !== null) cfg = setMode(cfg, mode)
  if (touchAlarm) cfg = setAlarm(cfg, minutesOfDay, days, now)

  const timerRaw = flags.get('timer')
  if (timerRaw !== undefined) {
    const ms = parseDurationSpec(timerRaw)
    if (ms === null) return "error: --timer takes a duration like '25m', '90s' or '1h30m'."
    cfg = setTimerDuration(cfg, ms)
  }

  const focusRaw = flags.get('focus')
  const breakRaw = flags.get('break')
  if (focusRaw !== undefined || breakRaw !== undefined) {
    let focusMs = cfg.pomodoro.focusMs
    let breakMs = cfg.pomodoro.breakMs
    if (focusRaw !== undefined) {
      const ms = parseDurationSpec(focusRaw)
      if (ms === null) return "error: --focus takes a duration like '25m', '90s' or '1h30m'."
      focusMs = ms
    }
    if (breakRaw !== undefined) {
      const ms = parseDurationSpec(breakRaw)
      if (ms === null) return "error: --break takes a duration like '5m', '90s' or '1h30m'."
      breakMs = ms
    }
    cfg = setPomodoroDurations(cfg, focusMs, breakMs)
  }

  const colorRaw = flags.get('color')
  if (colorRaw !== undefined) cfg = setClockColor(cfg, colorRaw)

  if (flags.get('12h') === '1') cfg = setHour12(cfg, true)
  else if (flags.get('24h') === '1') cfg = setHour12(cfg, false)

  return cfg
}

function createClock(argv: string[], tid: UUID): string {
  const { rest, flags } = takeFlags(argv)
  const label = rest[2] || flags.get('name') || flags.get('label') || ''

  // `--off`/`--disarm` não fazem sentido num relógio que acabou de nascer
  // desarmado — recusar em vez de aceitar em silêncio ensina a gramática
  // certa em vez de deixar o agente achar que fez algo que não fez.
  if (flags.get('off') === '1') {
    return "error: --off applies to `atelier clock set` — a clock is created with no cable unless --on is given."
  }
  if (flags.get('disarm') === '1') {
    return 'error: --disarm applies to `atelier clock set` — a clock is created already DISARMED.'
  }

  let at: { x: number; y: number } | 'invalid' | null = null
  const atRaw = flags.get('at')
  if (atRaw !== undefined) at = parsePoint(atRaw)
  if (at === 'invalid') return 'error: --at takes two numbers, as in `--at 12400,8900`.'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const applied = applyConfigFlags(defaultClockConfig(), flags, Date.now())
  if (typeof applied === 'string') return applied
  const config = applied

  // O alvo do cabo é validado ANTES de criar qualquer coisa: uma recusa não
  // pode deixar para trás um relógio órfão que ninguém pediu.
  const onName = flags.get('on')
  let buttonNode: CanvasNode | null = null
  if (onName !== undefined) {
    const validated = validateButtonTarget(tid, onName)
    if (typeof validated === 'string') return validated
    buttonNode = validated
  }

  const size = defaultSize('widget', { kind: 'clock' })
  if (at) {
    const ocupado = nodeAt(ws, at, size)
    if (ocupado) {
      return [
        `error: (${at.x},${at.y}) is taken by '${nodeDisplayName(ocupado.content)}'`,
        `(${ocupado.content.type}, ${ocupado.id.slice(0, 8)}) at`,
        `(${ocupado.frame.x},${ocupado.frame.y}) ${ocupado.frame.width}×${ocupado.frame.height}.`,
        'Run `atelier node map` for what is where, or drop --at to let the',
        'canvas find a free spot next to this terminal.'
      ].join(' ')
    }
  }
  const spot = at ?? freeSpotRightOf(ws, caller, size)

  const view = writeClockConfig(config)
  if (label) view.name = label

  const node = makeCanvasNode(
    { ...spot, ...size },
    { type: 'widget', value: makeWidgetContent('clock', null, view) }
  )
  ws.addNode(node)
  // Cabo de dados até quem chamou — o mesmo que qualquer outro painel criado
  // por `atelier node create widget` ganha, e é o que faz `atelier list`
  // enxergar o relógio novo.
  ws.addConnection(tid, node.id)
  // O retorno é conferido: `validateButtonTarget` cobre as recusas conhecidas,
  // mas o `WorkspaceManager` é a autoridade e pode negar por um motivo que este
  // binário ainda não conhece. Anunciar um cabo que não existe é pior do que
  // não criar o cabo — o usuário ficaria esperando um disparo.
  const cabled = buttonNode ? ws.addConnection(node.id, buttonNode.id) !== null : false

  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const displayName = nodeDisplayName(node.content)
  const cableDesc = cabled
    ? `cabled to '${nodeDisplayName(buttonNode!.content)}'`
    : buttonNode
      ? `NOT cabled to '${nodeDisplayName(buttonNode.content)}' — the canvas refused the cable`
      : 'not cabled to a button'

  // A resposta diz o estado REAL e o que contar ao usuário: sem isso o
  // agente reporta "criei o relógio", o usuário não vê nada disparar no
  // horário, e a culpa cai no lugar errado.
  const lines = [
    `Created clock '${displayName}' (${node.id.slice(0, 8)}) — ${describeMode(config)}, ${cableDesc}.`
  ]
  if (config.mode === 'alarm') {
    lines.push('It is DISARMED and will not fire: the user has to press Arm on the node.')
    // O que o nó mostra ENQUANTO desarmado é "desarmado" — não a agenda. Dizer
    // que ele mostra o horário faria o agente afirmar ao usuário algo que a
    // tela contradiz, e é a tela que ele vai olhar.
    lines.push(
      buttonNode
        ? `The node reads 'desarmado' until then; the pencil and the cable show ${describeMode(config)} → '${nodeDisplayName(buttonNode.content)}' for them to read first.`
        : `The node reads 'desarmado' until then; the pencil shows ${describeMode(config)}.`
    )
    lines.push(
      cabled
        ? 'Tell them the clock is waiting to be armed.'
        : 'Cable it to a button with `atelier clock set "…" --on "Button"`, then tell the user it is waiting to be armed.'
    )
  } else if (cabled) {
    lines.push(
      "This mode has no Arm switch — it fires the cable on its own run, when the user (or you) starts it from the node."
    )
  }
  return lines.join('\n')
}

/**
 * `atelier clock set "Clock"` — reconfigura um relógio que já está no canvas.
 *
 * Mexer no que EXECUTA (modo, horário, dias, alvo do cabo) desarma de novo,
 * mesmo que já estivesse armado: o usuário leu a agenda antiga quando armou.
 * Mexer só no que APARECE (cor, 12/24 h, o rótulo) não desarma.
 */
function setClock(argv: string[], tid: UUID): string {
  const { rest, flags } = takeFlags(argv)
  const name = rest[2]
  if (!name) return SET_USAGE

  const ws = workspaceForTerminal(tid)
  const node = findClock(tid, name)
  if (!ws || !node || node.content.type !== 'widget') {
    return `error: clock '${name}' not found. Use \`atelier clock list\`.`
  }

  if (flags.get('at') !== undefined) {
    return 'error: --at places a new node — use `atelier node move` to reposition this one.'
  }

  const offRequested = flags.get('off') === '1'
  const onName = flags.get('on')
  if (offRequested && onName !== undefined) {
    return 'error: --on and --off are exclusive — pick one.'
  }

  const before = readClockConfig(node.content.value.view)
  const wasArmed = before.alarm.state === 'armed'

  const applied = applyConfigFlags(before, flags, Date.now())
  if (typeof applied === 'string') return applied
  let config = applied

  let cableChanged = false
  let cableDesc: string | null = null
  if (onName !== undefined) {
    const validated = validateButtonTarget(tid, onName)
    if (typeof validated === 'string') return validated
    // Cortar ANTES de ligar: o `WorkspaceManager` recusa um segundo cabo
    // `clockAction` no mesmo relógio, então a ordem inversa devolveria `null` e
    // o alvo antigo continuaria valendo em silêncio.
    const existing = ws.connectionsFor(node.id).find((c) => c.kind === 'clockAction')
    if (existing) ws.removeConnection(existing.id)
    // O retorno é conferido: `validateButtonTarget` cobre as recusas
    // conhecidas, mas o `WorkspaceManager` é a autoridade e pode negar por um
    // motivo que este binário ainda não conhece. Como o cabo antigo JÁ foi
    // cortado, uma recusa aqui deixa o relógio sem alvo — e dizer isso é o que
    // separa "ficou sem alvo" de "o app engoliu o que eu pedi".
    const linked = ws.addConnection(node.id, validated.id) !== null
    cableChanged = true
    cableDesc = linked
      ? `cabled to '${nodeDisplayName(validated.content)}'`
      : `NOT cabled to '${nodeDisplayName(validated.content)}' — the canvas refused the cable, and the clock is now without a target`
  } else if (offRequested) {
    const existing = ws.connectionsFor(node.id).find((c) => c.kind === 'clockAction')
    if (existing) {
      ws.removeConnection(existing.id)
      cableChanged = true
    }
    cableDesc = 'no longer cabled to a button'
  }

  // "Mexer" é o agente ter USADO a flag — não exige que o valor tenha
  // mudado, pela mesma razão que `button.ts` reabre o aceite mesmo quando o
  // comando novo é igual ao antigo: quem chamou pediu para tocar naquilo.
  const executingChanged =
    flags.get('mode') !== undefined ||
    flags.get('at-time') !== undefined ||
    flags.get('days') !== undefined ||
    cableChanged
  const disarmRequested = flags.get('disarm') === '1'
  const shouldDisarm = executingChanged || disarmRequested
  if (shouldDisarm) config = disarmAlarm(config)

  const nameRaw = flags.get('name') ?? flags.get('label')

  const changed: string[] = []
  if (flags.get('mode') !== undefined) changed.push('mode')
  if (flags.get('at-time') !== undefined) changed.push('at-time')
  if (flags.get('days') !== undefined) changed.push('days')
  if (flags.get('timer') !== undefined) changed.push('timer')
  if (flags.get('focus') !== undefined) changed.push('focus')
  if (flags.get('break') !== undefined) changed.push('break')
  if (flags.get('color') !== undefined) changed.push('color')
  if (flags.get('12h') === '1' || flags.get('24h') === '1') changed.push('hour12')
  if (nameRaw !== undefined) changed.push('name')
  if (cableChanged) changed.push(onName !== undefined ? 'on' : 'off')
  if (disarmRequested && !executingChanged) changed.push('disarm')

  if (changed.length === 0) {
    return `Nothing to change on '${nodeDisplayName(node.content)}'.`
  }

  const view = writeClockConfig(config, node.content.value.view)
  if (nameRaw !== undefined) {
    if (nameRaw) view.name = nameRaw
    else delete view.name
  }

  ws.updateContent(node.id, (n) => {
    if (n.content.type === 'widget') n.content.value.view = view
  })
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  // `node` é a MESMA referência que `ws.updateContent` acabou de mutar — o
  // nome exibido já reflete o `view` novo, inclusive a queda para o rótulo
  // do modo quando `--name ""` limpou o nome.
  const lines = [`Edited clock '${nodeDisplayName(node.content)}' (${changed.join(', ')}).`]
  if (wasArmed && shouldDisarm) {
    lines.push('It is DISARMED again: the user has to press Arm on the node once more.')
  }
  if (cableDesc) lines.push(`It is now ${cableDesc}.`)
  if (config.mode === 'alarm') {
    lines.push(
      config.alarm.state === 'armed'
        ? `It is armed for ${describeMode(config)}.`
        : `It is set to ${describeMode(config)} and reads 'desarmado' on the node until the user arms it.`
    )
  }
  return lines.join('\n')
}

function listClocks(tid: UUID): string {
  const ws = workspaceForTerminal(tid)
  const clocks = clocksOf(tid)
  if (clocks.length === 0) {
    return 'No clocks on this canvas.\nUse `atelier clock create ["Label"] --mode alarm --at-time 08:00` to make one.'
  }
  const lines = ['Clocks on this canvas:']
  for (const node of clocks) {
    if (node.content.type !== 'widget' || !ws) continue
    const config = readClockConfig(node.content.value.view)
    const state = config.mode === 'alarm' ? (alarmIsArmed(config) ? 'armed' : 'disarmed') : '—'
    const cable = ws.connectionsFor(node.id).find((c) => c.kind === 'clockAction')
    const targetId = cable ? (cable.nodeIdA === node.id ? cable.nodeIdB : cable.nodeIdA) : null
    const targetNode = targetId ? ws.node(targetId) : null
    const target = targetNode ? `→ '${nodeDisplayName(targetNode.content)}'` : '→ (none)'
    lines.push(
      `  ${nodeDisplayName(node.content)}  [${config.mode}] ${describeMode(config)}  (${state}, ${target}, ${node.id.slice(0, 8)})`
    )
  }
  return lines.join('\n')
}

function removeClock(argv: string[], tid: UUID): string {
  const name = argv[2]
  if (!name) return 'error: usage: atelier clock remove "Clock"'

  const ws = workspaceForTerminal(tid)
  const node = findClock(tid, name)
  if (!ws || !node || node.content.type !== 'widget') {
    return `error: clock '${name}' not found. Use \`atelier clock list\`.`
  }

  const label = nodeDisplayName(node.content)
  // Um alarme ARMADO é do usuário: armar é o gesto que só ele dá, e apagar o nó
  // desfaria em silêncio a automação que ele autorizou. Mesma linha do
  // `button remove`, que recusa um botão já aceito, e da ausência de
  // `todo delete`. Desarmar continua disponível (`--disarm`), e é o caminho
  // honesto: reduzir capacidade é seguro, apagar a decisão do usuário não.
  const config = readClockConfig(node.content.value.view)
  if (config.mode === 'alarm' && alarmIsArmed(config)) {
    return [
      `error: clock '${label}' is ARMED by the user — only they can remove it.`,
      'Use `atelier clock set "…" --disarm` if it should stop firing, and tell them why.'
    ].join(' ')
  }
  ws.removeNode(node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Removed clock '${label}'.`
}
