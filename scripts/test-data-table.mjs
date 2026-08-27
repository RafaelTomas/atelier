/**
 * Testa o parser de dados tabulares do `atelier table` (src/shared/data-table.ts).
 *
 * Uso: node scripts/test-data-table.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

async function load() {
  const outdir = await mkdtemp(join(tmpdir(), 'atelier-dt-'))
  const outfile = join(outdir, 'dt.mjs')
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/shared/data-table.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile).href)
  return { mod, cleanup: () => rm(outdir, { recursive: true, force: true }) }
}

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err.message}`)
  }
}

const { mod, cleanup } = await load()
const { parseTabular, detectFormat, toCSV } = mod

console.log('\nparser de dados tabulares\n')

test('array de objetos: colunas = união das chaves na ordem de 1ª ocorrência', () => {
  const r = parseTabular('[{"id":1,"nome":"a"},{"nome":"b","extra":true}]')
  assert.deepEqual(r.columns, ['id', 'nome', 'extra'])
  assert.deepEqual(r.rows, [
    [1, 'a', null],
    [null, 'b', true]
  ])
  assert.equal(r.truncated, false)
})

test('forma explícita { columns, rows } normaliza o comprimento das linhas', () => {
  const r = parseTabular('{"columns":["a","b"],"rows":[[1],[2,3,4]]}')
  assert.deepEqual(r.columns, ['a', 'b'])
  assert.deepEqual(r.rows, [
    [1, null],
    [2, 3]
  ])
})

test('CSV com aspas: delimitador e aspas embutidas dentro do campo', () => {
  const r = parseTabular('name,note\n"Doe, John","said ""hi"""\nJane,ok')
  assert.deepEqual(r.columns, ['name', 'note'])
  assert.deepEqual(r.rows, [
    ['Doe, John', 'said "hi"'],
    ['Jane', 'ok']
  ])
})

test('TSV é detectado pela tab na primeira linha', () => {
  assert.equal(detectFormat('a\tb\n1\t2'), 'tsv')
  const r = parseTabular('a\tb\n1\t2')
  assert.deepEqual(r.rows, [[1, 2]])
})

test('CSV: vazio vira null, número puro vira number', () => {
  const r = parseTabular('a,b,c\n1,,x')
  assert.deepEqual(r.rows, [[1, null, 'x']])
})

test('truncamento pelo teto de linhas', () => {
  const rows = Array.from({ length: 10 }, (_, i) => `${i}`).join('\n')
  const r = parseTabular(`n\n${rows}`, 'csv', { maxRows: 4, maxCells: 1000 })
  assert.equal(r.rows.length, 4)
  assert.equal(r.truncated, true)
})

test('truncamento pelo teto de células', () => {
  const r = parseTabular('a,b\n1,2\n3,4\n5,6', 'csv', { maxRows: 1000, maxCells: 4 })
  assert.equal(r.rows.length, 2) // 4 células / 2 colunas
  assert.equal(r.truncated, true)
})

test('JSON inválido lança erro legível', () => {
  assert.throws(() => parseTabular('[{bad'), /JSON inválido/)
})

test('CSV sem nada lança "header ausente"', () => {
  assert.throws(() => parseTabular('', 'csv'), /header/)
})

test('toCSV escapa vírgula, aspas e quebra de linha', () => {
  const csv = toCSV({ columns: ['a', 'b'], rows: [['x,y', 'he said "hi"'], [null, 1]], truncated: false })
  assert.equal(csv, 'a,b\n"x,y","he said ""hi"""\n,1')
})

await cleanup()
console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
