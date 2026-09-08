/**
 * `atelier list` — o inventário do que está cabeado, por bloco.
 *
 * Não havia teste para este handler, e ele é a resposta que TODO agente lê
 * antes de agir. Nasceu com a mudança de 08/09
 * (docs/2026-09-08-PLANO-todo-no-cabeado-e-com-referencia.md), que acrescentou
 * cinco blocos: árvore, imagem, painel, botão/relógio e título. Sete tipos de
 * nó eram invisíveis aqui, e um nó invisível no inventário não existe para o
 * agente.
 *
 * Chama `routeCLI` direto, sem socket — mesmo padrão do test-brief e do
 * test-editor: o protocolo já é exercitado pelo smoke, e aqui o que interessa
 * é a decisão do handler.
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
const home = await mkdtemp(join(tmpdir(), 'atelier-list-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'

const outdir = await mkdtemp(join(tmpdir(), 'atelier-list-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { appState } from './src/main/core/state/app-state.ts'
      export { routeCLI } from './src/main/core/interagent/cli-router.ts'
      export { makeCanvasNode } from './src/main/core/models/workspace.ts'
      export {
        withCodexInstructions,
        tomlSingleLine
      } from './src/main/core/terminal/codex-instructions.ts'
      export {
        makeTerminalContent,
        makeStickyNoteContent,
        makePortalContent,
        makeCodeEditorContent,
        makeDataTableContent,
        makeSecretVaultContent,
        makeImageContent,
        makeWidgetContent
      } from './src/main/core/models/node-content.ts'
      export { projectIndex } from './src/main/core/state/project-store.ts'
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
  makeImageContent,
  makeWidgetContent,
  projectIndex,
  withCodexInstructions,
  tomlSingleLine
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

console.log('\nlist: o inventário do que está cabeado\n')

await appState.loadOnLaunch()
const ws = appState.activeWorkspace

function node(pos, content) {
  const n = makeCanvasNode({ x: pos, y: 0, width: 200, height: 150 }, content)
  ws.addNode(n)
  return n
}

// ─── Canvas sem nada cabeado ────────────────────────────────────────────────

await test('sem nada cabeado, a resposta diz o que fazer em vez de listar vazio', async () => {
  const sozinho = node(0, { type: 'terminal', value: makeTerminalContent('Sozinho') })
  const out = await routeCLI(['list'], sozinho.id)
  assert.match(out, /No connected agents, notes or portals/)
  assert.match(out, /Connect this terminal to another node/)
})

// ─── Um de cada tipo ────────────────────────────────────────────────────────

let out
await test('todo tipo de nó cabeado aparece, com a referência dele', async () => {
  const caller = node(1000, { type: 'terminal', value: makeTerminalContent('Chamador') })
  const alvos = [
    node(1100, { type: 'fileTree', value: { name: 'Projeto', rootPath: home, viewMode: 'list' } }),
    node(1200, { type: 'image', value: makeImageContent('Gráfico', { mimeType: 'image/png', naturalWidth: 1200, naturalHeight: 640 }) }),
    node(1300, { type: 'dataTable', value: makeDataTableContent('Vendas') }),
    node(1400, { type: 'widget', value: makeWidgetContent('git', null, {}) }),
    node(1500, { type: 'widget', value: makeWidgetContent('monitor', null, { disk: '/', interval: '2000' }) }),
    node(1600, { type: 'widget', value: makeWidgetContent('projects', null, {}) }),
    node(1700, { type: 'widget', value: makeWidgetContent('button', null, { label: 'Testes', action: 'command', command: 'npm test' }) }),
    node(1800, { type: 'widget', value: makeWidgetContent('clock', null, { mode: 'stopwatch' }) }),
    node(1900, { type: 'text', value: { text: 'Fluxo de deploy', fontSize: 18, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans' } }),
    node(2000, { type: 'secretVault', value: makeSecretVaultContent('AWS') })
  ]
  for (const t of alvos) ws.addConnection(caller.id, t.id)
  out = await routeCLI(['list'], caller.id)

  // A árvore: o rootPath é a entrega inteira dela.
  assert.match(out, /Connected file trees:/)
  assert.match(out, new RegExp(`Projeto\\s+${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  // Imagem e tabela: as dimensões e as contagens continuam, mas agora com o
  // CAMINHO do arquivo gerenciado — que é o que dispensa verbo de leitura.
  assert.match(out, /Connected images:/)
  assert.match(out, /Gráfico\s+1200×640\s+\S*[/\\]images[/\\]\S+\.png/)
  assert.match(out, /Connected tables:/)
  assert.match(out, /Vendas\s+0 rows × 0 cols\s+\S*[/\\]tables[/\\]\S+\.json/)
  assert.match(out, /Read the rows from that JSON with your own tools/)

  // Painéis: uma linha cada. O de git sem projeto DIZ que não sabe, em vez de
  // calar ou de supor um repositório.
  assert.match(out, /Connected panels:/)
  assert.match(out, /Git\s+no project selected/)
  assert.match(out, /Monitor\s+volume \/\s+\(every 2s\)/)
  assert.match(out, /follows the app selection/)

  assert.match(out, /Connected buttons and clocks:/)
  assert.match(out, /Testes\s+\[command\] npm test\s+\(armed\)/)
  assert.match(out, /stopwatch/)

  assert.match(out, /Connected text:/)
  assert.match(out, /"Fluxo de deploy"/)

  // E os blocos que já existiam continuam de pé.
  assert.match(out, /Connected vaults:/)
  assert.match(out, /AWS\s+0 keys/)
})

await test('nenhum bloco vazio aparece', async () => {
  // Um canvas com dez tipos cabeados não tem por que listar "Connected boards:"
  // sem quadro nenhum. Grupo vazio some, e é o que mantém a resposta legível.
  assert.ok(!/Connected boards:/.test(out), 'um bloco sem membro vazou')
  assert.ok(!/Connected editors:/.test(out), 'um bloco sem membro vazou')
  assert.ok(!/Connected portals:/.test(out), 'um bloco sem membro vazou')
})

await test('o texto do título sai INTEIRO, não cortado em 24 caracteres', async () => {
  // `nodeDisplayName` corta o texto em 24 chars para caber num cabeçalho de nó.
  // No inventário isso mutilaria o contexto: um título de canvas é curto e é
  // todo ele o que o agente precisa saber.
  const caller = node(3000, { type: 'terminal', value: makeTerminalContent('Longo') })
  const longo = 'Migração do DW para o cluster novo, fase 2'
  const titulo = node(3100, { type: 'text', value: { text: longo, fontSize: 18, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans' } })
  ws.addConnection(caller.id, titulo.id)

  const saida = await routeCLI(['list'], caller.id)
  assert.match(saida, new RegExp(`"${longo}"`), 'o título saiu cortado')
})

// ─── O escopo é o CABO ──────────────────────────────────────────────────────

await test('nó que não está cabeado a quem pergunta NÃO aparece', async () => {
  // A regra de sempre, e ela vale para os tipos novos: `atelier list` responde
  // "com o que EU estou cabeado". Um botão do canvas de outra pessoa não é
  // assunto de quem pergunta — ao contrário de `atelier button list`, que varre
  // o canvas (a incoerência está registrada na referência dos nós).
  const estranho = node(4000, { type: 'terminal', value: makeTerminalContent('Estranho') })
  node(4100, { type: 'fileTree', value: { name: 'SegredoDeOutro', rootPath: home, viewMode: 'list' } })

  const saida = await routeCLI(['list'], estranho.id)
  assert.ok(!/SegredoDeOutro/.test(saida), 'vazou uma árvore não cabeada')
  assert.match(saida, /No connected agents/)
})

await rm(home, { recursive: true, force: true })
console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed > 0 ? 1 : 0)
