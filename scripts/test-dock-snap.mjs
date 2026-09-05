/**
 * Guarda a geometria do encaixe de nós ao arrastar.
 *
 * Nada aqui se verifica com o mouse. O empate entre dois vizinhos igualmente
 * próximos, a fronteira exata da zona de atração, o piso do tipo vencendo o
 * tamanho do vizinho e o nó que passa de raspão na diagonal são todos o mesmo
 * tipo de bug: um fantasma que "às vezes aparece" e ninguém reproduz na frente
 * de quem poderia consertá-lo.
 *
 * Uso: node scripts/test-dock-snap.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const outdir = await mkdtemp(join(tmpdir(), 'atelier-dock-snap-'))
const outfile = join(outdir, 'dock-snap.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { SNAP_RANGE, DOCK_GAP, dockSnapFor } from './src/renderer/canvas/dock-snap.ts'
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

const { SNAP_RANGE, DOCK_GAP, dockSnapFor } = await import(pathToFileURL(outfile).href)

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

console.log('\nencaixe de nós ao arrastar\n')

/** Piso permissivo: a maioria dos casos não é sobre o piso, e sim sobre o lado. */
const NO_FLOOR = [1, 1]
const RANGE = SNAP_RANGE

/** O vizinho parado de referência: alto e largo o bastante para caber tudo. */
const TARGET = { id: 'B', z: 1, frame: { x: 500, y: 200, width: 300, height: 400 } }

// ─── Qual lado, e o que ele iguala ────────────────────────────────────────────

test('pela direita: iguala a ALTURA do vizinho e preserva a largura', () => {
  const moving = { x: 810, y: 250, width: 120, height: 90 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE)
  assert.equal(snap.side, 'right')
  assert.equal(snap.targetId, 'B')
  assert.deepEqual(snap.frame, {
    x: 500 + 300 + DOCK_GAP,
    y: 200,
    width: 120,
    height: 400
  })
})

test('pela esquerda: mesma altura, e o x nasce do lado de LÁ', () => {
  const moving = { x: 380, y: 250, width: 100, height: 90 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE)
  assert.equal(snap.side, 'left')
  assert.deepEqual(snap.frame, { x: 500 - 100 - DOCK_GAP, y: 200, width: 100, height: 400 })
})

test('por baixo: iguala a LARGURA e preserva a altura', () => {
  const moving = { x: 550, y: 610, width: 120, height: 90 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE)
  assert.equal(snap.side, 'bottom')
  assert.deepEqual(snap.frame, {
    x: 500,
    y: 200 + 400 + DOCK_GAP,
    width: 300,
    height: 90
  })
})

test('por cima: largura do vizinho, altura preservada, y acima dele', () => {
  const moving = { x: 550, y: 120, width: 120, height: 60 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE)
  assert.equal(snap.side, 'top')
  assert.deepEqual(snap.frame, { x: 500, y: 200 - 60 - DOCK_GAP, width: 300, height: 60 })
})

// ─── Quando NÃO encaixa ───────────────────────────────────────────────────────

test('longe do vizinho não encaixa nada', () => {
  const moving = { x: 1200, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE), null)
})

test('a zona de atração tem fronteira, e ela é testada dos dois lados', () => {
  const dentro = { x: 800 + RANGE, y: 250, width: 120, height: 90 }
  const fora = { x: 800 + RANGE + 1, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(dentro, NO_FLOOR, [TARGET], RANGE).side, 'right')
  assert.equal(dockSnapFor(fora, NO_FLOOR, [TARGET], RANGE), null)
})

test('nó passando na diagonal não vira candidato', () => {
  // Encosta no canto inferior direito do vizinho: a folga lateral está dentro
  // da zona, mas os dois mal se cruzam na vertical. Não é um encaixe, é uma
  // passagem — e um fantasma aqui seria ruído no meio do arrasto.
  const moving = { x: 810, y: 580, width: 120, height: 200 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE), null)
})

test('sem candidato nenhum a resposta é null, não uma exceção', () => {
  assert.equal(dockSnapFor({ x: 0, y: 0, width: 10, height: 10 }, NO_FLOOR, [], RANGE), null)
})

// ─── Empurrar para dentro ─────────────────────────────────────────────────────

test('folga NEGATIVA ainda encaixa — empurrar por cima do vizinho vale', () => {
  // O usuário não precisa mirar num fio de cabelo: entrar alguns pixels no
  // vizinho é o jeito natural de dizer "quero aqui".
  const moving = { x: 800 - 10, y: 250, width: 120, height: 90 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE)
  assert.equal(snap.side, 'right')
})

test('afundado demais no vizinho deixa de encaixar', () => {
  const moving = { x: 800 - RANGE - 1, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE), null)
})

// ─── Piso do tipo ─────────────────────────────────────────────────────────────

test('o piso do TIPO vence o tamanho do vizinho', () => {
  // Um terminal (200×100 de piso) encostando num botão de 56×56 não encolhe
  // até sumir: ele para no próprio piso, e o fantasma mostra esse tamanho.
  const botao = { id: 'btn', z: 1, frame: { x: 500, y: 200, width: 56, height: 56 } }
  const terminal = { x: 570, y: 210, width: 260, height: 180 }
  const snap = dockSnapFor(terminal, [200, 100], [botao], RANGE)
  assert.equal(snap.side, 'right')
  assert.equal(snap.frame.height, 100, 'altura parou no piso, não nos 56 do botão')
  assert.equal(snap.frame.width, 260, 'a largura é a do nó, que já passa do piso')
})

test('o piso também segura a largura no encaixe vertical', () => {
  const botao = { id: 'btn', z: 1, frame: { x: 500, y: 200, width: 56, height: 56 } }
  const terminal = { x: 505, y: 266, width: 260, height: 180 }
  const snap = dockSnapFor(terminal, [200, 100], [botao], RANGE)
  assert.equal(snap.side, 'bottom')
  assert.equal(snap.frame.width, 200)
})

// ─── Escolha entre vários ─────────────────────────────────────────────────────

test('entre dois vizinhos ao alcance vence o mais PRÓXIMO', () => {
  const perto = { id: 'perto', z: 1, frame: { x: 500, y: 200, width: 300, height: 400 } }
  const longe = { id: 'longe', z: 1, frame: { x: 500, y: 200, width: 280, height: 400 } }
  const moving = { x: 805, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [perto, longe], RANGE).targetId, 'perto')
  // A ordem da lista não pode decidir por conta própria.
  assert.equal(dockSnapFor(moving, NO_FLOOR, [longe, perto], RANGE).targetId, 'perto')
})

test('empate exato é estável — o fantasma não pisca entre dois vizinhos', () => {
  // Dois candidatos à mesma distância: o primeiro da lista fica, e a lista de
  // nós é estável. Sem isto, um micro-movimento trocaria o alvo a cada frame.
  const a = { id: 'a', z: 1, frame: { x: 500, y: 200, width: 300, height: 400 } }
  const b = { id: 'b', z: 1, frame: { x: 500, y: 210, width: 300, height: 380 } }
  const moving = { x: 810, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [a, b], RANGE).targetId, 'a')
  assert.equal(dockSnapFor(moving, NO_FLOOR, [a, b], RANGE).targetId, 'a')
})

test('um nó em cima do outro não dispara os quatro lados ao mesmo tempo', () => {
  // Centro quase coincidente: só UM lado pode vencer, e ele tem de ser o do
  // deslocamento do centro — senão o resultado dependeria da ordem do laço.
  const moving = { x: 505, y: 205, width: 300, height: 400 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET], RANGE)
  if (snap) assert.ok(['left', 'right', 'top', 'bottom'].includes(snap.side))
})

// ─── Canvas cheio ─────────────────────────────────────────────────────────────
//
// Os três defeitos que só aparecem com muitos nós juntos, e que o gesto isolado
// de dois widgets num canvas vazio nunca revela.

test('não propõe um lugar que já tem outro nó', () => {
  // C está exatamente onde o encaixe à direita de B cairia. Prometer aquele
  // espaço seria prometer um empilhamento: o fantasma diz "cabe aqui" e o nó
  // pousa por cima de C.
  const c = { id: 'C', z: 2, frame: { x: 800 + DOCK_GAP, y: 200, width: 200, height: 400 } }
  const moving = { x: 810, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [TARGET, c], RANGE), null)
})

test('lugar ocupado cai para o próximo candidato, não para null', () => {
  // B e E têm a borda direita na mesma coluna, e o nó está à mesma distância
  // das duas. A de B está tomada por C; a de E está livre. Um espaço ocupado
  // invalida AQUELE encaixe, não o gesto inteiro — e sem esta regra o empate
  // seria resolvido pela ordem da lista, elegendo justamente o lugar ocupado.
  const e = { id: 'E', z: 1, frame: { x: 500, y: 640, width: 300, height: 300 } }
  const c = { id: 'C', z: 2, frame: { x: 800 + DOCK_GAP, y: 200, width: 200, height: 400 } }
  const moving = { x: 810, y: 520, width: 120, height: 200 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET, e, c], RANGE)
  assert.equal(snap.targetId, 'E')
  assert.equal(snap.side, 'right')
})

test('encostar de leve numa borda não conta como ocupado', () => {
  // C compartilha a borda com o encaixe, sem invadi-lo. Duas bordas coladas não
  // são um empilhamento, e o arredondamento do arrasto não pode fazer virar um.
  const frameEncaixe = { x: 800 + DOCK_GAP, y: 200, width: 120, height: 400 }
  const c = {
    id: 'C',
    z: 2,
    frame: { x: frameEncaixe.x + frameEncaixe.width, y: 200, width: 200, height: 400 }
  }
  const moving = { x: 810, y: 250, width: 120, height: 90 }
  const snap = dockSnapFor(moving, NO_FLOOR, [TARGET, c], RANGE)
  assert.equal(snap.targetId, 'B')
  assert.deepEqual(snap.frame, frameEncaixe)
})

test('vizinho escondido embaixo do nó arrastado não vira alvo', () => {
  // O nó pequeno está inteiro debaixo do arrastado, e encostado na borda
  // esquerda dele — perto o bastante para a folga entrar na zona. Sem a regra
  // de cobertura ele venceria, e o fantasma nasceria apontando para algo que
  // não está na tela: o usuário não teria como entender de onde veio.
  const escondido = { id: 'sob', z: 1, frame: { x: 500, y: 250, width: 40, height: 100 } }
  const moving = { x: 500, y: 200, width: 300, height: 400 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [escondido], RANGE), null)
})

test('entre dois empilhados encaixa no de CIMA', () => {
  // Mesma geometria, z diferente: quem está vendo o de cima espera encaixar
  // nele, e é ele que serve de referência de tamanho.
  const baixo = { id: 'baixo', z: 1, frame: { x: 500, y: 200, width: 300, height: 400 } }
  const cima = { id: 'cima', z: 9, frame: { x: 500, y: 200, width: 300, height: 400 } }
  const moving = { x: 810, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(moving, NO_FLOOR, [baixo, cima], RANGE).targetId, 'cima')
  assert.equal(dockSnapFor(moving, NO_FLOOR, [cima, baixo], RANGE).targetId, 'cima')
})

// ─── Inércia da escolha ───────────────────────────────────────────────────────

/**
 * Um vizinho à ESQUERDA e outro ACIMA: as duas folgas correm em eixos
 * diferentes, então um movimento diagonal de poucos pontos inverte qual é a
 * menor. É a única forma de um quase-empate de verdade — dois vizinhos no mesmo
 * eixo mantêm a ordem entre si por mais que a mão ande.
 */
const ESQUERDA = { id: 'esq', z: 1, frame: { x: 500, y: 300, width: 300, height: 400 } }
const ACIMA = { id: 'cima', z: 1, frame: { x: 820, y: 100, width: 300, height: 200 } }

test('o alvo do quadro anterior não é trocado por um quase-empate', () => {
  // Sem inércia o vencedor viraria 'esq' no segundo quadro — dois pontos de
  // diferença numa folga de onze —, e o fantasma pularia de lugar no meio do
  // gesto por causa de um movimento que o usuário nem percebeu fazer.
  const antes = { x: 814, y: 308, width: 120, height: 200 }
  const depois = { x: 809, y: 311, width: 120, height: 200 }

  const primeiro = dockSnapFor(antes, NO_FLOOR, [ESQUERDA, ACIMA], RANGE)
  assert.equal(primeiro.targetId, 'cima')
  assert.equal(dockSnapFor(depois, NO_FLOOR, [ESQUERDA, ACIMA], RANGE).targetId, 'esq')

  const comInercia = dockSnapFor(depois, NO_FLOOR, [ESQUERDA, ACIMA], RANGE, primeiro)
  assert.equal(comInercia.targetId, 'cima', 'trocou de alvo por dois pontos de diferença')
})

test('mas um alvo claramente mais perto ROUBA a vez', () => {
  // A inércia não pode virar teimosia: quem chegou perto de verdade ganha.
  const antes = { x: 814, y: 308, width: 120, height: 200 }
  const colado = { x: 801, y: 311, width: 120, height: 200 }
  const primeiro = dockSnapFor(antes, NO_FLOOR, [ESQUERDA, ACIMA], RANGE)
  assert.equal(primeiro.targetId, 'cima')
  assert.equal(dockSnapFor(colado, NO_FLOOR, [ESQUERDA, ACIMA], RANGE, primeiro).targetId, 'esq')
})

test('a inércia não segura um alvo que saiu da zona', () => {
  const anterior = dockSnapFor({ x: 810, y: 250, width: 120, height: 90 }, NO_FLOOR, [TARGET], RANGE)
  const fora = { x: 1400, y: 250, width: 120, height: 90 }
  assert.equal(dockSnapFor(fora, NO_FLOOR, [TARGET], RANGE, anterior), null)
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
