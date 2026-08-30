/**
 * Desfazer o delete de um nó, contra o código de verdade.
 *
 * O que quebra num undo não é o botão — é o que volta JUNTO com o nó. Um cabo
 * duplicado, uma moldura que recebe de volta um membro que ela já tinha, um ⌘Z
 * apertado duas vezes: nenhum desses erros aparece numa captura de tela, e
 * todos deixam o arquivo do workspace inconsistente em silêncio.
 *
 * Compila shared/node-undo.ts com esbuild, como test-groups faz com a
 * geometria: uma cópia da regra aqui divergiria da original no primeiro ajuste
 * e continuaria passando.
 *
 * Uso: node scripts/test-undo-delete.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-undo-'))
const outfile = join(outdir, 'node-undo.mjs')
await esbuild.build({
  entryPoints: [join(ROOT, 'src/shared/node-undo.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const { UNDO_WINDOW_MS, captureRemoval, restoreRemoval, pendingRestores } =
  await import(pathToFileURL(outfile).href)

// O outro lado do undo: os bytes da imagem, que ficam de molho no main até a
// janela fechar. Sem `electron` dentro, então o bundle roda aqui como qualquer
// outro módulo.
const pendingFile = join(outdir, 'pending-image-delete.mjs')
await esbuild.build({
  entryPoints: [join(ROOT, 'src/main/core/persistence/pending-image-delete.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: pendingFile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const { scheduleImageDelete, cancelImageDelete, flushImageDeletes } = await import(
  pathToFileURL(pendingFile).href
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

const node = (id, patch = {}) => ({
  id,
  frame: { x: 0, y: 0, width: 100, height: 100 },
  content: { type: 'stickyNote', value: { fileName: `${id}.md` } },
  zIndex: 1,
  isLocked: false,
  createdAt: '2026-01-01T00:00:00Z',
  lastModifiedAt: '2026-01-01T00:00:00Z',
  ...patch
})
const conn = (id, a, b) => ({
  id,
  kind: 'note',
  nodeIdA: a,
  nodeIdB: b,
  ropePoints: [],
  createdAt: '2026-01-01T00:00:00Z',
  status: 'idle'
})
const group = (id, nodeIds) => ({
  id,
  title: 'g',
  frame: { x: 0, y: 0, width: 400, height: 400 },
  nodeIds,
  color: '#fff',
  isCollapsed: false,
  createdAt: '2026-01-01T00:00:00Z',
  lastModifiedAt: '2026-01-01T00:00:00Z'
})

/** O grafo de referência: A–B e B–C ligados, A e C dentro da moldura G. */
const base = () => ({
  nodes: [node('a', { zIndex: 7 }), node('b'), node('c')],
  connections: [conn('ab', 'a', 'b'), conn('bc', 'b', 'c')],
  groups: [group('g', ['a', 'c'])]
})

/** A poda que o WorkspaceManager e o store fazem — replicada só para o teste. */
function removeNodes(graph, ids) {
  const dead = new Set(ids)
  return {
    nodes: graph.nodes.filter((n) => !dead.has(n.id)),
    connections: graph.connections.filter((c) => !dead.has(c.nodeIdA) && !dead.has(c.nodeIdB)),
    groups: graph.groups.map((g) => ({ ...g, nodeIds: g.nodeIds.filter((n) => !dead.has(n)) }))
  }
}

console.log('\nretrato')

test('guarda o nó, os cabos que o tocavam e o grupo', () => {
  const [snap] = captureRemoval(base(), ['a'])
  assert.equal(snap.node.id, 'a')
  assert.deepEqual(
    snap.connections.map((c) => c.id),
    ['ab']
  )
  assert.equal(snap.groupId, 'g')
})

test('nó solto vem com groupId null e sem cabos', () => {
  const graph = { nodes: [node('x')], connections: [], groups: [] }
  const [snap] = captureRemoval(graph, ['x'])
  assert.equal(snap.groupId, null)
  assert.deepEqual(snap.connections, [])
})

test('id que não existe no grafo não vira retrato', () => {
  assert.deepEqual(captureRemoval(base(), ['zzz']), [])
})

test('o retrato é uma CÓPIA: mexer no grafo depois não o altera', () => {
  const graph = base()
  const [snap] = captureRemoval(graph, ['a'])
  graph.nodes[0].frame.x = 999
  assert.equal(snap.node.frame.x, 0)
})

console.log('\nrestaurar')

test('o nó volta com o mesmo id, o cabo e o lugar na moldura', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const after = restoreRemoval(removeNodes(graph, ['a']), snaps)
  assert.deepEqual(
    after.nodes.map((n) => n.id).sort(),
    ['a', 'b', 'c']
  )
  assert.deepEqual(
    after.connections.map((c) => c.id).sort(),
    ['ab', 'bc']
  )
  assert.deepEqual(after.groups[0].nodeIds.sort(), ['a', 'c'])
})

test('o zIndex volta como estava — desfazer não reordena a pilha', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const after = restoreRemoval(removeNodes(graph, ['a']), snaps)
  assert.equal(after.nodes.find((n) => n.id === 'a').zIndex, 7)
})

test('delete múltiplo volta inteiro, com o cabo ENTRE os dois apagados', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a', 'b'])
  const after = restoreRemoval(removeNodes(graph, ['a', 'b']), snaps)
  assert.deepEqual(
    after.nodes.map((n) => n.id).sort(),
    ['a', 'b', 'c']
  )
  assert.deepEqual(
    after.connections.map((c) => c.id).sort(),
    ['ab', 'bc']
  )
})

test('desfazer duas vezes não duplica nada', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const once = restoreRemoval(removeNodes(graph, ['a']), snaps)
  const twice = restoreRemoval(once, snaps)
  assert.equal(twice.nodes.length, 3)
  assert.equal(twice.connections.length, 2)
  assert.deepEqual(twice.groups[0].nodeIds.sort(), ['a', 'c'])
})

test('cabo cujo OUTRO lado morreu depois fica de fora', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  // 'b' foi apagado DEPOIS de 'a', e não faz parte deste retrato.
  const after = restoreRemoval(removeNodes(removeNodes(graph, ['a']), ['b']), snaps)
  assert.ok(after.nodes.some((n) => n.id === 'a'))
  assert.deepEqual(after.connections, [])
})

test('moldura desfeita no meio: o nó volta solto, sem inventar grupo', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const semGrupo = { ...removeNodes(graph, ['a']), groups: [] }
  const after = restoreRemoval(semGrupo, snaps)
  assert.ok(after.nodes.some((n) => n.id === 'a'))
  assert.deepEqual(after.groups, [])
})

test('não repõe o membro que a moldura já tem', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const after = restoreRemoval(graph, snaps) // grafo intacto: nada foi apagado
  assert.deepEqual(after.groups[0].nodeIds, ['a', 'c'])
  assert.equal(after.nodes.length, 3)
})

test('cabo equivalente criado enquanto isso não vira um segundo cabo', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const podado = removeNodes(graph, ['a'])
  // O usuário recriou o nó 'a' e o religou a 'b' — outro id de cabo, mesmo par.
  podado.nodes.push(node('a'))
  podado.connections.push(conn('novo', 'b', 'a'))
  const after = restoreRemoval(podado, snaps)
  assert.equal(after.connections.filter((c) => c.nodeIdA === 'b' || c.nodeIdB === 'b').length, 2)
  assert.ok(!after.connections.some((c) => c.id === 'ab'))
})

test('não muta o grafo que recebeu', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a'])
  const podado = removeNodes(graph, ['a'])
  const antes = JSON.stringify(podado)
  restoreRemoval(podado, snaps)
  assert.equal(JSON.stringify(podado), antes)
})

test('pendingRestores conta só o que falta', () => {
  const graph = base()
  const snaps = captureRemoval(graph, ['a', 'b'])
  assert.equal(pendingRestores(removeNodes(graph, ['a', 'b']), snaps), 2)
  assert.equal(pendingRestores(removeNodes(graph, ['a']), snaps), 1)
  assert.equal(pendingRestores(graph, snaps), 0)
})

console.log('\njanela')

test('a janela de undo é finita', () => {
  // O limite de passos não mora mais aqui: o delete entrou no histórico único
  // do store, e quem conta os passos dele é o MAX_HISTORY de lá.
  assert.ok(UNDO_WINDOW_MS > 0 && UNDO_WINDOW_MS <= 5 * 60_000)
})

console.log('\nimagem de molho')

/** Um "apagador" de mentira que só anota o que lhe pediram. */
function spy() {
  const calls = []
  return { calls, remove: async (wsId, file) => void calls.push(`${wsId}/${file}`) }
}

async function asyncTest(name, fn) {
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

await asyncTest('agendar NÃO apaga na hora — é o que deixa o undo ter imagem', async () => {
  const s = spy()
  scheduleImageDelete('n1', 'ws', 'n1.png', s.remove)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(s.calls, [])
  cancelImageDelete('n1')
})

await asyncTest('cancelar (o nó voltou) faz o arquivo nunca ser apagado', async () => {
  const s = spy()
  scheduleImageDelete('n2', 'ws', 'n2.png', s.remove)
  cancelImageDelete('n2')
  await flushImageDeletes()
  assert.deepEqual(s.calls, [])
})

await asyncTest('o flush do shutdown apaga o que ainda estava esperando', async () => {
  const s = spy()
  scheduleImageDelete('n3', 'ws', 'n3.png', s.remove)
  await flushImageDeletes()
  assert.deepEqual(s.calls, ['ws/n3.png'])
  // Drenou: um segundo flush não apaga de novo.
  await flushImageDeletes()
  assert.equal(s.calls.length, 1)
})

await asyncTest('apagar → desfazer → apagar de novo conta a janela do último', async () => {
  const s = spy()
  scheduleImageDelete('n4', 'ws', 'antigo.png', s.remove)
  scheduleImageDelete('n4', 'ws', 'novo.png', s.remove)
  await flushImageDeletes()
  assert.deepEqual(s.calls, ['ws/novo.png'])
})

// ─── O histórico único do store ──────────────────────────────────────────────
//
// Até aqui os testes olham a REGRA (o que volta junto com o nó). O que segue
// olha a PILHA: o delete deixou de ter um desfazer próprio e passou a ser mais
// um passo do Ctrl+Z. Isso só é verificável contra o store de verdade — a
// versão anterior tinha duas pilhas que não se falavam, e nenhum teste de
// função pura seria capaz de perceber que o mesmo ⌘Z mexia nas duas.
//
// O `window.atelier` abaixo é um processo principal de mentira: guarda um
// grafo, poda no `node.remove`, recoloca no `node.restore` e anota a ordem das
// chamadas. É o bastante para afirmar o que importa — que desfazer um delete
// passa pelo main, e não só pelo retrato do renderer.

const storeFile = join(outdir, 'store.mjs')
await esbuild.build({
  stdin: {
    contents: `export { store } from './src/renderer/state/store.ts'`,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['electron'],
  outfile: storeFile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

/** O main de mentira, com o grafo dentro. Devolve o `window.atelier` e o log. */
function fakeMain() {
  const graph = base()
  const state = {
    id: 'ws',
    name: 'ws',
    nodes: graph.nodes,
    connections: graph.connections,
    groups: graph.groups,
    drawings: []
  }
  const calls = []
  const atelier = {
    workspace: {
      open: async () => structuredClone(state),
      integrity: async () => null,
      restore: async (_id, snapshot) => {
        calls.push('workspace.restore')
        Object.assign(state, structuredClone(snapshot))
      }
    },
    node: {
      add: async (_id, _kind, position) => {
        const created = node(`novo-${state.nodes.length}`, {
          frame: { ...position, width: 100, height: 100 }
        })
        state.nodes = [...state.nodes, created]
        return structuredClone(created)
      },
      remove: async (_id, nodeId) => {
        calls.push(`node.remove:${nodeId}`)
        Object.assign(state, removeNodes(state, [nodeId]))
      },
      restore: async (_id, snapshots) => {
        calls.push('node.restore')
        Object.assign(state, restoreRemoval(state, snapshots))
        return snapshots.map((s) => s.node.id)
      }
    }
  }
  return { atelier, state, calls }
}

/** Um store zerado, já com o workspace aberto e o main de mentira no lugar. */
async function comStore() {
  const main = fakeMain()
  globalThis.window = { atelier: main.atelier }
  const { store } = await import(`${pathToFileURL(storeFile).href}?t=${Math.random()}`)
  await store.openWorkspace('ws')
  return { store, ...main }
}

const ids = (store) =>
  store
    .getSnapshot()
    .workspace.nodes.map((n) => n.id)
    .sort()

console.log('\nhistórico único')

await asyncTest('o delete é um passo do ⌘Z — um só, para a seleção inteira', async () => {
  const { store } = await comStore()
  await store.removeNodes(['a', 'b'])
  assert.deepEqual(ids(store), ['c'])
  await store.undo()
  assert.deepEqual(ids(store), ['a', 'b', 'c'], 'um ⌘Z devolve os dois')
  store.dismissNotice()
})

await asyncTest('desfazer um delete passa pelo main ANTES do retrato', async () => {
  // O retrato sozinho redesenharia a tela e deixaria os bytes da imagem
  // condenados: quem cancela a exclusão é o `node:restore`.
  const { store, calls } = await comStore()
  await store.removeNodes(['a'])
  await store.undo()
  const restore = calls.indexOf('node.restore')
  assert.ok(restore >= 0, 'o main precisa saber que o nó voltou')
  assert.ok(restore < calls.indexOf('workspace.restore'), 'o main vem antes do retrato')
  store.dismissNotice()
})

await asyncTest('o nó volta selecionado — responde "onde ele foi parar"', async () => {
  const { store } = await comStore()
  await store.removeNodes(['a'])
  await store.undo()
  assert.deepEqual(store.getSnapshot().selection, ['a'])
  store.dismissNotice()
})

await asyncTest('refazer NÃO apaga de novo: o redo para no delete', async () => {
  const { store } = await comStore()
  await store.removeNodes(['a'])
  await store.undo()
  assert.equal(store.canRedo, false, 'não há o que refazer em cima de um delete')
  await store.redo()
  assert.deepEqual(ids(store), ['a', 'b', 'c'], 'o nó continua vivo')
  store.dismissNotice()
})

await asyncTest('a edição comum continua indo e voltando pelo mesmo histórico', async () => {
  const { store } = await comStore()
  await store.addNode('note', { x: 10, y: 10 })
  assert.equal(ids(store).length, 4)
  await store.undo()
  assert.equal(ids(store).length, 3, 'desfez a criação')
  assert.equal(store.canRedo, true)
  await store.redo()
  assert.equal(ids(store).length, 4, 'refez a criação')
})

await asyncTest('⌘Z depois do delete anda para o passo anterior, não para outra pilha', async () => {
  const { store } = await comStore()
  await store.addNode('note', { x: 10, y: 10 })
  await store.removeNodes(['a'])
  await store.undo()
  assert.deepEqual(ids(store), ['a', 'b', 'c', 'novo-3'], 'primeiro volta o delete')
  await store.undo()
  assert.deepEqual(ids(store), ['a', 'b', 'c'], 'depois desfaz a criação')
  store.dismissNotice()
})

console.log('\njanela, no store')

/** Roda `fn` com o relógio adiantado — a janela de undo fechada. */
async function passadaAJanela(fn) {
  const real = Date.now
  Date.now = () => real.call(Date) + UNDO_WINDOW_MS + 1000
  try {
    await fn()
  } finally {
    Date.now = real
  }
}

await asyncTest('nó comum desfaz mesmo depois da janela — o arquivo dele ficou', async () => {
  const { store } = await comStore()
  await store.removeNodes(['a'])
  await passadaAJanela(() => store.undo())
  assert.deepEqual(ids(store), ['a', 'b', 'c'])
  store.dismissNotice()
})

await asyncTest('imagem fora da janela não volta, e o histórico anterior cai junto', async () => {
  // Passada a janela os bytes já saíram do disco. O retrato ANTERIOR aponta
  // para os mesmos bytes, então desfazer mais fundo devolveria outra moldura
  // vazia — a pilha inteira é descartada, e não só o passo do delete.
  const { store } = await comStore()
  await store.addNode('note', { x: 10, y: 10 })
  store.getSnapshot().workspace.nodes.find((n) => n.id === 'a').content = {
    type: 'image',
    value: { fileName: 'a.png' }
  }
  await store.removeNodes(['a'])
  await passadaAJanela(() => store.undo())
  assert.deepEqual(ids(store), ['b', 'c', 'novo-3'], 'a imagem não volta vazia')
  assert.equal(store.canUndo, false, 'o que estava embaixo também não é mais restaurável')
  assert.equal(
    store.getSnapshot().notice?.text,
    'a imagem apagada já saiu do disco — não dá para desfazer'
  )
  store.dismissNotice()
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam`)
if (failed > 0) process.exit(1)
console.log('test-undo-delete: ok')
