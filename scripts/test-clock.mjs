/**
 * Guarda o contrato e a máquina de estados do nó de relógio.
 *
 * Tudo que este arquivo prova é invisível na tela até estar errado: um
 * cronômetro que perde duas horas de app fechado, um timer que chega a
 * `-00:00:01` porque um tique atrasou, um pomodoro que abre seis terminais de
 * uma vez ao acordar de uma suspensão, ou uma chave de `view` gravada por uma
 * versão mais nova apagada no primeiro save.
 *
 * O módulo é PURO e recebe `now` por argumento — é o que permite testar duas
 * horas de tempo de parede e uma suspensão de dois dias sem relógio falso
 * global e sem esperar.
 *
 * As famílias:
 *   1. codec — padrão seguro, round-trip, chave desconhecida atravessando, e a
 *      ausência de qualquer campo derivado por segundo no `view` gravado;
 *   2. cronômetro — tempo de parede, pausa, voltas e o teto de voltas;
 *   3. timer — tique atrasado, pausar/retomar, vencido no boot, vencido vivo;
 *   4. pomodoro — salto longo, coalescência, disparo único e avanço manual.
 *
 * Uso: node scripts/test-clock.mjs
 */
/**
 * O fuso é FIXADO antes de qualquer `Date`, e não por gosto: o alarme é o
 * único modo cuja âncora é uma data CIVIL ("08:00 de segunda"), então metade
 * do que ele promete só é verificável com um fuso conhecido. Os testes dos
 * outros modos não se importam — todos usam `Date.UTC` e durações relativas.
 */
process.env.TZ = 'America/Sao_Paulo'

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-clock-'))
const outfile = join(outdir, 'clock.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export * from './src/shared/clock.ts'
      // O coordenador entra aqui porque não importa React nem toca no DOM por
      // conta própria: ele recebe o contêiner e guarda o que achou dentro dele.
      // É o que permite provar sem janela as promessas do plano — um timeout
      // para todos, escrita só nos montados, contagem que sobrevive ao desmonte
      // e agenda cancelada ao trocar de workspace.
      export { ClockCoordinator, readoutFor } from './src/renderer/state/clock-coordinator.ts'
      // O desenho dos sete segmentos: a tabela de dígitos é a peça que, se
      // errar uma barra, mostra um numeral diferente do que o relogio calculou.
      export { segmentMarkup } from './src/renderer/nodes/seven-segment.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const {
  ClockCoordinator,
  CLOCK_MODES,
  DEFAULT_CLOCK_COLOR,
  DEFAULT_BREAK_MS,
  DEFAULT_FOCUS_MS,
  DEFAULT_TIMER_MS,
  MAX_DURATION_MS,
  MAX_LAPS,
  MIN_DURATION_MS,
  ALARM_ALL_DAYS,
  ALARM_ONCE,
  ALARM_WEEKDAYS,
  ALARM_WEEKEND,
  DEFAULT_ALARM_MINUTES,
  MINUTES_IN_DAY,
  advancePomodoroPhase,
  alarmCountdown,
  alarmDaysLabel,
  alarmSummary,
  armAlarm,
  clockProgress,
  disarmAlarm,
  formatAlarmTime,
  nextAlarmAt,
  parseAlarmDays,
  parseAlarmTime,
  parseDurationSpec,
  setAlarm,
  toggleAlarm,
  defaultClockConfig,
  emitsEvents,
  formatDuration,
  formatStopwatch,
  lapStopwatch,
  nextWakeMs,
  pausePomodoro,
  pauseStopwatch,
  pauseTimer,
  pomodoroRemainingMs,
  readClockConfig,
  readHexColor,
  reconcile,
  setClockColor,
  resetPomodoro,
  resetTimer,
  setMode,
  setPomodoroDurations,
  setTimerDuration,
  startPomodoro,
  startStopwatch,
  startTimer,
  stopwatchElapsedMs,
  timerRemainingMs,
  writeClockConfig,
  readoutFor,
  segmentMarkup
} = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
/** Um instante fixo, para nenhum teste depender de quando ele roda. */
const T0 = Date.UTC(2026, 7, 31, 12, 0, 0)

console.log('\ncodec')

test('view vazio dá o padrão seguro — nada de NaN', () => {
  const c = readClockConfig({})
  assert.equal(c.mode, 'clock')
  assert.equal(c.hour12, false)
  assert.equal(c.timer.durationMs, DEFAULT_TIMER_MS)
  assert.equal(c.pomodoro.focusMs, DEFAULT_FOCUS_MS)
  assert.equal(c.pomodoro.breakMs, DEFAULT_BREAK_MS)
  for (const value of [
    c.stopwatch.accumulatedMs,
    c.stopwatch.startedAt,
    c.timer.deadlineAt,
    c.timer.remainingMs,
    c.pomodoro.deadlineAt,
    c.pomodoro.remainingMs,
    c.pomodoro.cycles
  ]) {
    assert.ok(Number.isFinite(value), `campo derivado virou ${value}`)
  }
})

test('valor inválido, lixo e tipo errado caem no padrão', () => {
  const c = readClockConfig({
    mode: 'sundial',
    swState: 'exploding',
    swAccum: 'abc',
    swLaps: '{isto não é json',
    tDuration: 'NaN',
    tState: '',
    pPhase: 'siesta',
    pCycles: '-7'
  })
  assert.equal(c.mode, 'clock')
  assert.equal(c.stopwatch.state, 'idle')
  assert.equal(c.stopwatch.accumulatedMs, 0)
  assert.deepEqual(c.stopwatch.laps, [])
  assert.equal(c.timer.durationMs, DEFAULT_TIMER_MS)
  assert.equal(c.timer.state, 'idle')
  assert.equal(c.pomodoro.phase, 'focus')
  assert.equal(c.pomodoro.cycles, 0)
})

test('duração fora dos limites é presa no intervalo, nunca rejeitada', () => {
  assert.equal(readClockConfig({ tDuration: '1' }).timer.durationMs, MIN_DURATION_MS)
  assert.equal(readClockConfig({ tDuration: String(9e12) }).timer.durationMs, MAX_DURATION_MS)
  assert.equal(readClockConfig({ pFocus: '0' }).pomodoro.focusMs, MIN_DURATION_MS)
})

test('deadline no futuro absurdo é preso num número finito', () => {
  const c = readClockConfig({ tDeadlineAt: '999999999999999999' })
  assert.ok(Number.isFinite(c.timer.deadlineAt))
  assert.ok(c.timer.deadlineAt <= 4_102_444_800_000)
})

test('cada modo faz round-trip', () => {
  for (const mode of CLOCK_MODES) {
    const view = writeClockConfig({ ...defaultClockConfig(), mode })
    assert.equal(readClockConfig(view).mode, mode, `modo ${mode} não voltou`)
  }
})

test('round-trip completo de um estado rico', () => {
  let c = defaultClockConfig()
  c = setMode(c, 'pomodoro')
  c = setPomodoroDurations(c, 30 * MIN, 7 * MIN)
  c = startPomodoro(c, T0)
  c = advancePomodoroPhase(c, T0 + 5 * MIN)
  c = startStopwatch({ ...c }, T0)
  c = pauseStopwatch(c, T0 + 90 * SEC)
  c = { ...c, stopwatch: { ...c.stopwatch, laps: [1000, 2000, 3000] } }

  const back = readClockConfig(writeClockConfig(c))
  assert.equal(back.mode, 'pomodoro')
  assert.equal(back.pomodoro.focusMs, 30 * MIN)
  assert.equal(back.pomodoro.breakMs, 7 * MIN)
  assert.equal(back.pomodoro.phase, c.pomodoro.phase)
  assert.equal(back.pomodoro.cycles, c.pomodoro.cycles)
  assert.equal(back.pomodoro.sequence, c.pomodoro.sequence)
  assert.equal(back.pomodoro.firedSequence, c.pomodoro.firedSequence)
  assert.equal(back.stopwatch.state, 'paused')
  assert.equal(back.stopwatch.accumulatedMs, 90 * SEC)
  assert.deepEqual(back.stopwatch.laps, [1000, 2000, 3000])
})

test('chave desconhecida de uma versão futura atravessa o save intacta', () => {
  const previous = { mode: 'timer', longBreakEvery: '4', chime: 'bell' }
  const view = writeClockConfig(readClockConfig(previous), previous)
  assert.equal(view.longBreakEvery, '4')
  assert.equal(view.chime, 'bell')
})

test('nenhum campo derivado por segundo aparece no view gravado', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = startTimer(c, T0)
  const view = writeClockConfig(c)
  // O que PODE estar ali é âncora e checkpoint. O que não pode é o valor que o
  // mostrador desenha: gravá-lo sujaria o autosave a cada segundo.
  const permitidas = new Set([
    'mode', 'hour12',
    'swState', 'swAccum', 'swStartedAt', 'swLaps', 'swLastLap',
    'tState', 'tDuration', 'tDeadlineAt', 'tRemaining', 'tGen', 'tFiredGen',
    'pState', 'pFocus', 'pBreak', 'pPhase', 'pDeadlineAt', 'pRemaining',
    'pCycles', 'pGen', 'pSeq', 'pFiredSeq',
    // `aTime` e `aDays` entram por serem CONFIGURAÇÃO, na mesma linha de
    // `tDuration` e `pFocus`: são o que o usuário digitou, não o que o
    // mostrador desenha, e por isso vão sempre — omiti-los por coincidirem com
    // o padrão faria um alarme de 09:00 seg–sex ser indistinguível de um nó
    // nunca configurado, inclusive para o app nativo, que lê o mesmo `view`.
    'aState', 'aTime', 'aDays', 'aArmedAt', 'aFiredAt', 'aMissedAt'
  ])
  for (const key of Object.keys(view)) {
    assert.ok(permitidas.has(key), `chave inesperada no view: ${key}`)
  }
  // E o view não muda quando só o relógio anda.
  const um = writeClockConfig(c)
  const outro = writeClockConfig(reconcile(c, T0 + 3 * SEC, { live: true }).config)
  assert.deepEqual(um, outro)
})

console.log('\ncronômetro')

test('cronômetro running soma duas horas depois de reabrir', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  // O app fechou e voltou duas horas depois. O cronômetro mede tempo de parede,
  // não "tempo em que o renderer recebeu tiques".
  const depois = readClockConfig(writeClockConfig(c))
  assert.equal(stopwatchElapsedMs(depois, T0 + 2 * HOUR), 2 * HOUR)
})

test('cronômetro pausado não soma o intervalo fechado', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  c = pauseStopwatch(c, T0 + 30 * SEC)
  const depois = readClockConfig(writeClockConfig(c))
  assert.equal(stopwatchElapsedMs(depois, T0 + 2 * HOUR), 30 * SEC)
})

test('pausar e retomar não perde nem ganha tempo', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  c = pauseStopwatch(c, T0 + 10 * SEC)
  c = startStopwatch(c, T0 + 60 * SEC)
  assert.equal(stopwatchElapsedMs(c, T0 + 70 * SEC), 20 * SEC)
})

test('relógio do sistema andando para trás não dá decorrido negativo', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  assert.equal(stopwatchElapsedMs(c, T0 - HOUR), 0)
})

test('volta registra a duração desde a volta anterior', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  c = lapStopwatch(c, T0 + 10 * SEC)
  c = lapStopwatch(c, T0 + 25 * SEC)
  c = lapStopwatch(c, T0 + 30 * SEC)
  assert.deepEqual(c.stopwatch.laps, [10 * SEC, 15 * SEC, 5 * SEC])
  // Somadas, elas continuam dando o acumulado — o total permanece derivável.
  assert.equal(
    c.stopwatch.laps.reduce((s, l) => s + l, 0),
    stopwatchElapsedMs(c, T0 + 30 * SEC)
  )
})

test('volta respeita o teto e descarta a mais antiga, não o gesto novo', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  for (let i = 1; i <= MAX_LAPS + 5; i++) c = lapStopwatch(c, T0 + i * SEC)
  assert.equal(c.stopwatch.laps.length, MAX_LAPS)
  // Passado o teto, a volta continua valendo um segundo: a duração é medida
  // contra a âncora da última volta, e não contra a soma de uma lista que já
  // perdeu o começo.
  assert.ok(
    c.stopwatch.laps.every((lap) => lap === SEC),
    `volta com duração errada depois do teto: ${[...new Set(c.stopwatch.laps)].join(', ')}`
  )
  assert.equal(readClockConfig(writeClockConfig(c)).stopwatch.laps.length, MAX_LAPS)
})

test('cronômetro não emite evento nenhum', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  assert.equal(emitsEvents(c), false)
  assert.equal(reconcile(c, T0 + 10 * HOUR, { live: true }).event, null)
})

console.log('\ntimer')

test('timer atrasado chega exatamente a zero, mesmo com tiques irregulares', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, 10 * SEC)
  c = startTimer(c, T0)
  // Tiques atrasados e desalinhados: 380 ms de atraso não podem virar 380 ms de
  // erro carregado adiante.
  for (const atraso of [1380, 2100, 4990, 7333, 9001]) {
    assert.equal(timerRemainingMs(c, T0 + atraso), 10 * SEC - atraso)
  }
  assert.equal(timerRemainingMs(c, T0 + 10 * SEC), 0)
  assert.equal(timerRemainingMs(c, T0 + 30 * SEC), 0)
})

test('pausar troca deadline por restante, e retomar troca de volta', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, 5 * MIN)
  c = startTimer(c, T0)
  c = pauseTimer(c, T0 + 2 * MIN)
  assert.equal(c.timer.remainingMs, 3 * MIN)
  assert.equal(c.timer.deadlineAt, 0)
  // Uma hora parado; retomar nasce um deadline NOVO a partir do agora.
  c = startTimer(c, T0 + HOUR)
  assert.equal(c.timer.deadlineAt, T0 + HOUR + 3 * MIN)
  assert.equal(timerRemainingMs(c, T0 + HOUR + MIN), 2 * MIN)
})

test('editar a duração não mexe num timer em andamento', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, 10 * MIN)
  c = startTimer(c, T0)
  const antes = c.timer.deadlineAt
  c = setTimerDuration(c, 3 * MIN)
  assert.equal(c.timer.deadlineAt, antes, 'a corrida atual foi alterada em silêncio')
  assert.equal(c.timer.durationMs, 3 * MIN)
  // Zerar é o gesto que adota a duração nova.
  c = resetTimer(c)
  assert.equal(timerRemainingMs(c, T0), 3 * MIN)
})

test('timer vencido no boot vira finished SEM evento', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, 5 * MIN)
  c = startTimer(c, T0)
  // O app fechou. Reabre uma hora depois: `live: false`.
  const salvo = readClockConfig(writeClockConfig(c))
  const r = reconcile(salvo, T0 + HOUR, { live: false })
  assert.equal(r.config.timer.state, 'finished')
  assert.equal(r.changed, true)
  assert.equal(r.event, null, 'disparou uma ação retroativa')
  // E não pode disparar no tique seguinte, já vivo.
  const depois = reconcile(r.config, T0 + HOUR + SEC, { live: true })
  assert.equal(depois.event, null)
})

test('timer vencido com o processo vivo emite UM evento', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, 5 * MIN)
  c = startTimer(c, T0)
  // Máquina suspensa por dois dias com o Atelier aberto: no resume, o processo
  // e a intenção de automação continuaram vivos.
  const r = reconcile(c, T0 + 2 * 24 * HOUR, { live: true })
  assert.equal(r.config.timer.state, 'finished')
  assert.equal(r.event.kind, 'timerFinished')
  assert.equal(r.event.generation, c.timer.generation)
  assert.equal(r.event.crossed, 1)
})

test('uma transição já tratada não dispara de novo no tique seguinte', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, MIN)
  c = startTimer(c, T0)
  const primeiro = reconcile(c, T0 + MIN, { live: true })
  assert.ok(primeiro.event)
  for (const t of [T0 + MIN + SEC, T0 + 2 * MIN, T0 + HOUR]) {
    assert.equal(reconcile(primeiro.config, t, { live: true }).event, null)
  }
})

test('zerar abre geração nova, e o fim seguinte dispara de novo', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, MIN)
  c = startTimer(c, T0)
  const um = reconcile(c, T0 + MIN, { live: true })
  assert.equal(um.event.generation, 0)

  let d = resetTimer(um.config)
  d = startTimer(d, T0 + 10 * MIN)
  const dois = reconcile(d, T0 + 11 * MIN, { live: true })
  assert.ok(dois.event, 'a geração nova não disparou')
  assert.equal(dois.event.generation, 1)
})

test('progresso do timer fica entre 0 e 1 e nunca é NaN', () => {
  let c = setMode(defaultClockConfig(), 'timer')
  c = setTimerDuration(c, 4 * MIN)
  c = startTimer(c, T0)
  assert.equal(clockProgress(c, T0), 0)
  assert.equal(clockProgress(c, T0 + 2 * MIN), 0.5)
  assert.equal(clockProgress(c, T0 + 10 * MIN), 1)
})

console.log('\npomodoro')

test('pomodoro calcula fase e ciclos depois de um salto longo', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = setPomodoroDurations(c, 25 * MIN, 5 * MIN)
  c = startPomodoro(c, T0)
  // O ciclo é de 30min (25 de foco + 5 de pausa). Os focos terminam em 25, 55,
  // 85 e 115 minutos; em 118min estamos DENTRO da quarta pausa, que vai de 115
  // a 120, com quatro focos concluídos e dois minutos para o próximo foco.
  const r = reconcile(c, T0 + 118 * MIN, { live: true })
  assert.equal(r.config.pomodoro.cycles, 4)
  assert.equal(r.config.pomodoro.phase, 'break')
  assert.equal(pomodoroRemainingMs(r.config, T0 + 118 * MIN), 2 * MIN)
})

test('o ciclo é contado quando o FOCO termina, não quando começa', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = setPomodoroDurations(c, 25 * MIN, 5 * MIN)
  c = startPomodoro(c, T0)
  // Um minuto antes do fim do primeiro foco: nada concluído ainda.
  assert.equal(reconcile(c, T0 + 24 * MIN, { live: true }).config.pomodoro.cycles, 0)
  // Um minuto depois: um ciclo.
  assert.equal(reconcile(c, T0 + 26 * MIN, { live: true }).config.pomodoro.cycles, 1)
})

test('várias fases atravessadas em suspensão geram UM evento coalescido', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = setPomodoroDurations(c, 25 * MIN, 5 * MIN)
  c = startPomodoro(c, T0)
  const r = reconcile(c, T0 + 118 * MIN, { live: true })
  assert.equal(r.event.kind, 'phaseChanged')
  assert.ok(r.event.crossed > 1, 'o teste não atravessou mais de uma fronteira')
  assert.equal(r.event.sequence, r.config.pomodoro.sequence)
  assert.equal(r.event.phase, r.config.pomodoro.phase)
  // O evento é UM: não há um segundo pendente para o tique seguinte.
  assert.equal(reconcile(r.config, T0 + 118 * MIN + SEC, { live: true }).event, null)
})

test('pomodoro vencido com o app fechado avança sem reproduzir transições', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = setPomodoroDurations(c, 25 * MIN, 5 * MIN)
  c = startPomodoro(c, T0)
  const salvo = readClockConfig(writeClockConfig(c))
  const r = reconcile(salvo, T0 + 3 * HOUR, { live: false })
  assert.ok(r.config.pomodoro.cycles > 0, 'a contagem não acompanhou o agora')
  assert.equal(r.event, null, 'abriu vários terminais de uma vez ao reabrir')
  assert.equal(reconcile(r.config, T0 + 3 * HOUR + SEC, { live: true }).event, null)
})

test('avançar fase é gesto manual e NÃO dispara o botão', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = startPomodoro(c, T0)
  c = advancePomodoroPhase(c, T0 + MIN)
  assert.equal(c.pomodoro.phase, 'break')
  assert.equal(c.pomodoro.cycles, 1)
  assert.equal(c.pomodoro.firedSequence, c.pomodoro.sequence)
  assert.equal(reconcile(c, T0 + MIN + SEC, { live: true }).event, null)
})

test('pausar e retomar o pomodoro preserva o restante da fase', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = setPomodoroDurations(c, 25 * MIN, 5 * MIN)
  c = startPomodoro(c, T0)
  c = pausePomodoro(c, T0 + 10 * MIN)
  assert.equal(c.pomodoro.remainingMs, 15 * MIN)
  c = startPomodoro(c, T0 + 3 * HOUR)
  assert.equal(pomodoroRemainingMs(c, T0 + 3 * HOUR), 15 * MIN)
  // E pausado ele não reconcilia nada, por mais tempo que passe.
  const pausado = pausePomodoro(c, T0 + 3 * HOUR)
  assert.equal(reconcile(pausado, T0 + 30 * HOUR, { live: true }).event, null)
})

test('zerar ciclos volta ao foco e abre geração nova', () => {
  let c = setMode(defaultClockConfig(), 'pomodoro')
  c = startPomodoro(c, T0)
  c = reconcile(c, T0 + 2 * HOUR, { live: true }).config
  const antes = c.pomodoro.generation
  c = resetPomodoro(c)
  assert.equal(c.pomodoro.cycles, 0)
  assert.equal(c.pomodoro.phase, 'focus')
  assert.equal(c.pomodoro.sequence, 0)
  assert.equal(c.pomodoro.generation, antes + 1)
})

console.log('\nagenda e apresentação')

test('só timer e pomodoro emitem', () => {
  const base = defaultClockConfig()
  assert.equal(emitsEvents(setMode(base, 'clock')), false)
  assert.equal(emitsEvents(setMode(base, 'stopwatch')), false)
  assert.equal(emitsEvents(setMode(base, 'timer')), true)
  assert.equal(emitsEvents(setMode(base, 'pomodoro')), true)
})

test('o próximo despertar alinha ao segundo, e ao deadline quando ele é antes', () => {
  const relogio = setMode(defaultClockConfig(), 'clock')
  assert.equal(nextWakeMs(relogio, T0 + 250), 750)
  assert.equal(nextWakeMs(relogio, T0), 1000)

  // Cronômetro parado e timer parado não pedem despertar nenhum.
  assert.equal(nextWakeMs(setMode(defaultClockConfig(), 'stopwatch'), T0), null)
  assert.equal(nextWakeMs(setMode(defaultClockConfig(), 'timer'), T0), null)

  // Deadline a 300 ms não espera o segundo cheio para virar `finished`.
  let t = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
  t = startTimer(t, T0)
  assert.equal(nextWakeMs(t, T0 + MIN - 300), 300)
})

test('formatação nunca produz NaN nem número negativo', () => {
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(-5000), '00:00')
  assert.equal(formatDuration(NaN), '00:00')
  assert.equal(formatDuration(59 * SEC), '00:59')
  assert.equal(formatDuration(90 * SEC), '01:30')
  assert.equal(formatDuration(HOUR + 2 * MIN + 3 * SEC), '1:02:03')
  assert.equal(formatStopwatch(1234), '00:01,23')
  assert.equal(formatStopwatch(NaN), '00:00,00')
})

test('trocar de modo não apaga o estado dos outros', () => {
  let c = setMode(defaultClockConfig(), 'stopwatch')
  c = startStopwatch(c, T0)
  c = pauseStopwatch(c, T0 + 42 * SEC)
  c = setMode(c, 'clock')
  assert.equal(c.stopwatch.state, 'paused')
  assert.equal(c.stopwatch.accumulatedMs, 42 * SEC)
  // E, fora do modo ativo, o timer não emite mesmo tendo vencido.
  let d = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
  d = startTimer(d, T0)
  d = setMode(d, 'clock')
  assert.equal(reconcile(d, T0 + HOUR, { live: true }).event, null)
})

console.log('\ncoordenador')

/**
 * Um elemento de mentira com só o que o coordenador usa. Não é um DOM: é o
 * contrato mínimo — `querySelector`, `isConnected`, `textContent`, `style` e os
 * dois setters de atributo.
 */
function fakeElement(marker) {
  return {
    marker,
    isConnected: true,
    textContent: '',
    // O coordenador escreve o valor num `data-` em vez de reler o texto: num
    // mostrador de sete segmentos o conteúdo é SVG, e `textContent` não
    // descreveria mais o que está na tela.
    dataset: {},
    innerHTML: '',
    style: {},
    attrs: {},
    hasAttribute(k) {
      return k in this.attrs
    },
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    removeAttribute(k) {
      delete this.attrs[k]
    }
  }
}

function fakeContainer() {
  const readout = fakeElement('readout')
  const detail = fakeElement('detail')
  const progress = fakeElement('progress')
  const container = fakeElement('container')
  container.querySelector = (sel) =>
    sel.includes('readout') ? readout : sel.includes('detail') ? detail : progress
  return { container, readout, detail, progress }
}

/** Um nó de relógio pronto para `setWorkspace`. */
function clockNode(id, config) {
  return {
    id,
    content: { type: 'widget', value: { kind: 'clock', view: writeClockConfig(config) } }
  }
}

const BUTTON_NODE = { id: 'BTN', content: { type: 'widget', value: { kind: 'button', view: {} } } }
const CABLE = [{ id: 'CABO', kind: 'clockAction', nodeIdA: 'CLOCK', nodeIdB: 'BTN' }]

function stubHost() {
  const calls = { patches: [], runs: [], statuses: [] }
  return {
    calls,
    patchView: async (nodeId, view) => void calls.patches.push({ nodeId, view }),
    runButton: async (nodeId, opts) => {
      calls.runs.push({ nodeId, opts })
      return true
    },
    setConnectionStatus: (id, status) => void calls.statuses.push({ id, status }),
    notice: () => {}
  }
}

/** Conta os timers que o coordenador arma, sem esperar nenhum deles disparar. */
function withTimerSpy(fn) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const armed = []
  globalThis.setTimeout = (cb, ms) => {
    const handle = { cb, ms, cancelled: false }
    armed.push(handle)
    return handle
  }
  globalThis.clearTimeout = (h) => {
    if (h && typeof h === 'object') h.cancelled = true
  }
  try {
    return { armed, result: fn() }
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
}

test('dez relógios registrados produzem UM único timeout', () => {
  const nodes = []
  for (let i = 0; i < 10; i++) nodes.push(clockNode(`N${i}`, setMode(defaultClockConfig(), 'clock')))
  const { armed } = withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(stubHost())
    c.setWorkspace('WS', nodes, [])
    return c
  })
  const vivos = armed.filter((t) => !t.cancelled)
  assert.equal(vivos.length, 1, `armou ${vivos.length} timers para dez relógios`)
})

test('somente os refs montados recebem escrita visual', () => {
  const montado = fakeContainer()
  const nodes = [
    clockNode('MONTADO', setMode(defaultClockConfig(), 'clock')),
    clockNode('CULLED', setMode(defaultClockConfig(), 'clock'))
  ]
  withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(stubHost())
    c.setWorkspace('WS', nodes, [])
    // O segundo nó nunca montou (culling do viewport): pintar sem elemento não
    // pode explodir nem impedir o primeiro de receber texto.
    c.register('MONTADO', montado.container)
    return c
  })
  assert.ok(montado.readout.textContent.length > 0, 'o nó montado não recebeu texto')
  assert.equal(montado.readout.attrs['aria-label'], montado.readout.textContent)
})

test('o readout decide o formato: segmentos quando pede, texto quando não', () => {
  const texto = fakeContainer()
  const leds = fakeContainer()
  leds.readout.setAttribute('data-clock-segments', '')

  withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(stubHost())
    c.setWorkspace('WS', [clockNode('A', setMode(defaultClockConfig(), 'clock'))], [])
    c.register('A', texto.container)
    c.setWorkspace('WS2', [clockNode('B', setMode(defaultClockConfig(), 'clock'))], [])
    c.register('B', leds.container)
    return c
  })

  assert.ok(texto.readout.textContent.length > 0, 'o readout de texto ficou vazio')
  assert.equal(texto.readout.innerHTML, '', 'escreveu SVG num readout que não pediu')
  assert.ok(leds.readout.innerHTML.includes('<polygon'), 'o readout de LEDs não recebeu segmentos')
  // O rótulo acessível é o MESMO nos dois: num mostrador de segmentos ele é a
  // única leitura possível, já que o SVG é aria-hidden.
  assert.ok(leds.readout.attrs['aria-label'].length > 0)
})

test('desmontar um nó NÃO interrompe o timer nem o disparo conectado', () => {
  const host = stubHost()
  const agora = Date.now()
  let vencido = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
  vencido = startTimer(vencido, agora - 2 * MIN)

  withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(host)
    // Primeira passagem: workspace recém-aberto, reconcilia sem disparar.
    c.setWorkspace('WS', [clockNode('CLOCK', vencido), BUTTON_NODE], CABLE)
    // Agora um timer que vence com o processo VIVO, e nenhum widget montado.
    let vivo = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
    vivo = startTimer(vivo, agora - MIN)
    c.setWorkspace('WS', [clockNode('CLOCK', vivo), BUTTON_NODE], CABLE)
    c.resume()
    return c
  })
  assert.equal(host.calls.runs.length, 1, `disparou ${host.calls.runs.length} vezes`)
  assert.equal(host.calls.runs[0].nodeId, 'BTN')
  assert.equal(host.calls.runs[0].opts.origin, 'clock')
  // O checkpoint foi ao disco ANTES da ação: execução no máximo uma vez.
  assert.ok(host.calls.patches.length > 0, 'não persistiu o checkpoint')
  // E o cabo pulsou.
  assert.ok(host.calls.statuses.some((s) => s.status === 'communicating'))
})

test('o primeiro cálculo de um workspace recém-aberto não dispara nada', () => {
  const host = stubHost()
  let timer = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
  timer = startTimer(timer, Date.now() - 3 * HOUR)
  withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(host)
    c.setWorkspace('WS', [clockNode('CLOCK', timer), BUTTON_NODE], CABLE)
    return c
  })
  assert.equal(host.calls.runs.length, 0, 'disparou uma ação retroativa ao abrir o app')
})

test('trocar de workspace cancela a agenda antiga', () => {
  const { armed } = withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(stubHost())
    c.setWorkspace('WS-A', [clockNode('A', setMode(defaultClockConfig(), 'clock'))], [])
    c.setWorkspace('WS-B', [clockNode('B', setMode(defaultClockConfig(), 'clock'))], [])
    return c
  })
  const vivos = armed.filter((t) => !t.cancelled)
  assert.equal(vivos.length, 1, 'a agenda do workspace anterior continuou armada')
})

test('relógio sem cabo conta e não dispara nada', () => {
  const host = stubHost()
  let timer = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
  timer = startTimer(timer, Date.now() - 10 * SEC)
  withTimerSpy(() => {
    const c = new ClockCoordinator()
    c.attach(host)
    c.setWorkspace('WS', [clockNode('CLOCK', timer)], [])
    let vencido = setTimerDuration(setMode(defaultClockConfig(), 'timer'), MIN)
    vencido = startTimer(vencido, Date.now() - 2 * MIN)
    c.setWorkspace('WS', [clockNode('CLOCK', vencido)], [])
    c.resume()
    return c
  })
  assert.equal(host.calls.runs.length, 0)
})

test('o primeiro render e o primeiro tique dizem a MESMA coisa', () => {
  // Duas fórmulas equivalentes não bastam: bastaria uma divergir de um
  // caractere para o nó piscar um valor errado até o primeiro tique. Por isso o
  // widget importa `readoutFor` do coordenador em vez de ter a sua.
  let config = setMode(defaultClockConfig(), 'pomodoro')
  config = startPomodoro(config, T0)
  const um = readoutFor(config, T0 + 3 * MIN)
  const dois = readoutFor(config, T0 + 3 * MIN)
  assert.deepEqual(um, dois)
  assert.equal(um.readout, formatDuration(pomodoroRemainingMs(config, T0 + 3 * MIN)))
  assert.ok(um.detail.includes('foco'))
})

console.log('\nsete segmentos')

/** Quantas barras estão ACESAS no n-ésimo dígito do markup. */
function litOf(markup) {
  return markup
    .split('<svg')
    .slice(1)
    .map((svg) => (svg.match(/class="seg on"/g) ?? []).length)
}

test('cada dígito acende o número certo de barras', () => {
  // A contagem é o que um erro de tabela quebra primeiro, e é verificável sem
  // reimplementar o desenho: 1 tem duas barras, 7 tem três, 8 tem as sete.
  const esperado = { '0': 6, '1': 2, '2': 5, '3': 5, '4': 4, '5': 5, '6': 6, '7': 3, '8': 7, '9': 6 }
  for (const [char, barras] of Object.entries(esperado)) {
    assert.deepEqual(litOf(segmentMarkup(char)), [barras], `dígito ${char}`)
  }
})

test('as SETE barras são sempre desenhadas — o fantasma do 8 fica atrás', () => {
  // É isto que separa um display de LED de um corpo de letra: a barra apagada
  // continua na tela. Sem ela o mostrador vira só um número estilizado.
  for (let d = 0; d <= 9; d++) {
    const svg = segmentMarkup(String(d))
    assert.equal((svg.match(/<polygon/g) ?? []).length, 7, `dígito ${d} não desenhou 7 barras`)
  }
})

test('o 6 e o 9 não são um 8 com barra faltando por acidente', () => {
  // Os dois pares que um erro de tabela confunde: 6/8 e 9/8 diferem de UMA
  // barra, e trocá-las mostra o numeral errado sem quebrar nada visivelmente.
  assert.notEqual(segmentMarkup('6'), segmentMarkup('8'))
  assert.notEqual(segmentMarkup('9'), segmentMarkup('8'))
  assert.notEqual(segmentMarkup('6'), segmentMarkup('9'))
})

test('separadores entram, e o que não é dígito nem separador é ignorado', () => {
  assert.ok(segmentMarkup(':').includes('sseg-colon'))
  assert.ok(segmentMarkup(',').includes('sseg-colon'))
  // Nada digitado pelo usuário chega aqui, e o conjunto fechado de entradas é o
  // que torna o `innerHTML` seguro sem um passo de escape.
  assert.equal(segmentMarkup('<script>alert(1)</script>'), segmentMarkup('1'))
  assert.equal(segmentMarkup('foco'), '')
})

test('o mostrador inteiro do timer sai com um SVG por caractere', () => {
  const markup = segmentMarkup(formatDuration(25 * MIN))
  // '25:00' = quatro dígitos e um separador.
  assert.equal((markup.match(/<svg/g) ?? []).length, 5)
  assert.equal((markup.match(/class="sseg-digit"/g) ?? []).length, 4)
})

console.log('\ncor do mostrador')

test('cor ausente ou inválida cai no padrão — nunca vai lixo para o style', () => {
  // Este valor vira uma custom property escrita no `style` de um elemento, e o
  // caminho até lá inclui um `view` lido do disco. A validação estreita é o que
  // impede um arquivo de workspace de decidir o que entra ali.
  assert.equal(readClockConfig({}).color, DEFAULT_CLOCK_COLOR)
  for (const lixo of ['', 'red', 'javascript:alert(1)', '#12', '#1234567', 'rgb(1,2,3)', '#ggg']) {
    assert.equal(readHexColor(lixo), DEFAULT_CLOCK_COLOR, `aceitou ${JSON.stringify(lixo)}`)
  }
})

test('a forma curta #rgb é expandida, não recusada', () => {
  // É o que um humano digita, e recusá-la só devolveria vermelho sem explicar.
  assert.equal(readHexColor('#0f8'), '#00ff88')
  assert.equal(readHexColor('#FFF'), '#ffffff')
})

test('a cor faz round-trip e o padrão não ocupa espaço no view', () => {
  const ambar = setClockColor(defaultClockConfig(), '#FFB02E')
  assert.equal(ambar.color, '#ffb02e', 'não normalizou para minúsculas')
  assert.equal(readClockConfig(writeClockConfig(ambar)).color, '#ffb02e')
  // A cor padrão é OMITIDA: um `view` enxuto é o que o app nativo e o diff do
  // arquivo mostram, a mesma disciplina do resto do codec.
  assert.equal(writeClockConfig(defaultClockConfig()).color, undefined)
})

test('trocar a cor não mexe em corrida nenhuma', () => {
  // A cor é aparência: um relógio correndo não pode ser afetado por ela, senão
  // uma escolha de gosto viraria uma perda de tempo medido.
  let c = setTimerDuration(setMode(defaultClockConfig(), 'timer'), 10 * MIN)
  c = startTimer(c, T0)
  const antes = c.timer.deadlineAt
  const depois = setClockColor(c, '#32d74b')
  assert.equal(depois.timer.deadlineAt, antes)
  assert.equal(depois.timer.state, 'running')
  assert.equal(timerRemainingMs(depois, T0 + MIN), 9 * MIN)
})


// ─── 5. Alarme ────────────────────────────────────────────────────────────────
// O quinto modo, e o primeiro cuja âncora é uma data CIVIL em vez de uma
// duração. O que estes testes guardam é justamente o que a aritmética de
// milissegundos erraria: o dia da semana certo, o horário que não anda com o
// horário de verão, o disparo único, e a coalescência de um fim de semana
// inteiro com o app suspenso.
//
// `T0` é segunda, 31/08/2026, 09:00 em America/Sao_Paulo (o fuso fixado no topo
// deste arquivo).

/** Um alarme em `hh:mm` nos dias `days`, já no modo alarme. */
function alarmAt(hh, mm, days) {
  const base = setMode(defaultClockConfig(), 'alarm')
  return setAlarm(base, hh * 60 + mm, days, T0)
}

const SEG_A_SEX = ALARM_WEEKDAYS

test('T0 é segunda 09:00 local — a premissa dos testes de alarme', () => {
  const at = new Date(T0)
  assert.equal(at.getDay(), 1, 'T0 deixou de ser segunda; revise os testes abaixo')
  assert.equal(at.getHours(), 9)
})

test('nextAlarmAt pega HOJE quando o horário ainda não passou', () => {
  const c = alarmAt(10, 0, SEG_A_SEX)
  assert.equal(nextAlarmAt(c, T0), new Date(2026, 7, 31, 10, 0, 0, 0).getTime())
})

test('nextAlarmAt pula para amanhã quando o horário já passou', () => {
  const c = alarmAt(8, 0, SEG_A_SEX)
  // Terça, 01/09 — e não "T0 mais 24 h", que é a conta que erra na virada.
  assert.equal(nextAlarmAt(c, T0), new Date(2026, 8, 1, 8, 0, 0, 0).getTime())
})

test('nextAlarmAt pula os dias NÃO marcados', () => {
  const soSabado = alarmAt(8, 0, 1 << 6)
  assert.equal(nextAlarmAt(soSabado, T0), new Date(2026, 8, 5, 8, 0, 0, 0).getTime())
  // Fim de semana a partir de uma segunda: o sábado vem antes do domingo.
  const fds = alarmAt(8, 0, ALARM_WEEKEND)
  assert.equal(nextAlarmAt(fds, T0), new Date(2026, 8, 5, 8, 0, 0, 0).getTime())
})

test('nextAlarmAt acha a ocorrência da semana que vem quando o único dia é hoje', () => {
  // O caso que uma varredura de sete dias perderia: segunda 08:00 já passou, e
  // o próximo candidato do mesmo dia da semana é o OITAVO dia.
  const soSegunda = alarmAt(8, 0, 1 << 1)
  assert.equal(nextAlarmAt(soSegunda, T0), new Date(2026, 8, 7, 8, 0, 0, 0).getTime())
})

test('sem dia marcado é UMA vez: hoje se ainda não passou, senão amanhã', () => {
  assert.equal(nextAlarmAt(alarmAt(10, 0, ALARM_ONCE), T0), new Date(2026, 7, 31, 10, 0, 0, 0).getTime())
  assert.equal(nextAlarmAt(alarmAt(8, 0, ALARM_ONCE), T0), new Date(2026, 8, 1, 8, 0, 0, 0).getTime())
})

test('a ocorrência atravessa a virada de mês e de ano sem aritmética de 24 h', () => {
  const virada = Date.UTC(2026, 11, 31, 12, 0, 0) // 31/12 09:00 local, quinta
  const c = setAlarm(setMode(defaultClockConfig(), 'alarm'), 10 * 60, ALARM_ALL_DAYS, virada)
  assert.equal(nextAlarmAt(c, virada), new Date(2026, 11, 31, 10, 0, 0, 0).getTime())
  const depois = nextAlarmAt(c, new Date(2026, 11, 31, 10, 0, 0, 1).getTime())
  assert.equal(depois, new Date(2027, 0, 1, 10, 0, 0, 0).getTime())
})

test('o horário de verão NÃO desloca o alarme: 08:00 continua 08:00', () => {
  // Brasília não tem horário de verão desde 2019, então este é o único teste
  // que troca de fuso — e ele existe porque `armedAt + 24h` erraria por uma
  // hora duas vezes por ano, num bug que ninguém consegue reproduzir.
  const antes = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    // Sábado 07/03/2026 09:00 EST; o salto para frente é no domingo 08/03 às 02:00.
    const from = new Date(2026, 2, 7, 9, 0, 0, 0).getTime()
    const c = setAlarm(setMode(defaultClockConfig(), 'alarm'), 8 * 60, ALARM_ALL_DAYS, from)
    const proxima = nextAlarmAt(c, from)
    assert.equal(proxima, new Date(2026, 2, 8, 8, 0, 0, 0).getTime())
    assert.equal(new Date(proxima).getHours(), 8, 'o alarme andou com o relógio')
    // E a prova de que não é soma de 24 h: de 09:00 de sábado às 08:00 de
    // domingo são 23 horas de PAREDE, e o salto come uma delas — 22 horas
    // absolutas. É exatamente esse desconto que uma soma de milissegundos
    // ignoraria, deslocando o alarme para as 09:00 no dia seguinte.
    assert.equal(proxima - from, 22 * HOUR)
  } finally {
    process.env.TZ = antes
  }
})

test('um horário que NÃO existe no dia do salto sai na hora seguinte, uma vez', () => {
  const antes = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const from = new Date(2026, 2, 8, 0, 0, 0, 0).getTime()
    const c = setAlarm(setMode(defaultClockConfig(), 'alarm'), 2 * 60 + 30, ALARM_ALL_DAYS, from)
    const proxima = new Date(nextAlarmAt(c, from))
    // 02:30 não existe naquele domingo: `Date` normaliza para 03:30. Pular o
    // dia deixaria um alarme diário simplesmente sem tocar, que é pior.
    assert.equal(proxima.getHours(), 3)
    assert.equal(proxima.getMinutes(), 30)
    assert.equal(proxima.getDate(), 8)
  } finally {
    process.env.TZ = antes
  }
})

test('o codec do alarme faz round-trip e preserva chave desconhecida', () => {
  let c = alarmAt(8, 30, SEG_A_SEX)
  c = armAlarm(c, T0)
  const view = writeClockConfig(c, { aFuturo: 'de uma versão mais nova' })
  assert.equal(view.aFuturo, 'de uma versão mais nova', 'apagou chave desconhecida')
  const volta = readClockConfig(view)
  assert.equal(volta.alarm.state, 'armed')
  assert.equal(volta.alarm.minutesOfDay, 8 * 60 + 30)
  assert.equal(volta.alarm.days, SEG_A_SEX)
  assert.equal(volta.alarm.armedAt, c.alarm.armedAt)
  assert.equal(volta.mode, 'alarm')
})

test('o codec do alarme recusa valores tortos sem inventar um alarme novo', () => {
  const d = defaultClockConfig()
  // Duas políticas diferentes, e as duas são as do resto do codec (`int`):
  // número fora de faixa é PRESO no limite, e o que não é número cai no padrão.
  // A distinção importa — `aTime: '9999'` é um valor exagerado, e 23:59 é a
  // leitura mais próxima dele; `aTime: 'oito'` não é um horário nenhum.
  assert.equal(readClockConfig({ mode: 'alarm', aTime: '9999' }).alarm.minutesOfDay, MINUTES_IN_DAY - 1)
  assert.equal(readClockConfig({ mode: 'alarm', aTime: 'oito' }).alarm.minutesOfDay, d.alarm.minutesOfDay)
  // `aDays` preso no teto é "todos os dias" — e o que importa é que NÃO caia em
  // zero, porque zero significa "uma vez", um comportamento próprio.
  assert.equal(readClockConfig({ mode: 'alarm', aDays: '999' }).alarm.days, ALARM_ALL_DAYS)
  assert.equal(readClockConfig({ mode: 'alarm', aDays: 'seg' }).alarm.days, d.alarm.days)
  assert.equal(readClockConfig({ mode: 'alarm', aState: 'tocando' }).alarm.state, 'idle')
  // `aDays: '0'` é legítimo — é o alarme de uma vez, não um valor corrompido.
  assert.equal(readClockConfig({ mode: 'alarm', aDays: '0' }).alarm.days, ALARM_ONCE)
})

test('nada derivado por segundo entra no view do alarme', () => {
  const c = armAlarm(alarmAt(8, 0, SEG_A_SEX), T0)
  const view = writeClockConfig(c)
  for (const key of Object.keys(view)) {
    assert.ok(
      ['mode', 'hour12', 'color', 'tDuration', 'pFocus', 'pBreak', 'aState', 'aTime', 'aDays', 'aArmedAt', 'aFiredAt', 'aMissedAt'].includes(key),
      `chave inesperada no view: ${key}`
    )
  }
})

test('um alarme desarmado nunca dispara', () => {
  const c = alarmAt(10, 0, SEG_A_SEX)
  const r = reconcile(c, T0 + 2 * HOUR, { live: true })
  assert.equal(r.event, null)
  assert.equal(r.changed, false)
})

test('armar não dispara nada, só ancora a próxima ocorrência', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  assert.equal(c.alarm.state, 'armed')
  assert.equal(c.alarm.armedAt, new Date(2026, 7, 31, 10, 0, 0, 0).getTime())
  const r = reconcile(c, T0, { live: true })
  assert.equal(r.event, null)
})

test('vencido com o app VIVO dispara uma vez, e só uma', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  const agora = c.alarm.armedAt + 2 * SEC
  const primeiro = reconcile(c, agora, { live: true })
  assert.equal(primeiro.event?.kind, 'alarmFired')
  assert.equal(primeiro.event.sequence, c.alarm.armedAt, 'a identidade do evento é a ocorrência')
  assert.equal(primeiro.config.alarm.firedAt, c.alarm.armedAt)
  // O MESMO tique de novo, sobre a configuração já reconciliada: nada.
  const segundo = reconcile(primeiro.config, agora, { live: true })
  assert.equal(segundo.event, null)
})

test('vencido com o app FECHADO reconcilia, marca perdido e não dispara', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  const ocorrencia = c.alarm.armedAt
  const morto = reconcile(c, ocorrencia + 3 * HOUR, { live: false })
  assert.equal(morto.event, null, 'disparou retroativamente')
  assert.equal(morto.changed, true)
  assert.equal(morto.config.alarm.missedAt, ocorrencia)
  assert.equal(morto.config.alarm.firedAt, ocorrencia)
  // E o primeiro tique VIVO depois disso também não dispara a ocorrência morta.
  const depois = reconcile(morto.config, ocorrencia + 3 * HOUR + SEC, { live: true })
  assert.equal(depois.event, null)
})

test('depois de disparar, um alarme repetido já está armado na PRÓXIMA ocorrência', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  const r = reconcile(c, c.alarm.armedAt + SEC, { live: true })
  assert.equal(r.config.alarm.state, 'armed')
  assert.equal(r.config.alarm.armedAt, new Date(2026, 8, 1, 10, 0, 0, 0).getTime())
})

test('um alarme de UMA vez se desarma ao disparar', () => {
  const c = armAlarm(alarmAt(10, 0, ALARM_ONCE), T0)
  const r = reconcile(c, c.alarm.armedAt + SEC, { live: true })
  assert.equal(r.event?.kind, 'alarmFired')
  assert.equal(r.config.alarm.state, 'idle')
  assert.equal(r.config.alarm.armedAt, 0)
})

test('três dias suspensos viram UM evento, não três', () => {
  const c = armAlarm(alarmAt(10, 0, ALARM_ALL_DAYS), T0)
  const tresDiasDepois = new Date(2026, 8, 3, 12, 0, 0, 0).getTime()
  const r = reconcile(c, tresDiasDepois, { live: true })
  assert.equal(r.event?.kind, 'alarmFired')
  assert.equal(r.event.crossed, 4, 'não coalesceu as fronteiras atravessadas')
  // A ocorrência tratada é a ÚLTIMA, e o próximo armado é o dia seguinte: uma
  // rajada abriria quatro terminais de uma vez.
  assert.equal(r.config.alarm.firedAt, new Date(2026, 8, 3, 10, 0, 0, 0).getTime())
  assert.equal(r.config.alarm.armedAt, new Date(2026, 8, 4, 10, 0, 0, 0).getTime())
})

test('mudar o horário de um alarme armado REARMA sem ressuscitar o que já tocou', () => {
  let c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  const r = reconcile(c, c.alarm.armedAt + SEC, { live: true })
  c = r.config
  const jaTocou = c.alarm.firedAt
  const mudado = setAlarm(c, 11 * 60, SEG_A_SEX, T0)
  assert.equal(mudado.alarm.firedAt, jaTocou, 'perdeu o registro do que já tocou')
  assert.equal(mudado.alarm.armedAt, new Date(2026, 7, 31, 11, 0, 0, 0).getTime())
  assert.equal(mudado.alarm.missedAt, 0, 'configurar não limpou o aviso de perdido')
})

test('desarmar e rearmar não dispara a ocorrência que passou desarmada', () => {
  let c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  c = disarmAlarm(c)
  assert.equal(c.alarm.armedAt, 0)
  // Duas horas depois — a ocorrência das 10:00 passou com o alarme desligado.
  const depois = T0 + 2 * HOUR
  c = armAlarm(c, depois)
  assert.equal(c.alarm.armedAt, new Date(2026, 8, 1, 10, 0, 0, 0).getTime())
  assert.equal(reconcile(c, depois, { live: true }).event, null)
})

test('toggleAlarm alterna armar e desarmar', () => {
  const c = alarmAt(10, 0, SEG_A_SEX)
  const armado = toggleAlarm(c, T0)
  assert.equal(armado.alarm.state, 'armed')
  assert.equal(toggleAlarm(armado, T0).alarm.state, 'idle')
})

test('o alarme emite eventos e o relógio não', () => {
  assert.equal(emitsEvents(setMode(defaultClockConfig(), 'alarm')), true)
  assert.equal(emitsEvents(defaultClockConfig()), false)
})

test('nextWakeMs do alarme respeita o disparo próximo e nunca é null', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  // 300 ms antes do disparo: não pode esperar o segundo cheio para virar.
  assert.equal(nextWakeMs(c, c.alarm.armedAt - 300), 300)
  // Longe do disparo, é o alinhamento com o próximo segundo.
  assert.equal(nextWakeMs(c, T0 + 500), 500)
  // Desarmado continua tiquetaqueando: o mostrador é a HORA.
  assert.equal(nextWakeMs(alarmAt(10, 0, SEG_A_SEX), T0 + 500), 500)
})

test('o alarme não tem barra de progresso', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  assert.equal(clockProgress(c, T0), null)
})

test('o mostrador do alarme é a hora, e a linha de baixo é a agenda', () => {
  const armado = armAlarm(alarmAt(8, 0, SEG_A_SEX), T0)
  const { readout, detail } = readoutFor(armado, T0)
  assert.match(readout, /^\d{2}:\d{2}:\d{2}$/, 'o mostrador deixou de ser a hora')
  assert.equal(detail, '08:00 · seg a sex')
  assert.equal(readoutFor(alarmAt(8, 0, SEG_A_SEX), T0).detail, 'desarmado')
  const perdido = { ...armado, alarm: { ...armado.alarm, missedAt: T0 } }
  assert.equal(readoutFor(perdido, T0).detail, '08:00 · seg a sex · perdido')
})

test('os rótulos da agenda dizem a forma, não a lista de bits', () => {
  assert.equal(alarmDaysLabel(ALARM_WEEKDAYS), 'seg a sex')
  assert.equal(alarmDaysLabel(ALARM_ALL_DAYS), 'todos os dias')
  assert.equal(alarmDaysLabel(ALARM_WEEKEND), 'fim de semana')
  assert.equal(alarmDaysLabel(ALARM_ONCE), 'uma vez')
  assert.equal(alarmDaysLabel((1 << 1) | (1 << 3) | (1 << 5)), 'seg, qua, sex')
  assert.equal(formatAlarmTime(8 * 60 + 5, false), '08:05')
  assert.equal(alarmSummary(alarmAt(8, 0, SEG_A_SEX)), '08:00 · seg a sex')
})

test('a contagem até o disparo é legível em minutos, horas e dias', () => {
  const c = armAlarm(alarmAt(10, 0, SEG_A_SEX), T0)
  assert.equal(alarmCountdown(c, T0), 'em 1 h')
  assert.equal(alarmCountdown(c, c.alarm.armedAt - 20 * MIN), 'em 20 min')
  assert.equal(alarmCountdown(c, c.alarm.armedAt), 'agora')
  const soSabado = armAlarm(alarmAt(8, 0, 1 << 6), T0)
  assert.match(alarmCountdown(soSabado, T0), /^em 4 d/)
})

test('a gramática de --days aceita atalho e lista, e recusa lixo', () => {
  assert.equal(parseAlarmDays('daily'), ALARM_ALL_DAYS)
  assert.equal(parseAlarmDays('mon-fri'), ALARM_WEEKDAYS)
  assert.equal(parseAlarmDays('weekdays'), ALARM_WEEKDAYS)
  assert.equal(parseAlarmDays('weekend'), ALARM_WEEKEND)
  assert.equal(parseAlarmDays('once'), ALARM_ONCE)
  assert.equal(parseAlarmDays('mon,wed,fri'), (1 << 1) | (1 << 3) | (1 << 5))
  assert.equal(parseAlarmDays('SUN, SAT'), ALARM_WEEKEND)
  // `null`, e NÃO um "melhor esforço": um `--days mmon` que virasse segunda em
  // silêncio criaria um alarme que dispara num dia que ninguém pediu.
  assert.equal(parseAlarmDays('mmon'), null)
  assert.equal(parseAlarmDays('segunda'), null)
  assert.equal(parseAlarmDays(''), null)
})

test('a gramática de --at-time só aceita hora civil válida', () => {
  assert.equal(parseAlarmTime('08:00'), 8 * 60)
  assert.equal(parseAlarmTime('8:05'), 8 * 60 + 5)
  assert.equal(parseAlarmTime('23:59'), 23 * 60 + 59)
  assert.equal(parseAlarmTime('00:00'), 0)
  assert.equal(parseAlarmTime('24:00'), null)
  assert.equal(parseAlarmTime('08:60'), null)
  assert.equal(parseAlarmTime('0800'), null)
  assert.equal(parseAlarmTime('oito'), null)
})

test('a gramática de duração aceita 25m, 90s, 1h30m e número solto', () => {
  assert.equal(parseDurationSpec('25m'), 25 * MIN)
  assert.equal(parseDurationSpec('90s'), 90 * SEC)
  assert.equal(parseDurationSpec('1h30m'), HOUR + 30 * MIN)
  assert.equal(parseDurationSpec('2h'), 2 * HOUR)
  assert.equal(parseDurationSpec('25'), 25 * MIN, 'número solto deixou de ser minutos')
  assert.equal(parseDurationSpec('vinte'), null)
  assert.equal(parseDurationSpec('0m'), null)
  assert.equal(parseDurationSpec(''), null)
  // O teto do módulo continua valendo: 48 h não passa a existir pela porta do CLI.
  assert.equal(parseDurationSpec('48h'), MAX_DURATION_MS)
})

test('o alarme é o quinto modo e não mexeu nos outros quatro', () => {
  assert.deepEqual(CLOCK_MODES, ['clock', 'stopwatch', 'timer', 'pomodoro', 'alarm'])
  // Trocar de modo não apaga o estado dos outros — a promessa do `setMode`.
  let c = startTimer(setTimerDuration(setMode(defaultClockConfig(), 'timer'), 10 * MIN), T0)
  const comAlarme = armAlarm(setMode(c, 'alarm'), T0)
  assert.equal(comAlarme.timer.state, 'running')
  assert.equal(comAlarme.alarm.state, 'armed')
  // E um timer correndo não emite evento enquanto o alarme é o modo ativo.
  assert.equal(reconcile(comAlarme, T0 + 11 * MIN, { live: true }).event?.kind, 'alarmFired')
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
