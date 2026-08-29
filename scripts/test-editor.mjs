/**
 * Editor no cabo — o registro do main e o comando `atelier editor`.
 *
 * As duas coisas que este arquivo protege não são conveniências:
 *
 *   1. **O buffer sujo vence o disco.** Um editor com alteração pendente tem em
 *      disco a versão MORTA. Se `read` devolvesse o arquivo, o agente
 *      trabalharia em cima do que o usuário acabou de apagar — e não teria como
 *      perceber. O caso `read de editor sujo devolve o buffer` é o teste desta
 *      feature; os outros são as bordas dele.
 *   2. **Ausência de estado é "não sei", nunca "salvo".** Nó fora da tela não
 *      empurra nada, e afirmar que está limpo é o mesmo dano do item 1.
 *
 * Mais as recusas do CLI: caminho fora da allowlist, caminho já aberto noutro
 * nó, `close` com buffer sujo e `--selection` sem seleção. Cada uma existe
 * porque a alternativa é perda silenciosa de trabalho do usuário.
 *
 * Chama `routeCLI` direto, sem socket: o protocolo HTTP já é exercitado pelo
 * smoke, e aqui o que interessa é a decisão do handler.
 *
 * Uso: node scripts/test-editor.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// ATELIER_HOME antes de qualquer import do núcleo: paths.ts o lê para decidir
// onde o manifest mora, e um teste que grava no diretório real do usuário é um
// teste que apaga o canvas dele.
const home = await mkdtemp(join(tmpdir(), 'atelier-editor-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'

const outdir = await mkdtemp(join(tmpdir(), 'atelier-editor-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { appState } from './src/main/core/state/app-state.ts'
      export { routeCLI } from './src/main/core/interagent/cli-router.ts'
      export {
        setEditorState,
        clearEditorState,
        editorState,
        resetEditors
      } from './src/main/core/editor/editor-registry.ts'
      export { makeCanvasNode } from './src/main/core/models/workspace.ts'
      export {
        makeTerminalContent,
        makeCodeEditorContent
      } from './src/main/core/models/node-content.ts'
      export { allowedRoots } from './src/main/core/projects/allowed-roots.ts'
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
const { appState, routeCLI } = core
const { setEditorState, clearEditorState, editorState, resetEditors } = core
const { makeCanvasNode, makeTerminalContent, makeCodeEditorContent } = core

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

console.log('\neditor: registro do main e `atelier editor`\n')

// ─── Registro (core/editor/editor-registry.ts) ───────────────────────────────

const NODE = 'AAAAAAAA-0000-0000-0000-00000000000A'

function state(over = {}) {
  return { path: '/tmp/x.ts', dirty: false, selection: null, cursorLine: 1, buffer: null, ...over }
}

await test('nó sem push é null — "não sei", que é diferente de "salvo"', () => {
  resetEditors()
  assert.equal(editorState(NODE), null)
})

await test('push guarda caminho, cursor e seleção como vieram', () => {
  resetEditors()
  setEditorState(NODE, state({ cursorLine: 42, selection: { from: 10, to: 12 } }))
  const got = editorState(NODE)
  assert.equal(got.path, '/tmp/x.ts')
  assert.equal(got.cursorLine, 42)
  assert.deepEqual(got.selection, { from: 10, to: 12 })
})

await test('push LIMPO não guarda buffer, mesmo se o renderer mandar texto', () => {
  // A trava é aqui, não no remetente: uma cópia velha viva no main sobreviveria
  // ao save e seria devolvida como se fosse o arquivo.
  resetEditors()
  setEditorState(NODE, state({ dirty: false, buffer: 'texto velho' }))
  assert.equal(editorState(NODE).buffer, null)
})

await test('push sujo guarda o buffer', () => {
  resetEditors()
  setEditorState(NODE, state({ dirty: true, buffer: 'linha nova' }))
  assert.equal(editorState(NODE).buffer, 'linha nova')
})

await test('push substitui a entrada inteira, não casa campo a campo', () => {
  resetEditors()
  setEditorState(NODE, state({ dirty: true, buffer: 'a', selection: { from: 1, to: 2 } }))
  setEditorState(NODE, state({ dirty: true, buffer: 'b' }))
  const got = editorState(NODE)
  assert.equal(got.buffer, 'b')
  assert.equal(got.selection, null, 'seleção antiga sobreviveu ao push novo')
})

await test('desmonte do nó apaga a entrada', () => {
  resetEditors()
  setEditorState(NODE, state({ dirty: true, buffer: 'a' }))
  clearEditorState(NODE)
  assert.equal(editorState(NODE), null)
})

// ─── `atelier editor` ────────────────────────────────────────────────────────

await appState.loadOnLaunch()
const ws = appState.activeWorkspace

// A allowlist do `open` sai daqui: o diretório de trabalho do workspace é uma
// das raízes permitidas (ver core/projects/allowed-roots.ts).
const lab = await realpath(await mkdtemp(join(tmpdir(), 'atelier-editor-lab-')))
await mkdir(join(lab, 'sub'), { recursive: true })
ws.payload.workingDirectory = lab

const ALVO = join(lab, 'alvo.ts')
const DISCO = 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n'
await writeFile(ALVO, DISCO)

const terminal = makeCanvasNode(
  { x: 100, y: 100, width: 560, height: 360 },
  { type: 'terminal', value: makeTerminalContent('Agente') }
)
ws.addNode(terminal)
const tid = terminal.id

const cli = (...args) => routeCLI(args, tid)

await test('editor list sem editor conectado ensina o caminho de saída', async () => {
  const out = await cli('editor', 'list')
  assert.match(out, /No editors connected/)
  assert.match(out, /atelier editor open/)
})

await test('open fora da allowlist recusa e NÃO cria nó', async () => {
  const antes = ws.nodes.length
  const out = await cli('editor', 'open', '/etc/passwd')
  assert.match(out, /outside the paths/)
  assert.equal(ws.nodes.length, antes, 'criou nó apesar da recusa')
})

await test('open de caminho relativo é recusado', async () => {
  assert.match(await cli('editor', 'open', 'src/app.ts'), /outside the paths/)
})

await test('open de caminho inexistente diz que não existe, não "sem permissão"', async () => {
  // Dentro da raiz permitida: a resposta honesta é "não há esse arquivo".
  const out = await cli('editor', 'open', join(lab, 'nao-existe.ts'))
  assert.match(out, /no such file/)
})

let editorNodeId

await test('open dentro da allowlist cria o nó já cabeado ao chamador', async () => {
  const out = await cli('editor', 'open', ALVO)
  assert.match(out, /Opened 'alvo\.ts'/)
  assert.ok(out.includes(ALVO), 'a resposta não trouxe o caminho absoluto')

  const criados = ws.nodes.filter((n) => n.content.type === 'codeEditor')
  assert.equal(criados.length, 1)
  editorNodeId = criados[0].id

  const conn = ws.connections.find(
    (c) => c.nodeIdA === editorNodeId || c.nodeIdB === editorNodeId
  )
  assert.ok(conn, 'nasceu sem cabo — o agente não alcançaria o próprio editor')
  // Decisão A: o par reusa o cabo `data`, sem kind novo e sem subir schema.
  assert.equal(conn.kind, 'data')
  assert.equal(conn.nodeIdA, tid, 'o terminal tem de ser o lado A do cabo data')
})

await test('open do MESMO caminho devolve o nó existente, sem segundo buffer', async () => {
  const antes = ws.nodes.length
  const out = await cli('editor', 'open', ALVO)
  assert.match(out, /already open/)
  assert.match(out, /already connected to this terminal/)
  assert.equal(ws.nodes.length, antes, 'criou um segundo editor do mesmo arquivo')
})

await test('open de caminho já aberto NOUTRO nó cabeia em vez de duplicar', async () => {
  const outro = join(lab, 'sub', 'orfao.ts')
  await writeFile(outro, 'x\n')
  // Nó posto na mão, sem cabo para ninguém — como um editor que o usuário abriu.
  const solto = makeCanvasNode(
    { x: 3000, y: 3000, width: 620, height: 440 },
    { type: 'codeEditor', value: makeCodeEditorContent(outro) }
  )
  ws.addNode(solto)
  const antes = ws.nodes.length

  const out = await cli('editor', 'open', outro)
  assert.match(out, /already open/)
  assert.match(out, /now connected to this terminal/)
  assert.equal(ws.nodes.length, antes, 'duplicou o editor em vez de reusar')
  assert.ok(ws.connectedNodeIds(tid).includes(solto.id), 'não cabeou o nó existente')

  ws.removeNode(solto.id)
})

await test('editor list imprime o caminho absoluto', async () => {
  resetEditors()
  const out = await cli('editor', 'list')
  assert.match(out, /Connected editors/)
  assert.ok(out.includes(ALVO), 'a listagem não trouxe o caminho absoluto')
  // Sem registro, nada é afirmado sobre o buffer.
  assert.doesNotMatch(out, /unsaved changes/)
  assert.doesNotMatch(out, /cursor line/)
})

await test('editor list mostra sujo, cursor e seleção quando o registro sabe', async () => {
  resetEditors()
  setEditorState(editorNodeId, state({ path: ALVO, dirty: true, buffer: 'x', cursorLine: 7 }))
  let out = await cli('editor', 'list')
  assert.match(out, /unsaved changes/)
  assert.match(out, /cursor line 7/)

  setEditorState(
    editorNodeId,
    state({ path: ALVO, dirty: false, cursorLine: 7, selection: { from: 2, to: 3 } })
  )
  out = await cli('editor', 'list')
  assert.match(out, /selected lines 2-3/)
  assert.doesNotMatch(out, /unsaved changes/)
})

await test('atelier list ganhou a seção dos editores', async () => {
  resetEditors()
  const out = await cli('list')
  assert.match(out, /Connected editors/)
  assert.ok(out.includes(ALVO))
  assert.match(out, /edit the file with your own tools/)
})

await test('read de editor limpo lê o disco', async () => {
  resetEditors()
  assert.equal(await cli('editor', 'read', 'alvo.ts'), DISCO)
})

await test('read de editor SUJO devolve o buffer, não o disco', async () => {
  // O caso que justifica a feature inteira: em disco está a versão morta.
  resetEditors()
  setEditorState(
    editorNodeId,
    state({ path: ALVO, dirty: true, buffer: 'const a = 99\n', cursorLine: 1 })
  )
  const out = await cli('editor', 'read', 'alvo.ts')
  assert.match(out, /^# unsaved changes — not on disk\n/)
  assert.ok(out.includes('const a = 99'), 'não devolveu o buffer')
  assert.ok(!out.includes('const b = 2'), 'devolveu o conteúdo do disco por baixo do buffer')
})

await test('read com offset/limit corta em LINHAS, como o note read', async () => {
  resetEditors()
  assert.equal(await cli('editor', 'read', 'alvo.ts', '1', '2'), 'const b = 2\nconst c = 3')
})

await test('read --selection devolve só as linhas selecionadas', async () => {
  resetEditors()
  setEditorState(
    editorNodeId,
    state({ path: ALVO, dirty: false, cursorLine: 3, selection: { from: 2, to: 3 } })
  )
  const out = await cli('editor', 'read', 'alvo.ts', '--selection')
  assert.match(out, /# lines 2-3, selected by the user/)
  assert.ok(out.includes('const b = 2') && out.includes('const c = 3'))
  assert.ok(!out.includes('const a = 1'), 'trouxe linha fora da seleção')
  assert.ok(!out.includes('const d = 4'), 'trouxe linha fora da seleção')
})

await test('--selection sem seleção ERRA, nunca inventa recorte', async () => {
  resetEditors()
  setEditorState(editorNodeId, state({ path: ALVO, cursorLine: 3 }))
  const out = await cli('editor', 'read', 'alvo.ts', '--selection')
  assert.match(out, /nothing selected/)
  assert.match(out, /line 3/)
  assert.ok(!out.includes('const a = 1'), 'caiu para o arquivo inteiro')
})

await test('--selection sem registro diz que o nó não está na tela', async () => {
  resetEditors()
  const out = await cli('editor', 'read', 'alvo.ts', '--selection')
  assert.match(out, /nothing selected/)
  assert.match(out, /not on screen/)
})

await test('--selection funciona junto com o buffer sujo', async () => {
  resetEditors()
  setEditorState(
    editorNodeId,
    state({ path: ALVO, dirty: true, buffer: 'um\ndois\ntrês\n', selection: { from: 2, to: 2 } })
  )
  const out = await cli('editor', 'read', 'alvo.ts', '--selection')
  assert.match(out, /# unsaved changes — not on disk/)
  assert.match(out, /# lines 2-2/)
  assert.ok(out.includes('dois'))
  assert.ok(!out.includes('três'))
})

await test('editor não conectado ao chamador não é alcançável', async () => {
  resetEditors()
  const outroTerminal = makeCanvasNode(
    { x: 5000, y: 5000, width: 560, height: 360 },
    { type: 'terminal', value: makeTerminalContent('Estranho') }
  )
  ws.addNode(outroTerminal)
  const out = await routeCLI(['editor', 'read', 'alvo.ts'], outroTerminal.id)
  assert.match(out, /not found/)
  ws.removeNode(outroTerminal.id)
})

await test('close com buffer sujo RECUSA e o nó continua no canvas', async () => {
  resetEditors()
  setEditorState(editorNodeId, state({ path: ALVO, dirty: true, buffer: 'não salvo' }))
  const out = await cli('editor', 'close', 'alvo.ts')
  assert.match(out, /unsaved changes/)
  assert.ok(ws.node(editorNodeId), 'fechou o editor sujo')
})

await test('close de editor limpo remove o nó', async () => {
  resetEditors()
  const out = await cli('editor', 'close', 'alvo.ts')
  assert.match(out, /Closed editor 'alvo\.ts'/)
  assert.equal(ws.node(editorNodeId), undefined)
})

await test('close de editor inexistente não derruba nada', async () => {
  assert.match(await cli('editor', 'close', 'alvo.ts'), /not found/)
})

await test('subcomando desconhecido devolve o uso', async () => {
  assert.match(await cli('editor'), /usage: atelier editor/)
  assert.match(await cli('editor', 'write', 'alvo.ts', 'x'), /usage: atelier editor/)
})

await test('editor sem terminal chamador é recusado', async () => {
  assert.match(await routeCLI(['editor', 'list'], null), /missing terminal ID/)
})

await rm(outdir, { recursive: true, force: true })
await rm(lab, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
