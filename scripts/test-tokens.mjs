// Guarda a camada de tokens. Três invariantes, e cada uma existe por um modo de
// falha concreto que já é fácil de introduzir sem perceber:
//
//   1. Os dois blocos escuros têm as MESMAS chaves e os MESMOS valores.
//      O escuro é escrito duas vezes de propósito — `@media (prefers-color-
//      scheme: dark)` e `[data-theme='dark']` são gatilhos distintos, e CSS não
//      tem "herdar um bloco". Um token novo adicionado só num deles quebraria
//      um dos modos e passaria em branco, porque nunca se testam os dois na
//      mesma sessão.
//
//   2. Todo token do escuro existe no `:root` claro.
//      É a regra escrita na primeira linha de styles/tokens.css: nenhuma cor
//      tem sua única definição dentro de um @media. Se tiver, o tema claro fica
//      com a propriedade vazia e o navegador cai no valor inicial — cor
//      transparente, e nada aparece.
//
//   3. Todo `var(--x)` usado no CSS do renderer está definido em algum lugar.
//      Um token renomeado deixa `var()` órfão, e CSS não reclama: a declaração
//      é descartada em silêncio.
//
// Não é um teste de aparência — nenhum destes três é detectável olhando a tela
// no tema em que se está trabalhando.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stylesDir = join(root, 'src/renderer/styles')
const tokens = readFileSync(join(stylesDir, 'tokens.css'), 'utf8')

let failures = 0
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++ }
const ok = (msg) => console.log(`  ✓ ${msg}`)

/** Os pares --nome: valor de um bloco, a partir do índice da chave de abertura. */
function declsAt(css, openBrace) {
  let depth = 0
  let i = openBrace
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') { depth--; if (depth === 0) break }
  }
  const body = css.slice(openBrace + 1, i)
  const out = new Map()
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim())
  }
  return out
}

/** O bloco cujo seletor casa com o regex — o primeiro `{` depois dele. */
function block(css, selectorRe, label) {
  const m = css.match(selectorRe)
  if (!m) { fail(`bloco não encontrado: ${label}`); return new Map() }
  return declsAt(css, css.indexOf('{', m.index))
}

// ── 1 e 2 ────────────────────────────────────────────────────────────────────
const light = block(tokens, /^:root \{/m, ':root (claro)')
const darkMedia = block(tokens, /:root:not\(\[data-theme='light'\]\) \{/, 'escuro por @media')
const darkExplicit = block(tokens, /:root\[data-theme='dark'\] \{/, "escuro por [data-theme='dark']")

const keys = (m) => [...m.keys()].sort()
const soDentro = (a, b) => keys(a).filter((k) => !b.has(k))

for (const k of soDentro(darkMedia, darkExplicit)) {
  fail(`--${k.slice(2)} está no escuro do @media mas não no [data-theme='dark']`)
}
for (const k of soDentro(darkExplicit, darkMedia)) {
  fail(`--${k.slice(2)} está no [data-theme='dark'] mas não no escuro do @media`)
}
for (const [k, v] of darkMedia) {
  const outro = darkExplicit.get(k)
  if (outro !== undefined && outro !== v) {
    fail(`${k} divergiu entre os dois blocos escuros: '${v}' vs '${outro}'`)
  }
}
if (!failures) ok(`os dois blocos escuros batem (${darkMedia.size} tokens)`)

const antes = failures
for (const k of keys(darkMedia)) {
  if (!light.has(k)) fail(`${k} só existe no escuro — o tema claro fica sem valor`)
}
if (failures === antes) ok(`todo token escuro tem base no :root claro (${light.size} tokens claros)`)

// ── 3 ────────────────────────────────────────────────────────────────────────
function cssFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return cssFiles(p)
    return n.endsWith('.css') ? [p] : []
  })
}

const allCss = cssFiles(join(root, 'src/renderer'))
const definidos = new Set()
for (const f of allCss) {
  for (const m of readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) definidos.add(m[1])
}

// Tokens escritos pelo JS em tempo de execução, não por uma regra CSS.
for (const m of readdirSync(join(root, 'src/renderer'), { recursive: true })) {
  const p = join(root, 'src/renderer', String(m))
  if (!/\.tsx?$/.test(p) || statSync(p).isDirectory()) continue
  for (const g of readFileSync(p, 'utf8').matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) {
    definidos.add(g[1])
  }
}

const orfaos = new Set()
for (const f of allCss) {
  const css = readFileSync(f, 'utf8')
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!definidos.has(m[1])) orfaos.add(`${m[1]} (usado em ${f.replace(root + '/', '')})`)
  }
}
for (const o of [...orfaos].sort()) fail(`var() sem definição: ${o}`)
if (!orfaos.size) ok(`nenhum var() órfão em ${allCss.length} arquivos CSS`)

if (failures) {
  console.error(`\ntest-tokens: ${failures} falha(s)`)
  process.exit(1)
}
console.log('test-tokens: ok')
