/**
 * Teste de compatibilidade do formato — a checagem mais importante deste porte.
 *
 * Valida que o codec TypeScript lê o formato Maestri e o escreve de volta SEM
 * PERDA, incluindo os tipos de nó que a UI ainda não renderiza. É o que garante
 * que abrir um workspace do app Swift aqui e voltar para lá não destrói dados.
 *
 * As três regras verificadas empiricamente contra swiftc (JSONEncoder .iso8601):
 *   UUID maiúsculo · Date sem milissegundos · CGPoint [x,y] / CGRect [[x,y],[w,h]]
 *
 * Uso: node scripts/test-codec.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// Compila o codec (TS) para um bundle temporário — sem depender do build do app
async function loadCodec() {
  const outdir = await mkdtemp(join(tmpdir(), 'atelier-codec-'))
  const outfile = join(outdir, 'codec.mjs')
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/main/core/models/workspace.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    alias: { '@shared': join(ROOT, 'src/shared') }
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
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

const { mod, cleanup } = await loadCodec()
const { decodeWorkspaceDocument, encodeWorkspaceDocument } = mod

const raw = JSON.parse(readFileSync(join(ROOT, 'fixtures/full-workspace.json'), 'utf8'))
const { payload } = decodeWorkspaceDocument(raw)
const reencoded = encodeWorkspaceDocument(payload)

console.log('\ncodec de compatibilidade Maestri\n')

test('decodifica os 8 tipos de nó', () => {
  const types = payload.nodes.map((n) => n.content.type).sort()
  assert.deepEqual(types, [
    'fileTree',
    'freehand',
    'portal',
    'shape',
    'stickyNote',
    'stroke',
    'terminal',
    'text'
  ])
})

test('frame decodifica de [[x,y],[w,h]]', () => {
  const node = payload.nodes.find((n) => n.content.type === 'terminal')
  assert.deepEqual(node.frame, { x: 9900, y: 8600, width: 560, height: 360 })
})

test('frame re-encoda como [[x,y],[w,h]], não como objeto', () => {
  const node = reencoded.payload.nodes.find((n) => n.content.terminal)
  assert.deepEqual(node.frame, [[9900, 8600], [560, 360]])
})

test('canvasOrigin re-encoda como [x,y] (CGPoint do Swift é array)', () => {
  assert.deepEqual(reencoded.payload.canvasOrigin, [9800, 8500])
})

test('NodeContent mantém o embrulho { tipo: { _0: … } }', () => {
  for (const node of reencoded.payload.nodes) {
    const keys = Object.keys(node.content)
    assert.equal(keys.length, 1, 'conteúdo deve ter exatamente uma chave de variante')
    assert.ok('_0' in node.content[keys[0]], `variante ${keys[0]} sem _0`)
  }
})

test('StorageMode.managed encoda como objeto vazio', () => {
  const note = reencoded.payload.nodes.find((n) => n.content.stickyNote)
  assert.deepEqual(note.content.stickyNote._0.storageMode, { managed: {} })
})

test('PortalSource.url mantém o embrulho _0', () => {
  const portal = reencoded.payload.nodes.find((n) => n.content.portal)
  assert.deepEqual(portal.content.portal._0.source, { url: { _0: 'https://example.com' } })
})

test('CGPoint dentro de stroke re-encoda como array', () => {
  const stroke = reencoded.payload.nodes.find((n) => n.content.stroke)
  assert.deepEqual(stroke.content.stroke._0.startPoint, [0, 0.5])
  assert.deepEqual(stroke.content.stroke._0.controlPoint, [0.5, 0.5])
})

test('as 6 listas de conexão são reconstruídas com seus nomes de campo', () => {
  assert.equal(reencoded.payload.connections.length, 1)
  assert.ok('terminalIdA' in reencoded.payload.connections[0])
  assert.equal(reencoded.payload.noteConnections.length, 1)
  assert.ok('noteNodeId' in reencoded.payload.noteConnections[0])
  assert.equal(reencoded.payload.portalConnections.length, 1)
  assert.ok('portalNodeId' in reencoded.payload.portalConnections[0])
  for (const key of ['portalToPortalConnections', 'noteToNoteConnections', 'crossFloorConnections']) {
    assert.ok(Array.isArray(reencoded.payload[key]), `${key} deve existir mesmo vazio`)
  }
})

test('UUIDs saem em maiúsculas', () => {
  for (const node of reencoded.payload.nodes) {
    assert.equal(node.id, node.id.toUpperCase(), `${node.id} não está em maiúsculas`)
  }
})

test('datas ficam em ISO8601 sem milissegundos', () => {
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
  for (const node of reencoded.payload.nodes) {
    assert.match(node.createdAt, re)
    assert.match(node.lastModifiedAt, re)
  }
})

test('round-trip é estável (encode∘decode∘encode == encode)', () => {
  const second = encodeWorkspaceDocument(decodeWorkspaceDocument(reencoded).payload)
  assert.deepEqual(second, reencoded)
})

test('nós não implementados na UI sobrevivem ao round-trip', () => {
  const survivors = ['shape', 'stroke', 'freehand', 'fileTree']
  for (const type of survivors) {
    assert.ok(
      reencoded.payload.nodes.some((n) => type in n.content),
      `nó ${type} foi perdido`
    )
  }
})

test('schemaVersion e type ficam corretos na raiz', () => {
  assert.equal(reencoded.schemaVersion, 2)
  assert.equal(reencoded.type, 'workspace')
})

await cleanup()

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
