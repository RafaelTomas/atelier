/**
 * Guarda a geometria do MODO FOCO — o retângulo que um nó ocupa quando o duplo
 * clique o amplia.
 *
 * Nada aqui se verifica com o mouse. O que separa um painel de um botão é uma
 * lista de tipos; o que impede um botão de virar cartaz é um teto; e o que
 * mantém o nó centralizado é uma divisão por dois que fica igualmente
 * "parecendo certa" quando a margem é aplicada só de um lado. Todos produzem
 * uma tela que está quase boa — o tipo de erro que ninguém abre um bug para
 * contar.
 *
 * Uso: node scripts/test-focus.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const outdir = await mkdtemp(join(tmpdir(), 'atelier-focus-'))
const outfile = join(outdir, 'focus.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        FOCUS_MARGIN,
        FOCUS_MAX_SCALE,
        FOCUS_Z,
        focusFrame,
        keepsAspect
      } from './src/renderer/canvas/focus-frame.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const { FOCUS_MARGIN, FOCUS_MAX_SCALE, FOCUS_Z, focusFrame, keepsAspect } = await import(
  pathToFileURL(outfile).href
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

console.log('\ngeometria do modo foco\n')

/** A janela do teste, com o origin fora do zero: coordenada de canvas não é tela. */
const VIEW = { origin: { x: 9800, y: 8500 }, width: 1440, height: 900 }

const node = (content, width, height) => ({
  id: 'n1',
  frame: { x: 100, y: 200, width, height },
  content,
  zIndex: 1,
  isLocked: false,
  createdAt: '',
  lastModifiedAt: ''
})

const terminal = (w = 560, h = 360) => node({ type: 'terminal', value: {} }, w, h)
const button = (w = 88, h = 88) => node({ type: 'widget', value: { kind: 'button' } }, w, h)
const clock = (w = 200, h = 140) => node({ type: 'widget', value: { kind: 'clock' } }, w, h)
const text = (w = 160, h = 40) => node({ type: 'text', value: {} }, w, h)

// ─── Quem preenche e quem mantém a proporção ─────────────────────────────────

test('painel preenche, sem moldura mantém a proporção', () => {
  assert.equal(keepsAspect({ type: 'terminal', value: {} }), false)
  assert.equal(keepsAspect({ type: 'portal', value: {} }), false)
  assert.equal(keepsAspect({ type: 'codeEditor', value: {} }), false)
  assert.equal(keepsAspect({ type: 'stickyNote', value: {} }), false)
  assert.equal(keepsAspect({ type: 'secretVault', value: {} }), false)
  assert.equal(keepsAspect({ type: 'text', value: {} }), true)
  assert.equal(keepsAspect({ type: 'widget', value: { kind: 'button' } }), true)
  assert.equal(keepsAspect({ type: 'widget', value: { kind: 'clock' } }), true)
})

test('widget de PAINEL preenche — o teto é dos pequenos, não do kind', () => {
  // git, monitor, todo e projeto são widgets como o botão, mas hospedam painel:
  // mais área é mais linha à vista. Confundir os dois pelo `type` daria a eles
  // o teto de 3× e uma coluna estreita no meio da tela.
  for (const kind of ['git', 'monitor', 'todo', 'project']) {
    assert.equal(keepsAspect({ type: 'widget', value: { kind } }), false, kind)
  }
})

test('um kind desconhecido conta como painel', () => {
  // O `kind` atravessa este binário sem ser estreitado (ver WidgetContent), então
  // um widget gravado por uma versão mais nova chega aqui. Preencher é o
  // resultado certo para um painel que ainda não sabemos ler.
  assert.equal(keepsAspect({ type: 'widget', value: { kind: 'inventado-em-2027' } }), false)
})

// ─── Painel: preenche a área ─────────────────────────────────────────────────

test('painel toma a janela menos a margem dos DOIS lados', () => {
  const r = focusFrame(terminal(), VIEW)
  assert.equal(r.width, VIEW.width - FOCUS_MARGIN * 2)
  assert.equal(r.height, VIEW.height - FOCUS_MARGIN * 2)
})

test('painel sai no origin + margem, não no origin', () => {
  // O erro que isto pega: esquecer o origin e devolver coordenada de TELA. O nó
  // apareceria no canto superior esquerdo do canvas, longe da janela.
  const r = focusFrame(terminal(), VIEW)
  assert.equal(r.x, VIEW.origin.x + FOCUS_MARGIN)
  assert.equal(r.y, VIEW.origin.y + FOCUS_MARGIN)
})

test('o tamanho de partida do painel não muda nada — ele preenche igual', () => {
  const pequeno = focusFrame(terminal(200, 100), VIEW)
  const grande = focusFrame(terminal(1900, 1200), VIEW)
  assert.deepEqual(pequeno, grande)
})

// ─── Proporção: cresce sem deformar ──────────────────────────────────────────

test('botão quadrado continua quadrado', () => {
  const r = focusFrame(button(), VIEW)
  assert.equal(r.width, r.height)
})

test('o teto vale: um botão de 88 vira 264, não a tela inteira', () => {
  const r = focusFrame(button(88, 88), VIEW)
  assert.equal(r.width, 88 * FOCUS_MAX_SCALE)
  assert.equal(r.height, 88 * FOCUS_MAX_SCALE)
})

test('relógio cresce pelo teto e mantém a razão de lados', () => {
  const r = focusFrame(clock(200, 140), VIEW)
  assert.equal(r.width, 600)
  assert.equal(r.height, 420)
  assert.equal(r.width / r.height, 200 / 140)
})

test('quem manda é o MENOR dos três fatores, não sempre o teto', () => {
  // Um rótulo largo e baixo: 3× estouraria a largura disponível, então quem
  // decide é o que cabe. Sem esse mínimo o nó vazaria pelas laterais.
  const r = focusFrame(text(1200, 40), VIEW)
  const cabe = (VIEW.width - FOCUS_MARGIN * 2) / 1200
  assert.ok(cabe < FOCUS_MAX_SCALE)
  assert.equal(r.width, VIEW.width - FOCUS_MARGIN * 2)
  assert.equal(r.height, Math.round(40 * cabe))
})

test('nó de proporção MAIOR que a tela encolhe para caber', () => {
  // O fator vira menor que 1 e a conta continua valendo: focar não pode
  // devolver um retângulo que vaza pelas bordas.
  const r = focusFrame(button(4000, 4000), VIEW)
  assert.ok(r.width <= VIEW.width - FOCUS_MARGIN * 2)
  assert.ok(r.height <= VIEW.height - FOCUS_MARGIN * 2)
  assert.equal(r.width, r.height)
})

test('nó de área zero cai no preenchimento em vez de sumir', () => {
  // Dividir por zero daria Infinity ou NaN, e o nó sairia da tela ou não
  // renderizaria. Não há proporção para manter num retângulo sem lados.
  const r = focusFrame(button(0, 0), VIEW)
  assert.equal(r.width, VIEW.width - FOCUS_MARGIN * 2)
  assert.equal(r.height, VIEW.height - FOCUS_MARGIN * 2)
})

// ─── Centralização ───────────────────────────────────────────────────────────

test('o que sobra vira margem dos dois lados, não de um só', () => {
  const r = focusFrame(button(), VIEW)
  const sobraEsquerda = r.x - VIEW.origin.x
  const sobraDireita = VIEW.origin.x + VIEW.width - (r.x + r.width)
  assert.equal(sobraEsquerda, sobraDireita)
  const sobraTopo = r.y - VIEW.origin.y
  const sobraBaixo = VIEW.origin.y + VIEW.height - (r.y + r.height)
  assert.equal(sobraTopo, sobraBaixo)
})

test('centralizado em qualquer janela, inclusive nas estreitas', () => {
  // Folga de meio pixel: a moldura sai arredondada, e um lado ímpar não tem
  // centro inteiro. O que se testa é que ele não pende para um lado.
  for (const [width, height] of [[800, 600], [1440, 900], [2560, 1440], [420, 380]]) {
    const view = { origin: { x: 0, y: 0 }, width, height }
    const r = focusFrame(clock(), view)
    assert.ok(Math.abs(r.x + r.width / 2 - width / 2) <= 0.5, `centro x em ${width}×${height}`)
    assert.ok(Math.abs(r.y + r.height / 2 - height / 2) <= 0.5, `centro y em ${width}×${height}`)
  }
})

test('janela menor que as duas margens não devolve tamanho negativo', () => {
  // Uma janela de 40px de altura com margem de 48 dos dois lados daria -56. Um
  // retângulo negativo não é "pequeno demais", é um nó que some.
  const r = focusFrame(terminal(), { origin: { x: 0, y: 0 }, width: 60, height: 40 })
  assert.ok(r.width > 0)
  assert.ok(r.height > 0)
})

// ─── O andar do foco ─────────────────────────────────────────────────────────

test('FOCUS_Z passa longe dos z-index reais dos nós', () => {
  // Eles vêm de `maxZ + 1` a cada trazer-para-frente: crescem de um em um pela
  // vida do workspace. Um empate aqui poria um nó qualquer por cima do véu.
  assert.ok(FOCUS_Z > 100_000)
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
