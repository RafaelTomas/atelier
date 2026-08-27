/**
 * Testa os helpers de imagem compartilhados (src/shared/image.ts):
 * mapa mime ⇄ extensão e a leitura de tamanho do header PNG.
 *
 * Uso: node scripts/test-image.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

async function load() {
  const outdir = await mkdtemp(join(tmpdir(), 'atelier-img-'))
  const outfile = join(outdir, 'img.mjs')
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/shared/image.ts')],
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

/** PNG mínimo de W×H — assinatura + IHDR (com CRC placeholder) + IDAT/IEND. */
function fakePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(w, 8)
  ihdr.writeUInt32BE(h, 12)
  ihdr[16] = 8
  ihdr[17] = 2
  return Buffer.concat([sig, ihdr, deflateSync(Buffer.alloc(4))])
}

const { mod, cleanup } = await load()
const { extForImageMime, mimeForImageName, isSupportedImageName, pngDimensions } = mod

console.log('\nhelpers de imagem\n')

test('extForImageMime: conhecidos e fallback png', () => {
  assert.equal(extForImageMime('image/jpeg'), 'jpg')
  assert.equal(extForImageMime('image/webp'), 'webp')
  assert.equal(extForImageMime('image/svg+xml'), 'svg')
  assert.equal(extForImageMime('application/pdf'), 'png')
})

test('mimeForImageName: pela extensão, case-insensitive, fallback png', () => {
  assert.equal(mimeForImageName('a.PNG'), 'image/png')
  assert.equal(mimeForImageName('/x/y/foto.jpeg'), 'image/jpeg')
  assert.equal(mimeForImageName('sem-extensao'), 'image/png')
})

test('isSupportedImageName', () => {
  assert.equal(isSupportedImageName('grafico.png'), true)
  assert.equal(isSupportedImageName('doc.pdf'), false)
  assert.equal(isSupportedImageName('arquivo'), false)
})

test('pngDimensions lê W×H do header', () => {
  assert.deepEqual(pngDimensions(fakePng(1920, 1080)), { width: 1920, height: 1080 })
})

test('pngDimensions rejeita não-PNG e buffer curto', () => {
  assert.equal(pngDimensions(Buffer.from('not a png at all!!')), null)
  assert.equal(pngDimensions(Buffer.alloc(10)), null)
})

test('pngDimensions respeita byteOffset (Buffer é view sobre pool)', () => {
  const png = fakePng(64, 32)
  const framed = Buffer.concat([Buffer.alloc(7), png]).subarray(7)
  assert.deepEqual(pngDimensions(framed), { width: 64, height: 32 })
})

await cleanup()
console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
