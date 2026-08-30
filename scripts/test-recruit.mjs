import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-recruit-'))
const outfile = join(outdir, 'recruit.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        commandWithPresetModel,
        resolvePresetModel
      } from './src/main/core/interagent/handlers/recruit.ts'
      export { QUICK_STARTS } from './src/shared/terminal-presets.ts'
      export { presetById } from './src/shared/terminal-presets.ts'
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

const { QUICK_STARTS, commandWithPresetModel, presetById, resolvePresetModel } = await import(
  pathToFileURL(outfile).href
)

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

console.log('\nrecruit\n')

test('Codex aliases resolve to full model ids', () => {
  assert.deepEqual(resolvePresetModel('codex', 'luna'), {
    ok: true,
    id: 'gpt-5.6-luna',
    alias: 'luna'
  })
  assert.deepEqual(resolvePresetModel('codex', 'terra'), {
    ok: true,
    id: 'gpt-5.6-terra',
    alias: 'terra'
  })
  assert.deepEqual(resolvePresetModel('codex', 'sol'), {
    ok: true,
    id: 'gpt-5.6-sol',
    alias: 'sol'
  })
})

test('Codex full ids pass through unchanged', () => {
  assert.deepEqual(resolvePresetModel('codex', 'gpt-5.6-terra'), {
    ok: true,
    id: 'gpt-5.6-terra',
    alias: null
  })
})

test('Codex command keeps the preset and appends --model', () => {
  const preset = presetById('codex')
  assert.equal(preset.agentType, 'codex')
  assert.deepEqual(commandWithPresetModel('codex', 'luna'), {
    ok: true,
    command: 'codex --model gpt-5.6-luna',
    id: 'gpt-5.6-luna',
    alias: 'luna'
  })
})

test('Claude behavior is preserved', () => {
  assert.deepEqual(commandWithPresetModel('claude', 'sonnet'), {
    ok: true,
    command: 'claude --model sonnet',
    id: 'sonnet',
    alias: 'sonnet'
  })
  assert.deepEqual(commandWithPresetModel('claude', 'claude-haiku-4-5-20251001'), {
    ok: true,
    command: 'claude --model claude-haiku-4-5-20251001',
    id: 'claude-haiku-4-5-20251001',
    alias: null
  })
})

test('presets without model support reject --model', () => {
  const result = resolvePresetModel('shell', 'terra')
  assert.equal(result.ok, false)
  assert.match(result.error, /does not apply/)
})

test('model token rejects shell metacharacters and whitespace', () => {
  for (const value of ['terra;whoami', '$(whoami)', '"terra"', 'terra sol', '']) {
    const result = resolvePresetModel('codex', value)
    assert.equal(result.ok, false, value)
  }
})

test('the recruited node stays Codex, it does not become a shell', () => {
  // Este e o ponto do recurso. O contorno antigo (`--command "codex --model X"`)
  // abria o processo certo e criava um no `shell`: sem agentType, sem icone,
  // sem cor, sem retomada e sem vinculo com a telemetria do App Server.
  const preset = presetById('codex')
  assert.equal(preset.agentType, 'codex')
  assert.ok(preset.icon, 'o preset carrega o icone que o no herda')
  assert.ok(preset.color, 'e a cor')

  const selecionado = commandWithPresetModel('codex', 'terra')
  assert.equal(selecionado.ok, true)
  assert.ok(
    selecionado.command.startsWith(preset.command),
    'o comando do preset continua na frente — o modelo so e anexado'
  )
})

test('the appended flag is the one the preset declares', () => {
  for (const preset of QUICK_STARTS) {
    if (!preset.model) continue
    const selecionado = commandWithPresetModel(preset.id, Object.keys(preset.model.aliases)[0])
    assert.equal(selecionado.ok, true, preset.id)
    assert.ok(
      selecionado.command.includes(` ${preset.model.flag} `),
      `${preset.id} usa a flag declarada, e nao um --model chutado`
    )
  }
})

test('a preset command that already picks a model rejects --model', () => {
  // Duas fontes de verdade para o modelo e pior que nenhuma: o CLI ficaria com
  // `--model A --model B` e a resposta ao chamador mentiria sobre qual venceu.
  const original = presetById('codex').command
  try {
    presetById('codex').command = 'codex --model gpt-5.6-sol'
    const selecionado = commandWithPresetModel('codex', 'luna')
    assert.equal(selecionado.ok, false)
    assert.match(selecionado.error, /already chooses a model/)
  } finally {
    presetById('codex').command = original
  }
})

test('the reply carries the resolved id, not just the alias', () => {
  // Quem pediu `luna` precisa ver `gpt-5.6-luna` de volta: e o unico jeito de
  // saber que o alias foi entendido, e nao passado adiante como id.
  const selecionado = commandWithPresetModel('codex', 'sol')
  assert.equal(selecionado.alias, 'sol')
  assert.equal(selecionado.id, 'gpt-5.6-sol')
  assert.equal(selecionado.command, 'codex --model gpt-5.6-sol')

  const completo = commandWithPresetModel('codex', 'gpt-5.6-sol')
  assert.equal(completo.alias, null, 'id completo nao inventa um alias')
  assert.equal(completo.id, 'gpt-5.6-sol')
})

test('an id the Atelier does not know still passes: the catalogue is the CLI one', () => {
  // Fechar a lista de ids envelheceria o Atelier a cada modelo novo. O que se
  // valida aqui e a FORMA do token; o erro de catalogo e o Codex que mostra.
  const selecionado = resolvePresetModel('codex', 'gpt-9.9-inexistente')
  assert.equal(selecionado.ok, true)
  assert.equal(selecionado.id, 'gpt-9.9-inexistente')
  assert.equal(selecionado.alias, null)
})

test('every preset without a model selector rejects --model by name', () => {
  const semModelo = QUICK_STARTS.filter((p) => !p.model).map((p) => p.id)
  assert.ok(semModelo.length > 0, 'ha preset sem seletor de modelo')
  for (const id of semModelo) {
    const selecionado = resolvePresetModel(id, 'terra')
    assert.equal(selecionado.ok, false, id)
    assert.match(selecionado.error, new RegExp(`'${id}' preset`))
  }
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
