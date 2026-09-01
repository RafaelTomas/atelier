/**
 * Detecção de espera — o piso de raspagem do M7.
 *
 * A tela do `waiting-claude-permission.txt` não é inventada: é um nó `Cobaia`
 * de verdade que parou num diálogo de permissão do Bash, capturado com
 * `atelier check "Cobaia" 60` em 01/09/2026. Ela existe porque as duas
 * armadilhas desta detecção só aparecem em tela real:
 *
 *   • o TUI come os espaços, e o texto chega como `Doyouwanttoproceed`;
 *   • `check` devolve scrollback, e um diálogo JÁ RESPONDIDO continua no
 *     buffer — foi esse o falso positivo que derrubou a primeira tentativa.
 *
 * Uso: node scripts/test-waiting.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const outdir = await mkdtemp(join(tmpdir(), 'atelier-waiting-'))
const outfile = join(outdir, 'status.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { detectWaiting } from './src/main/core/terminal/agent-status.ts'
      export { ASK_TIMEOUT_LINE, ASK_WAITING_LINE } from './src/main/core/interagent/handlers/ask.ts'
      export { agentSettings } from './src/main/core/terminal/agent-settings.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron', 'node-pty'],
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const mod = await import(pathToFileURL(outfile).href)
const { detectWaiting, ASK_TIMEOUT_LINE, ASK_WAITING_LINE, agentSettings } = mod
const cli = await import(pathToFileURL(join(ROOT, 'resources/atelier.cjs')).href)
const { OUTCOMES, exitCodeFor } = cli.default ?? cli

const REAL = await readFile(join(ROOT, 'scripts/fixtures/waiting-claude-permission.txt'), 'utf8')
const QUESTION = await readFile(join(ROOT, 'scripts/fixtures/waiting-claude-question.txt'), 'utf8')

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

console.log('\nDetecção de espera\n')

test('a tela real de um diálogo de permissão é reconhecida', () => {
  const r = detectWaiting(REAL)
  assert.ok(r, 'a tela que motivou este módulo não casou')
  assert.equal(r.kind, 'permission')
})

test('o comando sob revisão sai da linha que sobrevive ao redesenho', () => {
  // `⎿  $ command -v atelier` chega íntegra; o rótulo e a descrição, não.
  assert.equal(detectWaiting(REAL).detail, 'command -v atelier')
})

test('a frase COM espaços também casa — o TUI nem sempre os come', () => {
  const clean = [
    'Bash command',
    '  ⎿  $ rm -rf /tmp/x',
    'This command requires approval',
    'Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    'Esc to cancel'
  ].join('\n')
  const r = detectWaiting(clean)
  assert.ok(r, 'a forma limpa do mesmo diálogo não casou')
  assert.equal(r.detail, 'rm -rf /tmp/x')
})

test('um diálogo JÁ RESPONDIDO, rolado para cima, não casa mais', () => {
  // O falso positivo que derrubou a primeira tentativa: `check` devolve
  // scrollback, então o diálogo antigo continua no texto para sempre.
  const depois = REAL + '\n' + Array.from({ length: 60 }, (_, i) => `● linha nova ${i}`).join('\n')
  assert.equal(detectWaiting(depois), null, 'o diálogo antigo continuou casando')
})

test('um agente trabalhando não é confundido com um parado', () => {
  const trabalhando = [
    '● Vou ler o arquivo e responder.',
    '  ⎿  $ cat package.json',
    '✽ Fermenting… (4s · ↓ 276 tokens)',
    'esc to interrupt'
  ].join('\n')
  assert.equal(detectWaiting(trabalhando), null)
})

test('falar SOBRE permissões não é estar esperando uma', () => {
  // A pergunta sozinha aparece em conversa comum. O que faz um diálogo é a
  // lista de opções logo abaixo.
  const conversa = [
    '● O diálogo do Claude pergunta "Do you want to proceed?" quando um',
    '  comando precisa de aprovação. Você responde com o número.',
    '❯ '
  ].join('\n')
  assert.equal(detectWaiting(conversa), null)
})

test('tela vazia e shell puro voltam null, nunca waiting inventado', () => {
  assert.equal(detectWaiting(''), null)
  assert.equal(detectWaiting('eduardo@maquina:~/projeto$ '), null)
  assert.equal(detectWaiting('\n'.repeat(200)), null)
})

test('a janela do fim é contada em \\r, não só em \\n', () => {
  // A tela real traz 116 \\r contra 7 \\n. Fatiando só por \\n, a tela inteira
  // vira oito linhas, a janela pega tudo, e a defesa contra o diálogo já
  // respondido para de defender. Este é o teste que prova a fatia.
  const crs = (REAL.match(/\r/g) || []).length
  const lfs = (REAL.match(/\n/g) || []).length
  assert.ok(crs > lfs * 5, `a fixture perdeu os \\r: ${crs} vs ${lfs}`)

  // Mesmo cenário do teste anterior, mas com o TUI separando como ele separa.
  const depois = REAL + Array.from({ length: 60 }, (_, i) => `● linha nova ${i}`).join('\r')
  assert.equal(detectWaiting(depois), null, 'o diálogo antigo casou por causa do \\r')
})

test('detail é null quando o comando não aparece na forma legível', () => {
  const semEco = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\nEsc to cancel'
  const r = detectWaiting(semEco)
  assert.ok(r, 'o diálogo não casou')
  assert.equal(r.detail, null, 'inventou um rótulo em vez de admitir que não sabe')
})

// ─── O contrato entre o app e o CLI ───────────────────────────────────────────

test('as linhas-sentinela do ask são as MESMAS nos dois lados', () => {
  // O CLI é um .cjs autônomo, instalado no PATH do usuário, e não importa nada
  // de src/. As duas cópias literais só continuam iguais se algo falhar quando
  // se separarem — e é este teste. Sem ele, o CLI volta a sair com 0 em
  // silêncio, que é o defeito exato que o sentinela conserta.
  const lines = OUTCOMES.map((o) => o.line).sort()
  assert.deepEqual(lines, [ASK_WAITING_LINE, ASK_TIMEOUT_LINE].sort())
})

test('cada desfecho tem código próprio, e nenhum é 0', () => {
  const codes = OUTCOMES.map((o) => o.code)
  assert.equal(new Set(codes).size, codes.length, 'dois desfechos com o mesmo código')
  assert.ok(!codes.includes(0), 'um desfecho sem resposta saindo como sucesso')
})

test('o CLI só sai != 0 quando o sentinela é a ÚLTIMA linha', () => {
  assert.equal(exitCodeFor(`resposta do agente\n${ASK_TIMEOUT_LINE}`), 2)
  assert.equal(exitCodeFor(`resposta\n${ASK_WAITING_LINE}\n`), 3)
  assert.equal(exitCodeFor('uma resposta perfeitamente normal'), 0)
  // No MEIO não conta: seria a resposta do agente citando a linha, não o app.
  assert.equal(exitCodeFor(`${ASK_TIMEOUT_LINE}\nmais texto depois`), 0)
})

// ─── O hook que produz o sinal ────────────────────────────────────────────────

test('todo nó Claude Code ganha o hook Notification, Artesão ou não', () => {
  for (const artisan of [true, false]) {
    const cfg = JSON.parse(agentSettings({ artisan }))
    const hook = cfg.hooks.Notification[0].hooks[0]
    assert.equal(hook.type, 'command')
    assert.match(hook.command, /^"[^"]*\/bin\/atelier" waiting$/, `artisan=${artisan}`)
  }
})

test('o Notification não atropela os hooks que já existiam', () => {
  const cfg = JSON.parse(agentSettings({ artisan: true }))
  assert.ok(cfg.hooks.SessionStart, 'o brief sumiu')
  assert.ok(cfg.hooks.PreToolUse, 'o bloqueio do Task sumiu')
  assert.ok(cfg.statusLine, 'a barra de status sumiu')
})

// ─── A outra parada: AskUserQuestion ──────────────────────────────────────────
//
// Tela real do `Sujeito S5-a` (sonnet, conta FCX, 01/09): o agente descobriu que
// faltava uma variável de ambiente e parou para perguntar como proceder. Antes
// desta detecção, o harness do eval PONTUOU essa corrida como se ela tivesse
// terminado — o pior desfecho possível, porque entra no relatório como número.

test('a lista de opções do AskUserQuestion é espera, não fim de trabalho', () => {
  const reason = detectWaiting(QUESTION)
  assert.ok(reason, 'a pergunta com lista de opções não foi vista')
  assert.equal(reason.kind, 'question')
})

test('a pergunta e a permissão não se confundem', () => {
  assert.equal(detectWaiting(REAL).kind, 'permission')
  assert.equal(detectWaiting(QUESTION).kind, 'question')
})

test('o detalhe da pergunta sai legível, ou não sai', () => {
  const { detail } = detectWaiting(QUESTION)
  // `null` é resposta válida: um rótulo com os espaços comidos seria pior que
  // nenhum. O que não pode é vir lixo.
  if (detail !== null) {
    assert.match(detail, /^asking: /)
    assert.match(detail, /\s\w/, 'rótulo sem espaço nenhum é tela comida, não rótulo')
  }
})

test('a frase solta numa conversa não inventa espera', () => {
  // Sem a lista numerada, `Enter to select` no meio de um texto é só texto.
  assert.equal(detectWaiting('o rodapé diz Enter to select quando há lista'), null)
})

await rm(outdir, { recursive: true, force: true })
console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
