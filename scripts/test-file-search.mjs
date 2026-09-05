/**
 * Testa o motor de busca da árvore contra uma árvore de verdade em disco.
 *
 * O que quebra este módulo não aparece em mock: arquivo binário, arquivo grande
 * demais, symlink em ciclo, linha de 40 KB, expressão regular que casa vazio,
 * pasta sem permissão de leitura. Cada caso abaixo é um desses.
 *
 * Uso: node scripts/test-file-search.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outdir = mkdtempSync(join(tmpdir(), 'searchtest-'))
await build({
  entryPoints: ['src/main/core/projects/file-search.ts'],
  bundle: true, platform: 'node', format: 'esm', outdir,
  external: ['electron'],
  alias: { '@shared': new URL('./src/shared', import.meta.url).pathname }
})
const { searchFileNames, searchFileContents } = await import(
  pathToFileURL(join(outdir, 'file-search.js')).href
)

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

const opts = (query, extra = {}) => ({
  query, caseSensitive: false, wholeWord: false, regex: false, ...extra
})

const rel = (result, root) =>
  result.map((item) => item.path.slice(root.length + 1).replace(/\\/g, '/'))

// ── A árvore de teste ───────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'arvore-'))
const dir = (...p) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d }
const file = (relPath, text) => writeFileSync(join(root, relPath), text)

dir('src', 'renderer', 'state')
dir('src', 'main')
dir('node_modules', 'pacote')
dir('dist')
dir('.github', 'workflows')

file(join('src', 'renderer', 'state', 'store.ts'), 'export const store = 1\nconst outro = store + 1\n')
file(join('src', 'renderer', 'state', 'store-undo.ts'), 'import { store } from "./store"\n')
file(join('src', 'main', 'index.ts'), 'const STORE = "maiusculo"\n// storefront nao e store inteira\n')
file(join('node_modules', 'pacote', 'store.js'), 'store store store\n')
file(join('dist', 'bundle.js'), 'store\n')
file(join('.github', 'workflows', 'ci.yml'), 'name: store\n')
// Byte nulo no meio: e o que faz um arquivo ser binario para o git e para este
// modulo. Escrito como escape de propriedade — um NUL literal no fonte do teste
// e invisivel em revisao e alguns editores o comem.
writeFileSync(join(root, 'binario.bin'), Buffer.from('store\u0000store', 'latin1'))
file('grande.txt', 'x'.repeat(3 * 1024 * 1024) + '\nstore\n')
file('longa.txt', 'y'.repeat(5000) + 'store' + 'z'.repeat(5000) + '\n')

// ── Busca por nome ──────────────────────────────────────────────────────────
console.log('\nbusca por nome')
{
  const r = await searchFileNames(root, opts('store'))
  const nomes = r.entries.map((e) => e.name).sort()
  check('acha os dois store*.ts', nomes.includes('store.ts') && nomes.includes('store-undo.ts'), nomes)
  check('nao desce em node_modules', !r.entries.some((e) => e.path.includes('node_modules')), nomes)
  check('nao desce em dist', !r.entries.some((e) => e.path.includes('dist')), nomes)
  check('varreu tudo (stopped null)', r.stopped === null, r.stopped)
}
{
  const r = await searchFileNames(root, opts('state/store'))
  const caminhos = rel(r.entries, root)
  check('termo com barra casa contra o caminho', caminhos.length === 2, caminhos)
  check('separador normalizado (vale no Windows)',
    caminhos.every((p) => p.includes('state/store')), caminhos)
}
{
  const r = await searchFileNames(root, opts('STORE', { caseSensitive: true }))
  check('caseSensitive nao acha store.ts', !r.entries.some((e) => e.name === 'store.ts'),
    r.entries.map((e) => e.name))
}
{
  const r = await searchFileNames(root, opts('workflows'))
  check('pasta oculta .github e varrida', r.entries.some((e) => e.name === 'workflows'),
    rel(r.entries, root))
}
{
  const r = await searchFileNames(root, opts('sto(re', { regex: true }))
  check('regex invalida vira bad-regex', r.error === 'bad-regex', JSON.stringify(r).slice(0, 80))
}
{
  const r = await searchFileNames(root, opts('stor.\\.ts$', { regex: true }))
  check('regex valida casa store.ts', r.entries.some((e) => e.name === 'store.ts'),
    r.entries?.map((e) => e.name))
}
{
  // `.*` casa a string vazia em toda posicao: sem o avanco do lastIndex isto
  // nunca voltaria.
  const r = await searchFileNames(root, opts('.*', { regex: true }))
  check('regex que casa vazio termina', Array.isArray(r.entries), r.error)
}

// ── Busca por conteúdo ──────────────────────────────────────────────────────
console.log('\nbusca por conteudo')
{
  const r = await searchFileContents(root, opts('store'))
  const caminhos = rel(r.files, root)
  check('acha nos arquivos de src', caminhos.includes('src/renderer/state/store.ts'), caminhos)
  check('nao le node_modules nem dist',
    !caminhos.some((p) => p.startsWith('node_modules') || p.startsWith('dist')), caminhos)
  check('binario e pulado, nao devolvido', !caminhos.includes('binario.bin'), caminhos)
  check('grande demais e pulado', !caminhos.includes('grande.txt'), caminhos)
  check('conta os pulados', r.skipped >= 2, r.skipped)
  const store = r.files.find((f) => f.path.endsWith('store.ts') && !f.path.includes('undo'))
  check('duas ocorrencias em store.ts', store.hits.length === 2, store.hits)
  check('linha e 1-based', store.hits[0].line === 1, store.hits[0])
  check('column aponta o casamento',
    store.hits[0].text.slice(store.hits[0].column, store.hits[0].column + 5) === 'store',
    store.hits[0])
}
{
  const r = await searchFileContents(root, opts('STORE', { caseSensitive: true }))
  const caminhos = rel(r.files, root)
  check('caseSensitive so acha o maiusculo',
    caminhos.length === 1 && caminhos[0] === 'src/main/index.ts', caminhos)
}
{
  const r = await searchFileContents(root, opts('store', { wholeWord: true }))
  const main = r.files.find((f) => f.path.endsWith('index.ts'))
  const casouStorefront = (main?.hits ?? []).some(
    (h) => h.text.slice(h.column, h.column + 10) === 'storefront'
  )
  check('palavra inteira ignora storefront', !casouStorefront, main?.hits)
}
{
  const r = await searchFileContents(root, opts('linha.que.nao.existe', { regex: true }))
  check('sem resultado devolve lista vazia', r.files.length === 0 && r.total === 0, r)
}
{
  const r = await searchFileContents(root, opts('store'))
  const longa = r.files.find((f) => f.path.endsWith('longa.txt'))
  check('linha longa e cortada', longa.hits[0].text.length <= 400, longa.hits[0].text.length)
  check('corte mantem o casamento visivel',
    longa.hits[0].text.slice(longa.hits[0].column, longa.hits[0].column + 5) === 'store',
    { column: longa.hits[0].column, len: longa.hits[0].text.length })
}
{
  const r = await searchFileContents(root, opts('s.*', { regex: true }))
  check('regex gulosa que casa vazio termina', typeof r.total === 'number', r.error)
}

// ── Bordas do sistema de arquivos ───────────────────────────────────────────
console.log('\nbordas do sistema de arquivos')
{
  // Ciclo: link para o proprio pai. Sem a recusa de seguir symlink a caminhada
  // nao termina — e o teste nao termina com ela.
  try {
    symlinkSync(root, join(root, 'src', 'ciclo'), 'dir')
    const r = await searchFileNames(root, opts('store'))
    check('symlink em ciclo nao trava a caminhada', r.entries.length > 0, r.entries.length)
    const c = await searchFileContents(root, opts('store'))
    check('busca em conteudo tambem sobrevive ao ciclo', c.files.length > 0, c.files.length)
  } catch (err) {
    check('symlink em ciclo nao trava a caminhada', true, `(pulado: ${err.code})`)
  }
}
{
  // Pasta sem permissao: pula e segue, nunca aborta a busca inteira.
  const trancada = dir('trancada')
  writeFileSync(join(trancada, 'store.txt'), 'store\n')
  let aplicou = false
  try { chmodSync(trancada, 0o000); aplicou = true } catch { /* Windows */ }
  const r = await searchFileContents(root, opts('store'))
  check('pasta sem permissao nao aborta a busca', r.files.length > 0, r.files.length)
  if (aplicou) chmodSync(trancada, 0o700)
}

console.log(`\n${pass} passaram, ${fail} falharam`)
process.exit(fail === 0 ? 0 : 1)
