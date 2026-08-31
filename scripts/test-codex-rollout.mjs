/**
 * Guarda o NÓ DE RELÓGIO do observador de rollouts do Codex.
 *
 * Onde o SO não entrega observação recursiva, o Atelier observa só o diretório
 * do dia — e esse diretório muda de nome à meia-noite. Sem um temporizador que
 * acorde na virada, a tira da borda congelaria no último número do dia anterior
 * até alguém reabrir o painel. Este teste cobre as três coisas que podem dar
 * errado nesse temporizador, e que são invisíveis até o dia em que falham:
 *
 *   1. `msUntilNextLocalMidnight` numa virada COMUM — a conta simples, para
 *      servir de âncora às outras duas.
 *   2. a mesma conta num dia de HORÁRIO DE VERÃO — 23h numa ponta do ano, 25h
 *      na outra. Somar 24h fixas daria um nó que dispara na hora errada e
 *      acumula o erro a cada dia.
 *   3. o REARMAMENTO na virada — o observador larga o diretório velho, pega o
 *      novo, emite uma leitura (nada mais avisaria) e reagenda a meia-noite
 *      SEGUINTE recalculada do zero.
 *
 * Uso: node scripts/test-codex-rollout.mjs
 */
process.env.TZ = 'America/New_York'

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-codex-rollout-'))
const outfile = join(outdir, 'rollout.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        CodexRolloutWatcher,
        msUntilNextLocalMidnight
      } from './src/main/core/codex/codex-rollout.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const { CodexRolloutWatcher, msUntilNextLocalMidnight } = await import(
  pathToFileURL(outfile).href
)

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.stack ?? err.message}`)
  }
}

const HOUR = 3_600_000

/**
 * Relógio de mentira: o tempo só anda quando o teste manda, e os temporizadores
 * ficam numa fila em vez de irem para o event loop. `fire()` dispara o próximo
 * e adianta o relógio EXATAMENTE até a hora dele — que é o que acontece de
 * verdade quando um `setTimeout` estoura.
 */
function makeClock(startMs) {
  let now = startMs
  const timers = []
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, at: now + ms }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
    },
    get pending() {
      return timers.length
    },
    next() {
      return timers[0]
    },
    async fire() {
      const t = timers.shift()
      if (!t) throw new Error('nenhum temporizador pendente para disparar')
      now = t.at
      // O callback real é `() => void this.rollover(env)` — descarta a promise,
      // como todo callback de `setTimeout`. Para o teste enxergar o resultado,
      // deixamos o event loop girar até o trabalho assíncrono assentar.
      t.fn()
      // Cada passo de `setTimeout(1)` garante uma volta completa do event loop,
      // com os callbacks de I/O do rollover incluídos; a virada faz uma dúzia
      // de operações de disco em fila antes de emitir.
      for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 1))
    }
  }
}

function rolloutLine(timestamp, usedPercent) {
  return (
    JSON.stringify({
      timestamp,
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: usedPercent }
        }
      }
    }) + '\n'
  )
}

// --- 1 & 2: a aritmética da meia-noite -------------------------------------

await test('virada comum: faltam as horas que faltam, nada de mágica', () => {
  // 07/jan/2026, 09:00 local, um dia sem mexer no relógio.
  const delay = msUntilNextLocalMidnight(new Date(2026, 0, 7, 9, 0, 0))
  assert.equal(delay, 15 * HOUR)
})

await test('dia de 23h (início do horário de verão): não são 24h', () => {
  // 08/mar/2026: às 02:00 o relógio pula para 03:00, então da meia-noite à
  // meia-noite seguinte passam 23 horas de parede.
  const delay = msUntilNextLocalMidnight(new Date(2026, 2, 8, 0, 0, 0))
  assert.equal(delay, 23 * HOUR)
  assert.notEqual(delay, 24 * HOUR)
})

await test('dia de 25h (fim do horário de verão): também não são 24h', () => {
  // 01/nov/2026: às 02:00 o relógio volta para 01:00 — 25 horas de parede.
  const delay = msUntilNextLocalMidnight(new Date(2026, 10, 1, 0, 0, 0))
  assert.equal(delay, 25 * HOUR)
})

// --- 3: o rearmamento na virada ------------------------------------------

await test('a virada troca o diretório observado e reagenda sem herdar 24h', async () => {
  const home = await mkdtemp(join(tmpdir(), 'atelier-codex-home-'))
  const day07 = join(home, 'sessions', '2026', '03', '07')
  const day08 = join(home, 'sessions', '2026', '03', '08')
  await mkdir(day07, { recursive: true })
  await writeFile(join(day07, 'a.jsonl'), rolloutLine('2026-03-07T20:00:00.000Z', 10))

  const env = { CODEX_HOME: home }
  // 07/mar, 23:00 local: falta 1h para a virada. E a virada cai no dia de 23h,
  // então a meia-noite SEGUINTE tem que ser reagendada como 23h, não 24h.
  const clock = makeClock(Date.UTC(2026, 2, 8, 4, 0, 0))

  const watcher = new CodexRolloutWatcher()
  watcher.useRecursiveWatch = false
  const readings = []
  watcher.onReading = (r) => readings.push(r)

  try {
    await watcher.start(env, clock)

    // Leitura inaugural, vinda do diretório 07.
    assert.equal(readings.length, 1)
    assert.equal(readings[0].limits.rateLimitsByLimitId.codex.primary.used_percent, 10)
    assert.ok(watcher.fallbackDir.endsWith(join('2026', '03', '07')))

    // O nó de relógio: um único temporizador, apontado para daqui a 1h.
    assert.equal(clock.pending, 1)
    assert.equal(clock.next().ms, 1 * HOUR)

    // Chega o dia seguinte no disco, e a meia-noite estoura.
    await mkdir(day08, { recursive: true })
    await writeFile(join(day08, 'b.jsonl'), rolloutLine('2026-03-08T04:30:00.000Z', 42))
    await clock.fire()

    // Observador rearmado no diretório novo, e uma leitura de lá — sem a qual a
    // tira ficaria parada no 10% do dia anterior.
    assert.ok(watcher.fallbackDir.endsWith(join('2026', '03', '08')))
    assert.equal(readings.length, 2)
    assert.equal(readings[1].limits.rateLimitsByLimitId.codex.primary.used_percent, 42)

    // E a próxima meia-noite foi RECALCULADA a partir do novo "agora": 23h,
    // porque 08/mar é o dia curto. Se somasse 24h fixas, daria 24h aqui.
    assert.equal(clock.pending, 1)
    assert.equal(clock.next().ms, 23 * HOUR)
  } finally {
    watcher.stop()
    await rm(home, { recursive: true, force: true })
  }
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam`)
process.exit(failed === 0 ? 0 : 1)
