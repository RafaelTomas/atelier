/**
 * O emulador do Android, achado sem SDK nenhum instalado na máquina do teste.
 *
 * A parte que toca disco de verdade (`findEmulatorBinary`) é testada contra
 * um SDK FALSO — um diretório temporário com um arquivo executável no lugar
 * certo — em vez de exigir o Android Studio instalado no runner do CI. A
 * ORDEM de prioridade entre `ANDROID_SDK_ROOT`, `ANDROID_HOME` e o caminho
 * padrão do sistema é o que mais vale a pena travar aqui: errar a ordem faz
 * o botão abrir o SDK errado em silêncio, numa máquina com mais de um.
 *
 * Uso: node scripts/test-android-emulator.mjs
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-android-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { findEmulatorBinary, parseAvdList, resolveCandidates } from './src/main/core/android/android-emulator.ts'
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

const { findEmulatorBinary, parseAvdList, resolveCandidates } = await import(pathToFileURL(outfile).href)

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

console.log('\nemulador do android\n')

// ─── resolveCandidates: a ORDEM de prioridade ──────────────────────────────────

await test('ANDROID_SDK_ROOT vem antes de ANDROID_HOME e do padrão do sistema', () => {
  const candidates = resolveCandidates(
    { ANDROID_SDK_ROOT: '/sdk-root', ANDROID_HOME: '/sdk-home' },
    'linux',
    '/home/u'
  )
  assert.deepEqual(candidates, [
    join('/sdk-root', 'emulator', 'emulator'),
    join('/sdk-home', 'emulator', 'emulator'),
    join('/home/u', 'Android', 'Sdk', 'emulator', 'emulator')
  ])
})

await test('sem nenhuma variável, só o padrão do sistema entra na lista', () => {
  const candidates = resolveCandidates({}, 'linux', '/home/u')
  assert.deepEqual(candidates, [join('/home/u', 'Android', 'Sdk', 'emulator', 'emulator')])
})

await test('as duas variáveis apontando pro MESMO lugar não duplicam o candidato', () => {
  // O padrão do sistema continua na lista como ÚLTIMA tentativa — mesmo com
  // as duas variáveis de ambiente concordando, elas podem estar erradas, e
  // é o padrão que sobra pra tentar depois.
  const candidates = resolveCandidates(
    { ANDROID_SDK_ROOT: '/sdk', ANDROID_HOME: '/sdk' },
    'linux',
    '/home/u'
  )
  assert.deepEqual(candidates, [
    join('/sdk', 'emulator', 'emulator'),
    join('/home/u', 'Android', 'Sdk', 'emulator', 'emulator')
  ])
})

await test('macOS: o padrão é ~/Library/Android/sdk', () => {
  const candidates = resolveCandidates({}, 'darwin', '/Users/u')
  assert.deepEqual(candidates, [join('/Users/u', 'Library', 'Android', 'sdk', 'emulator', 'emulator')])
})

await test('Windows: binário com .exe, padrão em %LOCALAPPDATA%\\Android\\Sdk', () => {
  const candidates = resolveCandidates({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')
  assert.deepEqual(candidates, [join('C:\\Users\\u\\AppData\\Local', 'Android', 'Sdk', 'emulator', 'emulator.exe')])
})

await test('Windows sem LOCALAPPDATA cai em <home>\\AppData\\Local', () => {
  const candidates = resolveCandidates({}, 'win32', 'C:\\Users\\u')
  assert.deepEqual(candidates, [
    join('C:\\Users\\u', 'AppData', 'Local', 'Android', 'Sdk', 'emulator', 'emulator.exe')
  ])
})

// ─── findEmulatorBinary: contra um SDK FALSO, sem depender do de verdade ───────

const fakeHome = await mkdtemp(join(tmpdir(), 'atelier-android-home-'))

await test('acha o binário no caminho padrão quando ele existe e é executável', async () => {
  const dir = join(fakeHome, 'Android', 'Sdk', 'emulator')
  await mkdir(dir, { recursive: true })
  const bin = join(dir, 'emulator')
  await writeFile(bin, '#!/bin/sh\necho ok\n', 'utf8')
  await chmod(bin, 0o755)

  const found = await findEmulatorBinary({}, 'linux', fakeHome)
  assert.equal(found, bin)
})

await test('sem SDK nenhum instalado, devolve null — não estoura', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'atelier-android-vazio-'))
  const found = await findEmulatorBinary({}, 'linux', emptyHome)
  assert.equal(found, null)
  await rm(emptyHome, { recursive: true, force: true })
})

await test('ANDROID_SDK_ROOT aponta pra um SDK sem o binário: cai pro próximo candidato', async () => {
  const semBinario = await mkdtemp(join(tmpdir(), 'atelier-android-semexe-'))
  const dir = join(fakeHome, 'Android', 'Sdk', 'emulator')
  const bin = join(dir, 'emulator')
  // O binário do teste anterior, no caminho PADRÃO, ainda existe — é ele que
  // deveria ser achado quando ANDROID_SDK_ROOT não tem nada lá.
  const found = await findEmulatorBinary({ ANDROID_SDK_ROOT: semBinario }, 'linux', fakeHome)
  assert.equal(found, bin, 'não caiu para o candidato seguinte')
  await rm(semBinario, { recursive: true, force: true })
})

await rm(fakeHome, { recursive: true, force: true })

// ─── parseAvdList ───────────────────────────────────────────────────────────────

await test('uma linha em branco no fim não vira um AVD chamado ""', () => {
  assert.deepEqual(parseAvdList('Pixel_7\nPixel_Tablet\n'), ['Pixel_7', 'Pixel_Tablet'])
})

await test('CRLF (saída do emulator.exe no Windows) também separa direito', () => {
  assert.deepEqual(parseAvdList('Pixel_7\r\nPixel_Tablet\r\n'), ['Pixel_7', 'Pixel_Tablet'])
})

await test('espaço em volta do nome é cortado', () => {
  assert.deepEqual(parseAvdList('  Pixel_7  \n'), ['Pixel_7'])
})

await test('nenhum AVD criado ainda: lista vazia, não `[""]`', () => {
  assert.deepEqual(parseAvdList(''), [])
  assert.deepEqual(parseAvdList('\n\n'), [])
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
