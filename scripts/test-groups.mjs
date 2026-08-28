/**
 * Geometria das molduras de grupo, contra o código de verdade.
 *
 * O que quebra num grupo não é o desenho — é a decisão de QUEM ESTÁ DENTRO. Ela
 * roda no `mouseup` de todo arrasto, é invisível numa captura de tela, e um erro
 * ali move um nó para a moldura errada em silêncio: o usuário só descobre
 * quando arrasta o grupo e um nó fica para trás.
 *
 * Compila group-geometry.ts com esbuild, como test-codec faz com o codec, em
 * vez de reproduzir a aritmética aqui: uma cópia divergiria da original no
 * primeiro ajuste e continuaria passando.
 *
 * Uso: node scripts/test-groups.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-groups-'))
const outfile = join(outdir, 'geometry.mjs')
await esbuild.build({
  entryPoints: [join(ROOT, 'src/renderer/canvas/group-geometry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})
const {
  GROUP_PADDING,
  GROUP_TITLE_HEIGHT,
  boundsForNodes,
  collapsedMembers,
  groupAt,
  groupOf,
  rectContains
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

const rect = (x, y, width, height) => ({ x, y, width, height })
const group = (id, frame, nodeIds = [], patch = {}) => ({
  id,
  title: id,
  frame,
  nodeIds,
  color: '#007AFF',
  isCollapsed: false,
  createdAt: '',
  lastModifiedAt: '',
  ...patch
})

console.log('\nfolga e faixa ao criar')

test('a moldura envolve os membros com folga dos dois lados', () => {
  const b = boundsForNodes([rect(100, 100, 200, 100), rect(400, 300, 100, 100)])
  assert.equal(b.x, 100 - GROUP_PADDING)
  assert.equal(b.width, 400 + GROUP_PADDING * 2, 'largura sem a folga dos dois lados')
})

test('sobra espaço no topo para a faixa não cobrir a primeira fileira', () => {
  const node = rect(100, 100, 200, 100)
  const b = boundsForNodes([node])
  assert.equal(b.y, 100 - GROUP_PADDING - GROUP_TITLE_HEIGHT)
  // O corpo útil começa depois da faixa, e o nó tem de caber ali.
  assert.ok(node.y >= b.y + GROUP_TITLE_HEIGHT, 'a faixa cobriria o nó')
})

test('sem membros não há retângulo a calcular', () => {
  assert.equal(boundsForNodes([]), null)
})

console.log('\nquem adota o nó ao soltar')

const gA = group('A', rect(0, 0, 400, 400))
const gB = group('B', rect(300, 0, 400, 400))

test('o centro decide, não o encosto', () => {
  // Nó que invade a moldura por uma quina: o centro está de fora, fica de fora.
  assert.equal(groupAt([gA], rect(380, 380, 100, 100)), null)
  assert.equal(groupAt([gA], rect(100, 100, 100, 100))?.id, 'A')
})

test('com duas molduras sobrepostas ganha a desenhada por cima', () => {
  // O fim do array é o que está na frente — a mesma ordem do render.
  assert.equal(groupAt([gA, gB], rect(300, 100, 60, 60))?.id, 'B')
  assert.equal(groupAt([gB, gA], rect(300, 100, 60, 60))?.id, 'A')
})

test('nó longe de tudo continua solto', () => {
  assert.equal(groupAt([gA, gB], rect(5000, 5000, 100, 100)), null)
})

test('a borda conta como dentro', () => {
  assert.equal(rectContains(rect(0, 0, 100, 100), { x: 100, y: 100 }), true)
  assert.equal(rectContains(rect(0, 0, 100, 100), { x: 100.5, y: 50 }), false)
})

console.log('\ndono único e colapso')

test('groupOf acha o dono e devolve null para nó solto', () => {
  const gs = [group('A', rect(0, 0, 10, 10), ['N1']), group('B', rect(0, 0, 10, 10), ['N2'])]
  assert.equal(groupOf(gs, 'N2')?.id, 'B')
  assert.equal(groupOf(gs, 'N9'), null)
})

test('só os membros de grupos COLAPSADOS saem do render', () => {
  const gs = [
    group('A', rect(0, 0, 10, 10), ['N1', 'N2'], { isCollapsed: true }),
    group('B', rect(0, 0, 10, 10), ['N3'])
  ]
  const hidden = collapsedMembers(gs)
  assert.equal(hidden.has('N1'), true)
  assert.equal(hidden.has('N2'), true)
  assert.equal(hidden.has('N3'), false, 'membro de grupo expandido sumiu da tela')
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
