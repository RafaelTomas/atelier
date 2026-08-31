/**
 * Extração da resposta em `atelier ask`.
 *
 * Os buffers abaixo são recortes REAIS, capturados dos três presets que dá para
 * rodar nesta máquina (claude_code, codex, generic_shell). O ponto do teste é a
 * regressão que motivou a correção: o Claude Code redesenha sem `\n` e a versão
 * antiga do extrator devolvia string vazia, enquanto o shell — único caso em que
 * a heurística antiga funcionava — não pode piorar.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const outdir = await mkdtemp(join(tmpdir(), 'atelier-ask-'))
const outfile = join(outdir, 'ask.mjs')

await esbuild.build({
  stdin: {
    contents: `export { stripPromptForTest } from './src/main/core/interagent/handlers/ask.ts'`,
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

const { stripPromptForTest: strip } = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}

const QUESTION =
  'Responda apenas com o numero, sem explicacao: quantas linhas tem src/main/core/connection/skill-injector.ts ?'

// claude_code: uma linha só, sem \n, com o eco repetido e caracteres comidos
// pelo redesenho parcial ("skill-injctor.ts"). Era o caso que voltava vazio.
const CLAUDE_BUFFER =
  '❯ Responda apenas com o numero, sem explicacao: quantas linhas tem     src/main/core/connection/skill-injector.ts ?    Reading...' +
  '❯ Responda apenas com o numero, sem explicacao: quantas linhas tem     src/main/core/connection/skill-injctor.ts ?      Read 1 file ● 513 Cooked for 4s · done 17:46'

test('claude_code: resposta sobrevive ao redesenho de tela cheia', () => {
  const out = strip(CLAUDE_BUFFER, QUESTION)
  assert.notEqual(out.trim(), '', 'voltou vazio — a regressão original')
  assert.match(out, /513/)
})

test('claude_code: corta no ÚLTIMO eco, não no primeiro', () => {
  const out = strip(CLAUDE_BUFFER, QUESTION)
  assert.doesNotMatch(out, /Reading/, 'trouxe lixo anterior ao último eco')
})

// codex: emite \n de verdade entre os blocos.
const CODEX_BUFFER = `› ${QUESTION}\n\n• 512\n\n─────`

test('codex: extrai a resposta e descarta o eco', () => {
  const out = strip(CODEX_BUFFER, QUESTION)
  assert.match(out, /512/)
  assert.doesNotMatch(out, /Responda apenas/)
})

// generic_shell: o comando longo sofre wrap e o eco ocupa DUAS linhas visuais.
// A heurística antiga (slice(1)) deixava o "ts" da segunda linha vazar.
const SHELL_CMD = 'wc -l < src/main/core/connection/skill-injector.ts'
const SHELL_BUFFER = 'wc -l < src/main/core/connection/skill-injector.\nts\n512\n'

test('generic_shell: eco quebrado por wrap não vaza para a resposta', () => {
  const out = strip(SHELL_BUFFER, SHELL_CMD)
  assert.equal(out.trim(), '512')
})

test('generic_shell: caso simples continua limpo', () => {
  assert.equal(strip('echo PONG\nPONG\n', 'echo PONG').trim(), 'PONG')
})

// Degradação: sem casar o eco, devolver tudo é preferível a devolver nada.
test('eco ausente devolve o texto, nunca vazio', () => {
  const out = strip('resposta solta sem eco algum', 'um prompt que nao aparece ali')
  assert.match(out, /resposta solta/)
})

test('prompt vazio não quebra', () => {
  assert.equal(strip('abc', '').trim(), 'abc')
})

console.log(`\n${passed} passed, ${failed} failed`)
await rm(outdir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
