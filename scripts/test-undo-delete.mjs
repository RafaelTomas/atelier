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
const { UNDO_WINDOW_MS, UNDO_STACK_LIMIT, captureRemoval, restoreRemoval, pendingRestores } =
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

test('a janela de undo é finita e a pilha é limitada', () => {
  assert.ok(UNDO_WINDOW_MS > 0 && UNDO_WINDOW_MS <= 5 * 60_000)
  assert.ok(UNDO_STACK_LIMIT >= 1)
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

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam`)
if (failed > 0) process.exit(1)
console.log('test-undo-delete: ok')
