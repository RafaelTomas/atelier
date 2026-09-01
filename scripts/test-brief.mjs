/**
 * `atelier brief` — o inventário do canvas no boot, para todo nó (M1 do plano
 * de aderência, docs/2026-09-01-PLANO-aderencia-dos-agentes.md).
 *
 * Chama `routeCLI` direto, sem socket — mesmo padrão do test-editor: o
 * protocolo HTTP já é exercitado pelo smoke, e aqui o que interessa é a
 * decisão do handler.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// ATELIER_HOME antes de qualquer import do núcleo — mesma razão do
// test-editor e do test-artesao: sem isto o teste grava no ~/.atelier real.
const home = await mkdtemp(join(tmpdir(), 'atelier-brief-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'

const outdir = await mkdtemp(join(tmpdir(), 'atelier-brief-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { appState } from './src/main/core/state/app-state.ts'
      export { routeCLI } from './src/main/core/interagent/cli-router.ts'
      export { makeCanvasNode } from './src/main/core/models/workspace.ts'
      export {
        makeTerminalContent,
        makeStickyNoteContent,
        makePortalContent,
        makeCodeEditorContent,
        makeDataTableContent,
        makeSecretVaultContent,
        makeWidgetContent
      } from './src/main/core/models/node-content.ts'
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

const core = await import(pathToFileURL(outfile).href)
const {
  appState,
  routeCLI,
  makeCanvasNode,
  makeTerminalContent,
  makeStickyNoteContent,
  makePortalContent,
  makeCodeEditorContent,
  makeDataTableContent,
  makeSecretVaultContent,
  makeWidgetContent
} = core

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
    console.error(`       ${err.message}`)
  }
}

console.log('\nbrief: o inventário do canvas no boot\n')

await appState.loadOnLaunch()
const ws = appState.activeWorkspace

function node(pos, content) {
  const n = makeCanvasNode({ x: pos, y: 0, width: 200, height: 150 }, content)
  ws.addNode(n)
  return n
}

function wire(caller, ...targets) {
  for (const t of targets) ws.addConnection(caller.id, t.id)
}

// ─── Canvas vazio ───────────────────────────────────────────────────────────

await test('canvas vazio: o brief sai em 3 linhas ou menos', async () => {
  const orphan = node(0, { type: 'terminal', value: makeTerminalContent('Sozinho') })
  const out = await routeCLI(['brief'], orphan.id)
  assert.ok(out.split('\n').length <= 3, `brief vazio cresceu: ${out.split('\n').length} linhas`)
  assert.match(out, /nothing wired to this node yet/)
})

// ─── Um nó comum, com um pouco de tudo ─────────────────────────────────────

let caller
let editorFile
await test('brief de um nó comum: um grupo por linha, cada um com o verbo', async () => {
  caller = node(1000, { type: 'terminal', value: makeTerminalContent('Chamador') })
  const peer = node(1100, { type: 'terminal', value: makeTerminalContent('Ajudante') })
  const note = node(1200, { type: 'stickyNote', value: makeStickyNoteContent('Spec') })
  const portal = node(1300, { type: 'portal', value: makePortalContent('Docs', 'https://example.com') })
  editorFile = join(home, 'arquivo.ts')
  const editor = node(1400, { type: 'codeEditor', value: makeCodeEditorContent(editorFile) })
  const vault = node(1500, { type: 'secretVault', value: makeSecretVaultContent('Cofre') })
  const table = node(1600, { type: 'dataTable', value: makeDataTableContent('Vendas') })
  const board = node(1700, { type: 'widget', value: makeWidgetContent('todo', null, { title: 'Sprint' }) })

  wire(caller, peer, note, portal, editor, vault, table, board)

  const out = await routeCLI(['brief'], caller.id)

  assert.match(out, /Agents: Ajudante/)
  assert.match(out, /atelier ask "Name" "the task"/)
  assert.match(out, /Notes: Spec/)
  assert.match(out, /atelier note read "Name"/)
  assert.match(out, /Portals: Docs/)
  assert.match(out, /atelier portal read "Name"/)
  assert.match(out, new RegExp(editorFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'o caminho absoluto do editor não saiu')
  assert.match(out, /atelier editor read "Name"/)
  assert.match(out, /Vaults: Cofre/)
  assert.match(out, /atelier vault list/)
  assert.match(out, /Tables: Vendas/)
  assert.match(out, /atelier table list/)
  assert.match(out, /Boards: Sprint/)
  assert.match(out, /atelier todo list/)

  // Nenhum grupo vazio aparece — não há "(none)" nem grupo que não foi cabeado.
  assert.ok(!/\(none\)/.test(out), 'um grupo vazio vazou como "(none)"')
})

await test('teto de 30 linhas: um canvas típico não estoura', async () => {
  const out = await routeCLI(['brief'], caller.id)
  const n = out.split('\n').length
  assert.ok(n <= 30, `brief típico passou de 30 linhas: ${n}`)
})

await test('sem Artesão, o brief não traz a doutrina', async () => {
  const out = await routeCLI(['brief'], caller.id)
  assert.ok(!out.includes('You are an ARTISAN'), 'a doutrina vazou para um nó comum')
})

// ─── Artesão: a doutrina inteira como bloco ────────────────────────────────

await test('brief de um Artesão: o inventário some ANTES da doutrina inteira', async () => {
  const artisan = node(2000, {
    type: 'terminal',
    value: makeTerminalContent('Artesão', { isArtisan: true })
  })
  const helper = node(2100, { type: 'terminal', value: makeTerminalContent('Recrutado') })
  wire(artisan, helper)

  const out = await routeCLI(['brief'], artisan.id)

  // O inventário genérico continua na frente...
  assert.match(out, /Agents: Recrutado/)
  // ...e a doutrina inteira do Artesão vem depois, como bloco — não some, não
  // vira um resumo. As mesmas regras de `atelier artesao brief`.
  assert.match(out, /You are an ARTISAN on this Atelier canvas\./)
  assert.match(out, /Task\ntool is denied here/)
  assert.match(out, /Rules of the workshop:/)
  assert.match(out, /On this canvas right now:/)
  assert.match(out, /Already cabled to you: Recrutado/)

  const doctrineAt = out.indexOf('You are an ARTISAN on this Atelier canvas.')
  const inventoryAt = out.indexOf('Agents: Recrutado')
  assert.ok(inventoryAt < doctrineAt, 'a doutrina entrou ANTES do inventário')
})

await test('brief de um Artesão sozinho ainda traz a doutrina inteira', async () => {
  const alone = node(3000, {
    type: 'terminal',
    value: makeTerminalContent('Sozinho Artesão', { isArtisan: true })
  })
  const out = await routeCLI(['brief'], alone.id)
  assert.match(out, /nothing wired to this node yet/)
  assert.match(out, /You are an ARTISAN on this Atelier canvas\./)
  assert.match(out, /Nobody is cabled to you yet/)
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed > 0 ? 1 : 0)
