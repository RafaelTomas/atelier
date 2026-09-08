/**
 * `normalizeURL` — o que a barra de endereço faz com o que foi digitado.
 *
 * A função é compartilhada entre o renderer (onde o usuário digita) e o main
 * (onde o agente digita, via `atelier portal open`), e não tinha teste nenhum.
 * Nasceu com a correção do arquivo HTML local: um caminho de disco colado na
 * barra virava `https://` e nunca abria.
 *
 * Puro sobre uma função pura — nem esbuild do núcleo, nem ATELIER_HOME.
 */
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const outdir = await mkdtemp(join(tmpdir(), 'atelier-portal-url-'))
const outfile = join(outdir, 'mod.mjs')
await esbuild.build({
  entryPoints: [join(ROOT, 'src/shared/portal-url.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})
const { normalizeURL, HOME_URL } = await import(pathToFileURL(outfile).href)

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

console.log('\nportal-url: o que a barra faz com o que foi digitado\n')

// ─── O que já existia ───────────────────────────────────────────────────────

test('vazio devolve vazio, e não a home', () => {
  // Quem chama trata `''` como "não navegue"; devolver a home aqui faria um
  // Enter numa barra vazia jogar o portal para o Google.
  assert.equal(normalizeURL(''), '')
  assert.equal(normalizeURL('   '), '')
})

test('domínio nu ganha https', () => {
  assert.equal(normalizeURL('electron.com'), 'https://electron.com')
  assert.equal(normalizeURL('  electron.com  '), 'https://electron.com')
})

test('localhost ganha HTTP, não HTTPS — o servidor local não responde em TLS', () => {
  assert.equal(normalizeURL('localhost:5173'), 'http://localhost:5173')
  assert.equal(normalizeURL('localhost'), 'http://localhost')
  assert.equal(normalizeURL('127.0.0.1:8080'), 'http://127.0.0.1:8080')
  // E vem ANTES do teste de esquema: `localhost:` tem cara de scheme.
  assert.equal(normalizeURL('localhost:3000/api'), 'http://localhost:3000/api')
})

test('esquema explícito passa intacto', () => {
  assert.equal(normalizeURL('https://a.com/x?y=1#z'), 'https://a.com/x?y=1#z')
  assert.equal(normalizeURL('http://a.com'), 'http://a.com')
  // Inclusive `file://` já escrito por extenso — era o único jeito de abrir um
  // arquivo local antes da correção.
  assert.equal(normalizeURL('file:///home/eu/x.html'), 'file:///home/eu/x.html')
})

test('termo solto vira busca, com o texto escapado', () => {
  assert.equal(normalizeURL('como usar electron'), 'https://www.google.com/search?q=como%20usar%20electron')
  assert.equal(normalizeURL('c++ & rust'), 'https://www.google.com/search?q=c%2B%2B%20%26%20rust')
  assert.equal(HOME_URL, 'https://www.google.com')
})

// ─── O que a correção do arquivo local trouxe ───────────────────────────────

test('caminho POSIX vira file:// com três barras', () => {
  // Era o bug: `/home/eu/x.html` tem ponto e nenhum espaço, então casava com
  // "tem cara de domínio" e saía como `https://home/eu/x.html`.
  assert.equal(normalizeURL('/home/eu/x.html'), 'file:///home/eu/x.html')
  assert.equal(normalizeURL('/tmp/relatorio.pdf'), 'file:///tmp/relatorio.pdf')
})

test('caminho com espaço no nome também abre, em vez de virar busca', () => {
  // O outro meio do bug: com espaço, o teste de domínio falhava e o caminho ia
  // para o Google. Espaço em nome de arquivo é comum, e o `%20` é obrigatório.
  assert.equal(normalizeURL('/home/eu/meu arquivo.html'), 'file:///home/eu/meu%20arquivo.html')
})

test('`#` no nome do arquivo é escapado, e não corta a URL', () => {
  // Cru, o `#` viraria fragmento e o Chromium pediria um arquivo que não existe.
  assert.equal(normalizeURL('/tmp/nota #3.html'), 'file:///tmp/nota%20%233.html')
})

test('unidade do Windows sobrevive com o `:` intacto', () => {
  // `C:` escapado (`C%3A`) faz o Chromium desistir do arquivo — o `:` da
  // unidade é estrutura, não nome.
  assert.equal(normalizeURL('C:\\notas\\x.html'), 'file:///C:/notas/x.html')
  assert.equal(normalizeURL('C:/notas/x.html'), 'file:///C:/notas/x.html')
  assert.equal(normalizeURL('d:\\meus documentos\\a.html'), 'file:///d:/meus%20documentos/a.html')
})

test('UNC mantém o servidor como host, com duas barras só', () => {
  assert.equal(normalizeURL('\\\\servidor\\share\\x.html'), 'file://servidor/share/x.html')
})

test('caminho de pasta, sem extensão, ainda é caminho', () => {
  // Não tem ponto, então antes caía na busca. Um portal em `file://` de pasta
  // lista o diretório, que é comportamento útil do Chromium.
  assert.equal(normalizeURL('/home/eu/Projetos'), 'file:///home/eu/Projetos')
})

// ─── As fronteiras: o que NÃO é caminho ─────────────────────────────────────

test('URL protocol-relative não é confundida com caminho', () => {
  // `//cdn.exemplo.com/x.js` começa com barra, mas duas — e é URL, não disco.
  // É por isso que o teste de caminho POSIX exige UMA barra: `/^\/(?!\/)/`.
  assert.equal(normalizeURL('//cdn.exemplo.com/x.js'), 'https://cdn.exemplo.com/x.js')
})

test('`a:` de uma letra só não vira unidade de disco sem a barra', () => {
  // `mailto:`, `data:` e afins têm de continuar passando pelo esquema. A regra
  // da unidade exige `[A-Za-z]:` SEGUIDO de barra, e é o que separa `C:\x` de
  // `mailto:eu@a.com`.
  assert.equal(normalizeURL('mailto:eu@a.com'), 'mailto:eu@a.com')
  assert.equal(normalizeURL('data:text/html,<b>x</b>'), 'data:text/html,<b>x</b>')
})

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed > 0 ? 1 : 0)
