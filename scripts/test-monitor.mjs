/**
 * Guarda a aritmética do monitor de recursos.
 *
 * Nada aqui é visível na tela: um CPU% negativo, um `NaN` numa barra ou uma
 * soma de tokens entre agentes saem como um número plausível no widget, e é
 * exatamente por isso que precisam de teste. As três famílias:
 *
 *   1. `sampleCpu` — CPU% é DERIVADA de dois snapshots, não lida. A primeira
 *      amostra não tem delta, e um contador reiniciado dá delta negativo.
 *   2. `formatBytes` — os limites de cada unidade, onde o arredondamento
 *      escolhe entre "1023,9 MB" e "1,0 GB".
 *   3. `aggregateLimits` — o máximo por janela, e a recusa em somar tokens.
 *   4. `groupByAccount` — o recorte POR CONTA, onde a regra se inverte: entre
 *      agentes vale o máximo, dentro de uma conta vale a leitura mais fresca.
 *   5. `dockSummary` — o que a TIRA de borda mostra: o custo dos agentes e a
 *      janela mais apertada das contas, dois recortes diferentes na mesma linha.
 *
 * Uso: node scripts/test-monitor.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-monitor-'))
const outfile = join(outdir, 'monitor.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        readCpuTimes,
        sampleCpu,
        usageFrom,
        sumAppMetrics,
        readLoadAvg,
        SystemStatsMonitor
      } from './src/main/core/system/system-stats.ts'
      export { formatBytes, formatTokens } from './src/shared/types.ts'
      export {
        activeWindows,
        aggregateLimits,
        agoLabel,
        contextPctFromCodex,
        countReporting,
        decodeStoredCodexUsage,
        dockSummary,
        windowSpanMinutes,
        fromCodexAccountTokenUsage,
        fromCodexRateLimits,
        fromCodexTokenUsage,
        groupByAccount,
        mergeCodexAccount,
        mergeReading,
        parseStatusLine,
        sumCost,
        untilReset,
        windowLabel
      } from './src/shared/agent-usage.ts'
      export { isClaudeCommandLine as isClaudeCommand } from './src/shared/terminal-presets.ts'
      export { agentSettings } from './src/main/core/terminal/agent-settings.ts'
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

const {
  readCpuTimes,
  sampleCpu,
  usageFrom,
  sumAppMetrics,
  readLoadAvg,
  SystemStatsMonitor,
  formatBytes,
  activeWindows,
  aggregateLimits,
  agoLabel,
  contextPctFromCodex,
  countReporting,
  decodeStoredCodexUsage,
  dockSummary,
  windowSpanMinutes,
  fromCodexAccountTokenUsage,
  fromCodexRateLimits,
  fromCodexTokenUsage,
  groupByAccount,
  mergeCodexAccount,
  mergeReading,
  parseStatusLine,
  sumCost,
  untilReset,
  windowLabel,
  isClaudeCommand,
  agentSettings
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
async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

console.log('\nmonitor de recursos\n')

// ─── CPU ──────────────────────────────────────────────────────────────────────

/** Um núcleo sintético, com os tempos que `os.cpus()` publica. */
const cpu = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } })

test('readCpuTimes soma os núcleos, não tira média', () => {
  const t = readCpuTimes([cpu(100, 300), cpu(200, 400)])
  assert.equal(t.idle, 700)
  assert.equal(t.total, 1000)
})

test('sampleCpu com dois snapshots dá o percentual conhecido', () => {
  // 1000 ticks a mais no total, 750 deles ociosos → 25% ocupada.
  const prev = { idle: 1000, total: 4000 }
  const now = { idle: 1750, total: 5000 }
  assert.equal(sampleCpu(prev, now), 25)
})

test('sampleCpu sobre snapshots reais de os.cpus() bate com a conta', () => {
  const prev = readCpuTimes([cpu(0, 0)])
  const now = readCpuTimes([cpu(40, 60)])
  assert.equal(sampleCpu(prev, now), 40)
})

test('a primeira amostra não tem delta: null, e nunca 0%', () => {
  // O 0% é o modo de falha real aqui — ele seria desenhado como "máquina
  // parada" no exato momento em que ninguém mediu nada.
  assert.equal(sampleCpu(null, { idle: 10, total: 100 }), null)
})

test('delta de tempo zero (duas leituras no mesmo tick) é null', () => {
  const t = { idle: 1000, total: 4000 }
  assert.equal(sampleCpu(t, t), null)
})

test('delta negativo (contador reiniciado) não vira -40% nem NaN', () => {
  const prev = { idle: 5000, total: 20000 }
  const now = { idle: 1000, total: 4000 }
  const r = sampleCpu(prev, now)
  assert.equal(r, null, `esperava null, veio ${r}`)
})

test('idle andando mais que total não passa de 100 nem fica negativo', () => {
  const r = sampleCpu({ idle: 0, total: 0 }, { idle: 500, total: 100 })
  assert.ok(r === null || (r >= 0 && r <= 100), `fora de [0,100]: ${r}`)
})

test('readLoadAvg é null no Windows, onde loadavg() não significa nada', () => {
  assert.equal(readLoadAvg('win32'), null)
  assert.equal(typeof readLoadAvg('darwin'), 'number')
})

// ─── Disco e processo ─────────────────────────────────────────────────────────

test('usageFrom conta bavail como livre (o reservado ao root não é seu)', () => {
  // 1000 blocos de 4096, 200 disponíveis: 800 usados do ponto de vista de quem
  // vai clonar um repositório, mesmo que `bfree` fosse maior.
  const { used, total } = usageFrom({ bsize: 4096, blocks: 1000, bavail: 200 })
  assert.equal(total, 4096 * 1000)
  assert.equal(used, 4096 * 800)
})

test('sumAppMetrics soma os processos e converte workingSetSize de KB', () => {
  const { cpuPct, memBytes } = sumAppMetrics([
    { cpu: { percentCPUUsage: 4.2 }, memory: { workingSetSize: 1024 } },
    { cpu: { percentCPUUsage: 1.1 }, memory: { workingSetSize: 2048 } },
    // Um PTY que ainda não publicou métrica não pode virar NaN na soma.
    {}
  ])
  assert.equal(cpuPct, 5.3)
  assert.equal(memBytes, 3 * 1024 * 1024)
})

// ─── formatBytes ──────────────────────────────────────────────────────────────

test('formatBytes nos limites de cada unidade', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1024), '1,0 KB')
  assert.equal(formatBytes(1023 * 1024 * 1024), '1023,0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1,0 GB')
  assert.equal(formatBytes(1024 ** 4), '1,0 TB')
})

test('formatBytes não inventa número para entrada inválida', () => {
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(Number.NaN), '—')
})

// ─── Bloco IA ─────────────────────────────────────────────────────────────────

const status = (tokens, contextPct, limits) => ({ tokens, contextPct, limits })

test('aggregateLimits devolve o MÁXIMO de cada janela', () => {
  const janelas = aggregateLimits([
    status(31_300, 3, [
      { window: '5h', pct: 80 },
      { window: '7d', pct: 58 }
    ]),
    status(12_000, 9, [
      { window: '5h', pct: 12 },
      { window: '7d', pct: 91 }
    ])
  ])
  assert.deepEqual(janelas, [
    { window: '5h', pct: 80, resetsAt: null },
    { window: '7d', pct: 91, resetsAt: null }
  ])
})

test('agente sem limits não entra como zero e não puxa o máximo para baixo', () => {
  const janelas = aggregateLimits([
    status(31_300, 3, [{ window: '7d', pct: 58 }]),
    // Um shell puro: nunca imprimiu janela nenhuma.
    status(null, null, []),
    undefined
  ])
  assert.deepEqual(janelas, [{ window: '7d', pct: 58, resetsAt: null }])
})

test('a ordem é a de primeira aparição, não a alfabética', () => {
  // Reordenar faria as colunas trocarem de lugar conforme quem respondeu
  // primeiro — o painel dançaria sem nenhum número ter mudado.
  const janelas = aggregateLimits([
    status(null, null, [
      { window: '5h', pct: 10 },
      { window: '7d', pct: 20 }
    ])
  ])
  assert.deepEqual(
    janelas.map((j) => j.window),
    ['5h', '7d']
  )
})

test('NENHUMA soma de tokens acontece entre agentes', () => {
  // A recusa é o teste: cada CLI conta o que quer chamar de token, e uma soma
  // de unidades diferentes é um número errado com cara de certo. O módulo não
  // expõe nada que some — e nenhuma janela agregada carrega tokens.
  const janelas = aggregateLimits([
    status(1000, 1, [{ window: '5h', pct: 1 }]),
    status(2000, 2, [{ window: '5h', pct: 2 }])
  ])
  for (const j of janelas) {
    // Nenhuma chave de token na janela agregada: o que se agrega é percentual e
    // prazo, e a ausência de `tokens` aqui é a recusa em forma de teste.
    assert.deepEqual(Object.keys(j).sort(), ['pct', 'resetsAt', 'window'])
  }
  assert.equal(janelas[0].pct, 2, 'o agregado é o máximo, não a soma (que daria 3)')
})

test('countReporting não conta o terminal que nunca publicou nada', () => {
  assert.equal(
    countReporting([
      status(31_300, 3, []),
      status(null, null, [{ window: '5h', pct: 4 }]),
      status(null, null, []),
      undefined
    ]),
    2
  )
})

// ─── A statusLine como fonte ──────────────────────────────────────────────────
//
// O payload vem de um binário que se atualiza sozinho, sem passar por este
// código: um campo que muda de forma não pode virar NaN numa barra do widget.

/** Um payload de statusLine como o Claude Code o entrega. */
const PAYLOAD = JSON.stringify({
  cwd: '/proj',
  session_id: 'abc123',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  version: '2.1.90',
  cost: {
    total_cost_usd: 1.2345,
    total_duration_ms: 45000,
    total_lines_added: 156,
    total_lines_removed: 23
  },
  context_window: {
    total_input_tokens: 15500,
    total_output_tokens: 1200,
    context_window_size: 1000000,
    used_percentage: 8,
    remaining_percentage: 92
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 }
  },
  effort: { level: 'high' },
  fast_mode: false
})

test('parseStatusLine lê o payload inteiro, na unidade certa', () => {
  const u = parseStatusLine(PAYLOAD)
  assert.equal(u.model, 'Opus')
  assert.equal(u.modelId, 'claude-opus-5')
  assert.equal(u.inputTokens, 15500)
  // O que a leitura de tela NUNCA soube dizer: 8% de 1M não é 8% de 200k.
  assert.equal(u.contextWindowSize, 1000000)
  assert.equal(u.usedPercentage, 8)
  assert.equal(u.costUsd, 1.2345)
  assert.equal(u.linesAdded, 156)
  assert.equal(u.effort, 'high')
  assert.equal(u.fastMode, false)
})

test('as janelas saem com o reset, e em ordem fixa: 5h antes de 7d', () => {
  // A ordem das chaves de um objeto JSON não é garantida; a das colunas é.
  const u = parseStatusLine(PAYLOAD)
  assert.deepEqual(u.limits, [
    { provider: 'claude', window: '5h', pct: 23.5, resetsAt: 1738425600 },
    { provider: 'claude', window: '7d', pct: 41.2, resetsAt: 1738857600 }
  ])
})

test('janela ausente some da lista em vez de virar 0%', () => {
  const u = parseStatusLine(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10 } } }))
  assert.deepEqual(u.limits, [{ provider: 'claude', window: '5h', pct: 10, resetsAt: null }])
})

test('payload vazio ou com campos faltando vira null, nunca NaN', () => {
  const u = parseStatusLine('{}')
  assert.notEqual(u, null, 'um objeto vazio ainda é uma leitura válida')
  for (const k of ['model', 'inputTokens', 'contextWindowSize', 'usedPercentage', 'costUsd']) {
    assert.equal(u[k], null, `${k} deveria ser null`)
  }
  assert.deepEqual(u.limits, [])
})

test('tipo errado no payload não atravessa como número', () => {
  // O binário do outro lado muda de forma sem avisar: um "8" string viraria 8
  // num cast, e um objeto viraria NaN na barra do widget.
  const u = parseStatusLine(
    JSON.stringify({ context_window: { used_percentage: '8', total_input_tokens: {} } })
  )
  assert.equal(u.usedPercentage, null)
  assert.equal(u.inputTokens, null)
})

test('texto que não é payload devolve null — sem apagar a leitura anterior', () => {
  assert.equal(parseStatusLine('nao sou json'), null)
  assert.equal(parseStatusLine(''), null)
  // Um array é JSON válido e NÃO é um payload: aceitá-lo viraria leitura vazia.
  assert.equal(parseStatusLine('[1,2,3]'), null)
})

test('untilReset dá o PRAZO, não a hora do relógio', () => {
  const agora = 1_000_000_000_000
  const s = (n) => Math.floor(agora / 1000) + n
  assert.equal(untilReset(s(3600 * 2 + 780), agora), '2h13')
  assert.equal(untilReset(s(300), agora), '5min')
  assert.equal(untilReset(s(3600 * 30), agora), '1d6h')
  // Já venceu: nada a mostrar — o percentual seguinte é que conta.
  assert.equal(untilReset(s(-10), agora), null)
  assert.equal(untilReset(null, agora), null)
})

// ─── As duas fontes convivendo ────────────────────────────────────────────────

test('a leitura publicada vence a raspada, campo a campo', () => {
  // Os dois canais correm ao mesmo tempo num Claude Code: o raspador continua
  // lendo a tela. Deixar "a mais recente" vencer faria os números oscilarem
  // entre duas fontes de qualidade diferente a cada frame do PTY.
  const usage = parseStatusLine(PAYLOAD)
  const screen = status(999, 99, [{ window: '5h', pct: 99 }])
  const r = mergeReading(usage, screen)
  assert.equal(r.source, 'statusline')
  assert.equal(r.contextPct, 8, 'o 99% raspado da tela venceu o publicado')
  assert.equal(r.tokens, 15500)
  assert.equal(r.limits[0].pct, 23.5)
  assert.equal(r.model, 'Opus')
})

test('sem statusLine o raspador serve — Codex e OpenCode dependem disso', () => {
  const r = mergeReading(null, status(31_300, 3, [{ window: '7d', pct: 58 }]))
  assert.equal(r.source, 'screen')
  assert.equal(r.tokens, 31_300)
  assert.equal(r.contextPct, 3)
  assert.equal(r.costUsd, null, 'custo não existe na tela; inventá-lo é pior que o traço')
  assert.equal(r.contextWindowSize, null)
})

test('terminal sem leitura nenhuma se declara sem leitura', () => {
  assert.equal(mergeReading(null, null).source, 'none')
  assert.equal(mergeReading(null, status(null, null, [])).source, 'none')
})

test('antes da primeira chamada de API, o raspado preenche o buraco', () => {
  // `used_percentage` vem nulo até a primeira resposta; nesse intervalo o "3%"
  // da tela é melhor que um traço.
  const usage = parseStatusLine(JSON.stringify({ model: { display_name: 'Opus' } }))
  const r = mergeReading(usage, status(120, 3, []))
  assert.equal(r.contextPct, 3)
  assert.equal(r.tokens, 120)
  assert.equal(r.model, 'Opus')
})

test('o agregado carrega o resetsAt da janela VENCEDORA', () => {
  const a = { limits: [{ window: '7d', pct: 41, resetsAt: 111 }] }
  const b = { limits: [{ window: '7d', pct: 88, resetsAt: 222 }] }
  assert.deepEqual(aggregateLimits([a, b]), [{ window: '7d', pct: 88, resetsAt: 222 }])
})

test('custo SOMA entre agentes — é a única unidade compartilhada', () => {
  const r = (usd) => ({ costUsd: usd, limits: [] })
  assert.equal(sumCost([r(1.2), r(0.35), r(null)]).toFixed(2), '1.55')
})

test('ninguém publicando custo devolve null, e não US$ 0,00', () => {
  // "não gastei nada" e "não sei" são afirmações diferentes, e só uma delas é
  // honesta num canvas de agentes que só raspam a tela.
  assert.equal(sumCost([{ costUsd: null, limits: [] }]), null)
  assert.equal(sumCost([]), null)
})

test('Codex usa last.inputTokens sobre modelContextWindow, não total acumulado', () => {
  const u = fromCodexTokenUsage({
    total: { totalTokens: 815300 },
    last: {
      inputTokens: 81722,
      cachedInputTokens: 79616,
      cacheWriteInputTokens: 12,
      outputTokens: 366,
      reasoningOutputTokens: 110
    },
    modelContextWindow: 258400
  })
  assert.equal(u.provider, 'codex')
  assert.equal(u.inputTokens, 81722)
  assert.equal(u.sessionTokens, 815300)
  assert.equal(Math.round(u.usedPercentage * 10) / 10, 31.6)
  assert.equal(u.cachedInputTokens, 79616)
  assert.equal(u.outputTokens, 366)
  assert.equal(u.reasoningOutputTokens, 110)
  assert.equal(u.costUsd, null, 'créditos/quota do Codex não viram custo de sessão')
})

test('contexto Codex não subtrai cache e entradas inválidas viram null', () => {
  assert.equal(contextPctFromCodex(100, 200), 50)
  assert.equal(contextPctFromCodex(150, 0), null)
  assert.equal(contextPctFromCodex(Number.NaN, 200), null)
  assert.equal(contextPctFromCodex(500, 200), 100)
})

test('rate limits Codex derivam a janela pela duração e preservam buckets', () => {
  const limits = fromCodexRateLimits({
    rateLimitsByLimitId: {
      primary: { usedPercentage: 4, windowDurationMins: 300, resetsAt: 111 },
      secondary: { usedPercentage: 1, windowDurationMins: 10080, resetsAt: 222 },
      other: { usedPercentage: 9, windowDurationMins: 90, resetsAt: 333 }
    }
  })
  assert.deepEqual(limits.map((l) => [l.bucketId, l.window, l.windowMinutes, l.pct]), [
    ['primary', '5h', 300, 4],
    ['secondary', '7d', 10080, 1],
    ['other', '90min', 90, 9]
  ])
})

test('rate limits Codex leem o payload real primary/secondary do App Server', () => {
  const limits = fromCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 111 },
        secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 222 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        planType: 'plus'
      }
    }
  })
  assert.deepEqual(limits.map((l) => [l.bucketId, l.window, l.windowMinutes, l.pct, l.resetsAt]), [
    ['codex:primary', '5h', 300, 9, 111],
    ['codex:secondary', '7d', 10080, 17, 222]
  ])
})

test('windowLabel nomeia a janela pela DURAÇÃO, e o irregular não vira 5h', () => {
  // O rótulo é a duração publicada, não a posição do bucket no payload: o dia
  // em que o Codex mudar `primary` para 7d, um `5h` escrito na mão mentiria.
  assert.equal(windowLabel(300), '5h')
  assert.equal(windowLabel(10080), '7d')
  assert.equal(windowLabel(1440), '1d')
  assert.equal(windowLabel(4320), '3d')
  assert.equal(windowLabel(60), '1h')
  assert.equal(windowLabel(90), '90min')
  assert.equal(windowLabel(null), 'limite')
  assert.equal(windowLabel(0), 'limite')
  assert.equal(windowLabel(Number.NaN, 'weekly'), 'weekly')
})

test('primary/secondary saem pela duração, não pela ordem em que vieram', () => {
  // O payload aqui está TROCADO de propósito: `primary` dura uma semana.
  const limits = fromCodexRateLimits({
    rateLimitsByLimitId: {
      primary: { usedPercentage: 12, windowDurationMins: 10080, resetsAt: 111 },
      secondary: { usedPercentage: 40, windowDurationMins: 300, resetsAt: 222 }
    }
  })
  assert.deepEqual(
    limits.map((l) => [l.bucketId, l.window]),
    [
      ['primary', '7d'],
      ['secondary', '5h']
    ]
  )
})

test('dois buckets de MESMA duração continuam separados', () => {
  // `codex` e `codex_other` são contadores diferentes que por acaso duram 5h.
  // Fundi-los pelo rótulo mostraria um número só para duas quotas distintas.
  const limits = fromCodexRateLimits({
    rateLimitsByLimitId: {
      codex: { usedPercentage: 4, windowDurationMins: 300, resetsAt: 111 },
      codex_other: { usedPercentage: 77, windowDurationMins: 300, resetsAt: 222 }
    }
  })
  assert.equal(limits.length, 2)
  const janelas = aggregateLimits([{ limits }])
  assert.deepEqual(
    janelas.map((j) => [j.bucketId, j.window, j.pct]),
    [
      ['codex', '5h', 4],
      ['codex_other', '5h', 77]
    ]
  )
})

test('payload de tokens quebrado vira null, nunca NaN', () => {
  const u = fromCodexTokenUsage({
    total: {},
    last: { inputTokens: 'muitos' },
    modelContextWindow: null
  })
  assert.equal(u.inputTokens, null)
  assert.equal(u.sessionTokens, null)
  assert.equal(u.usedPercentage, null)
  assert.equal(u.contextWindowSize, null)
  assert.equal(fromCodexTokenUsage(null).usedPercentage, null)
  assert.equal(fromCodexTokenUsage('nada disso').inputTokens, null)
})

test('a leitura Codex se declara app-server, e não statusline', () => {
  const r = mergeReading(
    fromCodexTokenUsage({ last: { inputTokens: 50 }, modelContextWindow: 200 }),
    null
  )
  assert.equal(r.source, 'app-server')
  assert.equal(r.provider, 'codex')
  assert.equal(r.contextPct, 25)
  assert.equal(sumCost([r]), null, 'créditos do Codex não entram na soma de custo')
})

// ─── Conta Codex ────────────────────────────────────────────────────
//
// A notificação do App Server é ESPARSA: ela diz o que mudou, não a conta
// inteira. Todo o assunto destes casos é o que NÃO pode sumir no caminho.

const contaCodex = (over = {}) => ({
  authMode: 'chatgpt',
  planType: 'plus',
  limits: [],
  credits: { hasCredits: true, unlimited: false, balance: '12.50' },
  individualLimit: null,
  spendControlReached: null,
  rateLimitReachedType: null,
  resetCreditsAvailable: null,
  tokenUsage: null,
  at: '2026-08-29T12:00:00.000Z',
  source: 'live',
  ...over
})

test('conta Codex le os envelopes reais de account/read e rateLimits/read', () => {
  const account = mergeCodexAccount(contaCodex({ authMode: null, planType: null }), {
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
    requiresOpenaiAuth: true
  })
  assert.equal(account.authMode, 'chatgpt')
  assert.equal(account.planType, 'plus')

  const limits = mergeCodexAccount(account, {
    rateLimits: {
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null,
      spendControlReached: false,
      planType: 'plus',
      rateLimitReachedType: null
    },
    rateLimitResetCredits: { availableCount: 2, credits: [] }
  })
  assert.deepEqual(limits.credits, { hasCredits: false, unlimited: false, balance: '0' })
  assert.equal(limits.spendControlReached, false)
  assert.equal(limits.resetCreditsAvailable, 2)
})

test('uso de tokens da conta Codex le o payload real e entra no merge', () => {
  const payload = {
    summary: {
      lifetimeTokens: 22710468,
      peakDailyTokens: 22710468,
      longestRunningTurnSec: 1713,
      currentStreakDays: 1,
      longestStreakDays: 1
    },
    dailyUsageBuckets: [{ startDate: '2026-08-29', tokens: 22710468 }],
    threadUsage: null
  }
  assert.deepEqual(fromCodexAccountTokenUsage(payload), {
    summary: payload.summary,
    dailyUsageBuckets: payload.dailyUsageBuckets
  })
  assert.equal(mergeCodexAccount(contaCodex(), payload).tokenUsage.summary.lifetimeTokens, 22710468)
})

test('payload invalido de uso da conta preserva a leitura Codex anterior', () => {
  const previous = contaCodex({
    tokenUsage: fromCodexAccountTokenUsage({
      summary: { lifetimeTokens: 1200 },
      dailyUsageBuckets: []
    })
  })
  assert.equal(fromCodexAccountTokenUsage({ summary: { lifetimeTokens: 'muitos' } }), null)
  assert.equal(
    mergeCodexAccount(previous, { summary: { lifetimeTokens: 'muitos' } }).tokenUsage,
    previous.tokenUsage
  )
})

test('atualização esparsa não apaga plano nem créditos anteriores', () => {
  const merged = mergeCodexAccount(contaCodex(), { rateLimitReachedType: 'primary' })
  assert.equal(merged.planType, 'plus')
  assert.equal(merged.authMode, 'chatgpt')
  assert.deepEqual(merged.credits, { hasCredits: true, unlimited: false, balance: '12.50' })
  assert.equal(merged.rateLimitReachedType, 'primary')
})

test('campo com tipo errado preserva o valor anterior em vez de virar null', () => {
  const merged = mergeCodexAccount(contaCodex(), {
    planType: 42,
    spendControlReached: 'sim',
    resetCreditsAvailable: 'muitos'
  })
  assert.equal(merged.planType, 'plus')
  assert.equal(merged.spendControlReached, null)
  assert.equal(merged.resetCreditsAvailable, null)
})

test('créditos e limite individual ficam em string — não viram número', () => {
  const merged = mergeCodexAccount(contaCodex({ credits: null }), {
    credits: { hasCredits: true, unlimited: false, balance: '3.20' },
    individualLimit: { limit: '20.00', used: '4.10', remainingPct: 79.5, resetsAt: 999 }
  })
  assert.equal(typeof merged.credits.balance, 'string')
  assert.equal(typeof merged.individualLimit.limit, 'string')
  assert.equal(merged.individualLimit.remainingPct, 79.5)
})

test('limite individual pela metade não entra na conta', () => {
  const merged = mergeCodexAccount(contaCodex(), {
    individualLimit: { limit: '20.00', remainingPct: 79.5 }
  })
  assert.equal(merged.individualLimit, null)
})

test('créditos ilimitados são um estado, e não uma quota de 0%', () => {
  const merged = mergeCodexAccount(contaCodex({ credits: null }), {
    credits: { hasCredits: true, unlimited: true, balance: null }
  })
  assert.equal(merged.credits.unlimited, true)
  assert.equal(merged.credits.balance, null)
  assert.equal(merged.limits.length, 0, 'sem leitura de janela não se inventa 0%')
})

test('a janela persistida cujo reset já passou não volta do disco', () => {
  const agora = Date.parse('2026-08-29T12:00:00.000Z')
  const secs = (min) => Math.floor(agora / 1000) + min * 60
  const stored = decodeStoredCodexUsage(
    {
      at: '2026-08-29T11:00:00.000Z',
      planType: 'plus',
      tokenUsage: {
        summary: { lifetimeTokens: 1200 },
        dailyUsageBuckets: [{ startDate: '2026-08-29', tokens: 1200 }]
      },
      limits: [
        { provider: 'codex', bucketId: 'primary', window: '5h', pct: 4, resetsAt: secs(30) },
        { provider: 'codex', bucketId: 'secondary', window: '7d', pct: 1, resetsAt: secs(-10) },
        { provider: 'codex', bucketId: 'sem-prazo', window: '5h', pct: 90 }
      ]
    },
    agora
  )
  assert.deepEqual(
    stored.limits.map((l) => l.bucketId),
    ['primary'],
    'vencida e sem prazo não sobrevivem ao restart'
  )
  assert.equal(stored.planType, 'plus')
  assert.equal(stored.tokenUsage.summary.lifetimeTokens, 1200)
})

test('arquivo Codex vazio ou corrompido não vira conta zerada', () => {
  assert.equal(decodeStoredCodexUsage(null), null)
  assert.equal(decodeStoredCodexUsage({}), null)
  assert.equal(decodeStoredCodexUsage({ limits: 'nada' }), null)
  // Só a data: a conta existe, mas sem janela nenhuma para mostrar.
  const so = decodeStoredCodexUsage({ at: '2026-08-29T11:00:00.000Z' })
  assert.deepEqual(so.limits, [])
  assert.equal(so.planType, null)
})

test('Claude 5h e Codex 5h não são fundidos no agregado', () => {
  const janelas = aggregateLimits([
    { limits: [{ provider: 'claude', window: '5h', pct: 48, resetsAt: 111 }] },
    { limits: [{ provider: 'codex', bucketId: 'primary', window: '5h', pct: 4, resetsAt: 222 }] }
  ])
  assert.deepEqual(
    janelas.map((j) => [j.provider, j.bucketId ?? null, j.window, j.pct]),
    [
      ['claude', null, '5h', 48],
      ['codex', 'primary', '5h', 4]
    ]
  )
})

// ─── Por conta (bloco de perfis) ──────────────────────────────────────────────
//
// O recorte por conta é o que o bloco IA não faz: lá o agregado é o MÁXIMO
// entre agentes, aqui é a leitura mais FRESCA dentro da conta. Trocar um pelo
// outro não quebra nada visível — só congela o percentual mais velho na tela.

/** Uma leitura viva, no formato que `groupByAccount` consome. */
const live = (accountId, limits, at, costUsd = null) => ({
  accountId,
  reading: {
    model: null,
    tokens: null,
    contextPct: null,
    contextWindowSize: null,
    costUsd,
    limits,
    at,
    source: 'statusline'
  }
})

const FUTURO = Math.floor(Date.now() / 1000) + 3600
const PASSADO = Math.floor(Date.now() / 1000) - 60

test('dentro de uma conta vence a leitura mais FRESCA, não a maior', () => {
  // Os dois terminais leem o MESMO contador da conta. O máximo escolheria 71%
  // para sempre, muito depois de o número real ter caído para 12% (reset).
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 71, resetsAt: FUTURO }], '2026-08-29T10:00:00.000Z'),
    live('a', [{ window: '5h', pct: 12, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z')
  ])
  assert.equal(contas.length, 1)
  assert.equal(contas[0].limits[0].pct, 12)
  assert.equal(contas[0].at, '2026-08-29T12:00:00.000Z')
  assert.equal(contas[0].source, 'live')
})

test('contas diferentes NÃO se misturam — são janelas independentes', () => {
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 90, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z'),
    live('b', [{ window: '5h', pct: 10, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z')
  ])
  assert.deepEqual(
    contas.map((c) => [c.accountId, c.limits[0].pct]),
    [
      ['a', 90],
      ['b', 10]
    ]
  )
})

test('o custo SOMA por conta, e só dos terminais vivos', () => {
  const contas = groupByAccount([
    live('a', [], '2026-08-29T12:00:00.000Z', 1.2),
    live('a', [], '2026-08-29T12:00:00.000Z', 0.35),
    live('b', [], '2026-08-29T12:00:00.000Z', null)
  ])
  const porId = new Map(contas.map((c) => [c.accountId, c]))
  assert.equal(porId.get('a').costUsd.toFixed(2), '1.55')
  assert.equal(porId.get('a').live, 2)
  // Ninguém publicou custo nesta: `null`, e não US$ 0,00.
  assert.equal(porId.get('b').costUsd, null)
})

test('a janela cujo reset já passou é descartada — não é leitura velha, é falsa', () => {
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 92, resetsAt: PASSADO }], '2026-08-29T12:00:00.000Z')
  ])
  assert.deepEqual(contas[0].limits, [])
})

test('a leitura guardada preenche a conta sem terminal aberto', () => {
  const contas = groupByAccount(
    [],
    [{ accountId: 'a', at: '2026-08-29T11:00:00.000Z', limits: [{ window: '7d', pct: 58, resetsAt: FUTURO }] }]
  )
  assert.equal(contas[0].source, 'stored')
  assert.equal(contas[0].limits[0].pct, 58)
  assert.equal(contas[0].live, 0)
})

test('a guardada NUNCA vence a viva da mesma conta', () => {
  const contas = groupByAccount(
    [live('a', [{ window: '7d', pct: 61, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z')],
    [{ accountId: 'a', at: '2026-08-29T11:00:00.000Z', limits: [{ window: '7d', pct: 58, resetsAt: FUTURO }] }]
  )
  assert.equal(contas[0].source, 'live')
  assert.equal(contas[0].limits[0].pct, 61)
})

test('guardada sem resetsAt é ignorada — não há como julgar se ainda vale', () => {
  // A janela raspada da tela nunca teve prazo. Viva ela serve (é de agora);
  // guardada, mostrá-la seria afirmar um percentual de idade desconhecida.
  const contas = groupByAccount([], [{ accountId: 'a', at: '2026-08-29T11:00:00.000Z', limits: [{ window: '5h', pct: 44, resetsAt: null }] }])
  assert.equal(contas[0].source, 'none')
  assert.deepEqual(contas[0].limits, [])
})

test('conta com terminal aberto e sem leitura sai vazia, e não zerada', () => {
  const semLeitura = {
    accountId: 'a',
    reading: {
      model: null,
      tokens: null,
      contextPct: null,
      contextWindowSize: null,
      costUsd: null,
      limits: [],
      at: null,
      source: 'none'
    }
  }
  const contas = groupByAccount([semLeitura])
  assert.equal(contas[0].source, 'none')
  assert.equal(contas[0].live, 0, 'terminal sem leitura não conta como agente medindo')
  assert.deepEqual(contas[0].limits, [])
})

// ─── O agregado da tira de borda ──────────────────────────────────────────────
//
// A tira mostra DUAS leituras de IA, e elas vêm de recortes diferentes: o custo
// é dos agentes (dólar é a mesma unidade em todo agente), a janela é das contas
// (é a conta que tem o limite). Trocar um recorte pelo outro dá um número
// plausível na borda — dois agentes na mesma conta somariam a janela dela e a
// tira anunciaria um aperto que não existe.

/** Uma leitura de agente, no formato que `dockSummary` consome. */
const leitura = (costUsd, limits = []) => ({
  model: null,
  tokens: null,
  contextPct: null,
  contextWindowSize: null,
  costUsd,
  limits,
  at: '2026-08-29T12:00:00.000Z',
  source: costUsd === null ? 'none' : 'statusline'
})

test('a tira soma o custo e escolhe a janela MAIS APERTADA entre as contas', () => {
  // Duas contas, uma delas sem leitura nenhuma — o caso que a tira vive de
  // verdade, com um agente numa conta logada e outro num terminal que não
  // publica nada.
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 41, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z', 1.2),
    live('b', [{ window: '5h', pct: 88, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z', 0.35)
  ])
  const r = dockSummary([leitura(1.2), leitura(0.35)], contas)
  assert.equal(r.costUsd.toFixed(2), '1.55')
  assert.equal(r.tightest.pct, 88, 'a tira mostrou a janela folgada')
  assert.equal(r.tightest.window, '5h')
})

test('a conta SEM leitura não puxa a janela para baixo — ela é ausência, não zero', () => {
  // Uma média entre 62% e "nada" daria 31%, e a tira diria que sobra folga
  // quando a única conta medida está quase fechando.
  const semLeitura = {
    accountId: 'b',
    reading: {
      model: null,
      tokens: null,
      contextPct: null,
      contextWindowSize: null,
      costUsd: null,
      limits: [],
      at: null,
      source: 'none'
    }
  }
  const contas = groupByAccount([
    live('a', [{ window: '7d', pct: 62, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z', 0.9),
    semLeitura
  ])
  assert.equal(contas.length, 2, 'a conta parada devia continuar existindo na lista')
  const r = dockSummary([leitura(0.9), leitura(null)], contas)
  assert.equal(r.tightest.pct, 62)
  assert.equal(r.tightest.window, '7d')
  // E o custo é o do único agente que publicou — não uma média com o silêncio.
  assert.equal(r.costUsd.toFixed(2), '0.90')
})

test('a janela vence entre CONTAS, não dentro de uma — dois agentes não somam limite', () => {
  // Os dois terminais leem o MESMO contador da conta `a`. Somar daria 84% e a
  // tira ficaria vermelha por um aperto inventado.
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 42, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z', 1),
    live('a', [{ window: '5h', pct: 42, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z', 1)
  ])
  const r = dockSummary([leitura(1), leitura(1)], contas)
  assert.equal(r.tightest.pct, 42)
  // O CUSTO, esse sim, soma: são duas sessões cobradas.
  assert.equal(r.costUsd.toFixed(2), '2.00')
})

test('a tira separa a janela de SESSÃO da mais apertada', () => {
  // O caso que motivou o campo: a semanal está mais cheia, mas quem decide se
  // dá para abrir mais um agente AGORA é a de 5h. Uma tira que só mostrasse a
  // mais apertada responderia sobre um prazo de seis dias.
  const contas = groupByAccount([
    live(
      'a',
      [
        { window: '7d', pct: 81, resetsAt: FUTURO },
        { window: '5h', pct: 33, resetsAt: FUTURO }
      ],
      '2026-08-29T12:00:00.000Z'
    )
  ])
  const r = dockSummary([], contas)
  assert.equal(r.tightest.window, '7d')
  assert.equal(r.session.window, '5h')
  assert.equal(r.session.pct, 33)
})

test('a de sessão é a de MENOR duração, e entre iguais a mais apertada', () => {
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 20, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z'),
    live('b', [{ window: '5h', pct: 64, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z'),
    live('c', [{ window: '7d', pct: 99, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z')
  ])
  const r = dockSummary([], contas)
  assert.equal(r.session.pct, 64, 'entre duas contas na mesma janela vale a mais apertada')
  assert.equal(r.session.resetsAt, FUTURO, 'o prazo acompanha a janela vencedora')
})

test('janela de rótulo ilegível não vira a de sessão — mas ainda conta na apertada', () => {
  // Chutar uma duração elegeria a janela errada como a da sessão, que é pior do
  // que não eleger nenhuma.
  const contas = groupByAccount([
    live('a', [{ window: 'opus', pct: 90, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z')
  ])
  const r = dockSummary([], contas)
  assert.equal(r.tightest.window, 'opus')
  assert.equal(r.session, null)
})

test('windowSpanMinutes lê a duração do rótulo quando a fonte não a publica', () => {
  // `activeWindows` guarda só `window` e `pct`: uma conta restaurada do boot
  // chega sem `windowMinutes`, e sem ler o rótulo ela não teria janela de sessão.
  assert.equal(windowSpanMinutes({ window: '5h' }), 300)
  assert.equal(windowSpanMinutes({ window: '7d' }), 10080)
  assert.equal(windowSpanMinutes({ window: '30min' }), 30)
  // O publicado vence o rótulo — ele é a medida, o rótulo é a tradução dela.
  assert.equal(windowSpanMinutes({ window: '5h', windowMinutes: 240 }), 240)
  assert.equal(windowSpanMinutes({ window: 'limite' }), null)
})

test('ninguém publicando custo dá `null`, e não US$ 0,00', () => {
  // A diferença que o raspador de tela nunca soube marcar: "não gastei nada" e
  // "não sei" não podem sair iguais na borda.
  const r = dockSummary([leitura(null), leitura(null)], [])
  assert.equal(r.costUsd, null)
  assert.equal(r.tightest, null)
  assert.equal(r.session, null)
})

test('canvas vazio: a tira não tem o que dizer sobre IA', () => {
  const r = dockSummary([], [])
  assert.equal(r.costUsd, null)
  assert.equal(r.tightest, null)
  assert.equal(r.session, null)
})

test('empate entre janelas fica com a PRIMEIRA vista — a escolha é determinística', () => {
  // Duas contas no mesmo percentual. Sem regra de desempate a tira trocaria de
  // janela entre dois renders sem que nada tivesse mudado.
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 70, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z'),
    live('b', [{ window: '7d', pct: 70, resetsAt: FUTURO }], '2026-08-29T12:00:00.000Z')
  ])
  const r = dockSummary([], contas)
  assert.equal(r.tightest.window, '5h')
  assert.deepEqual(dockSummary([], contas).tightest, r.tightest)
})

test('a janela vencida não entra na tira — ela foi descartada antes', () => {
  // `groupByAccount` já derruba a janela cujo reset passou (é leitura falsa, não
  // velha). A tira herda isso de graça, e é o que se quer: um `5h 92%` fantasma
  // na borda é pior que borda nenhuma.
  const contas = groupByAccount([
    live('a', [{ window: '5h', pct: 92, resetsAt: PASSADO }], '2026-08-29T12:00:00.000Z', 0.5)
  ])
  const r = dockSummary([leitura(0.5)], contas)
  assert.equal(r.tightest, null)
  assert.equal(r.costUsd.toFixed(2), '0.50')
})

test('activeWindows mantém a janela sem prazo e derruba a vencida', () => {
  const janelas = activeWindows([
    { window: '5h', pct: 30, resetsAt: FUTURO },
    { window: '7d', pct: 80, resetsAt: PASSADO },
    { window: '5h', pct: 44 }
  ])
  assert.deepEqual(
    janelas.map((j) => j.pct),
    [30, 44]
  )
})

test('agoLabel diz a idade da leitura guardada', () => {
  const agora = Date.parse('2026-08-29T12:00:00.000Z')
  assert.equal(agoLabel('2026-08-29T11:59:30.000Z', agora), 'agora')
  assert.equal(agoLabel('2026-08-29T11:20:00.000Z', agora), 'há 40min')
  assert.equal(agoLabel('2026-08-29T09:00:00.000Z', agora), 'há 3h')
  assert.equal(agoLabel('2026-08-27T09:00:00.000Z', agora), 'há 2d')
  assert.equal(agoLabel(null, agora), null)
  assert.equal(agoLabel('nem data é', agora), null)
})

// ─── A instalação no agente ───────────────────────────────────────────────────

test('isClaudeCommand reconhece o preset com argumentos e com caminho', () => {
  assert.equal(isClaudeCommand('claude'), true)
  assert.equal(isClaudeCommand('claude --resume'), true)
  assert.equal(isClaudeCommand('  claude -p "oi"  '), true)
  assert.equal(isClaudeCommand('/usr/local/bin/claude'), true)
  assert.equal(isClaudeCommand('claude.cmd --model opus'), true)
})

test('os outros presets ficam de fora — statusLine é do Claude Code', () => {
  // Não é detalhe: Codex, Antigravity e OpenCode continuam no raspador de tela,
  // e é por isso que ele não sai do código.
  for (const cmd of ['codex', 'antigravity', 'opencode', '', 'npm run claude', 'claude-code']) {
    assert.equal(isClaudeCommand(cmd), false, `${cmd} não deveria contar como Claude Code`)
  }
})

test('o settings gerado instala a statusLine, e nada mais', () => {
  // Sem Artesão o arquivo é exatamente o que sempre foi. É a asserção que
  // impede o Artesão de vazar configuração para os outros nós do canvas.
  const cfg = JSON.parse(agentSettings({ artisan: false }))
  assert.deepEqual(Object.keys(cfg), ['statusLine'], 'o Atelier mexeu em outra chave do usuário')
  assert.equal(cfg.statusLine.type, 'command')
  // Caminho inteiro, e não `atelier statusline`: o PATH do PTY pode ter sido
  // reescrito pelo profile do usuário, e o nome solto resolveria para outro
  // binário — a falha era silenciosa, e o monitor ficava vazio.
  assert.match(cfg.statusLine.command, /^"[^"]*\/bin\/atelier" statusline$/)
})

// ─── Ref-count do amostrador ──────────────────────────────────────────────────
//
// O timer é único e compartilhado: o vazamento aqui é silencioso (o app segue
// amostrando para ninguém pelo resto da sessão) e nenhum teste de UI o pegaria.

await testAsync('o timer só existe enquanto há assinante', async () => {
  const m = new SystemStatsMonitor(() => {}, 20)
  assert.equal(m.running, false)
  m.subscribe()
  assert.equal(m.running, true)
  m.subscribe()
  m.unsubscribe()
  assert.equal(m.running, true, 'desligou com um assinante ainda de pé')
  m.unsubscribe()
  assert.equal(m.running, false, 'o timer sobreviveu ao último desmonte')
  assert.equal(m.refCount, 0)
})

await testAsync('unsubscribe a mais não deixa o contador negativo', async () => {
  const m = new SystemStatsMonitor(() => {}, 20)
  m.unsubscribe()
  m.unsubscribe()
  assert.equal(m.refCount, 0)
  m.subscribe()
  assert.equal(m.running, true, 'o subscribe seguinte ficou sem timer')
  m.reset()
})

await testAsync('o período efetivo é o do assinante MAIS rápido', async () => {
  const m = new SystemStatsMonitor(() => {}, 2000)
  m.subscribe(5000)
  assert.equal(m.intervalMs, 5000)
  m.subscribe(1000)
  assert.equal(m.intervalMs, 1000)
  // O rápido sai: o timer afrouxa de volta em vez de ficar preso em 1s.
  m.unsubscribe(1000)
  assert.equal(m.intervalMs, 5000)
  m.unsubscribe(5000)
  assert.equal(m.running, false)
})

await testAsync('reset desliga tudo — a janela recarregou', async () => {
  const m = new SystemStatsMonitor(() => {}, 20)
  m.subscribe()
  m.subscribe()
  m.reset()
  assert.equal(m.running, false)
  assert.equal(m.refCount, 0)
})

await testAsync('amostras chegam enquanto há assinante e param depois', async () => {
  let n = 0
  const m = new SystemStatsMonitor(() => n++, 20)
  m.subscribe()
  await new Promise((r) => setTimeout(r, 140))
  assert.ok(n >= 2, `esperava ao menos 2 amostras, veio ${n}`)

  m.unsubscribe()
  const depois = n
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(n, depois, `o timer continuou emitindo depois do desmonte (${n - depois} a mais)`)
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
