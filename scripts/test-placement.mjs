/**
 * Guarda a geometria das pílulas flutuantes.
 *
 * Nada aqui é verificável arrastando uma dock com o mouse: o empate exato num
 * canto, o grampo da fração nas pontas, o round-trip do formato em disco e o
 * estado em que as duas pílulas acabam na mesma borda. Todos produzem uma
 * interface que "às vezes faz outra coisa" — o tipo de bug que nunca se
 * reproduz na frente de quem pode consertá-lo.
 *
 * Uso: node scripts/test-placement.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const outdir = await mkdtemp(join(tmpdir(), 'atelier-placement-'))
const outfile = join(outdir, 'placement.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        SNAP_MARGIN,
        EDGE_PAD,
        EDGE_PAD_TOP,
        PILL_GAP,
        edgeFor,
        fitAlongEdge,
        fitAmong,
        offsetFor,
        offsetForStart,
        padStart,
        spanStart,
        placementFor,
        resolveCollision
      } from './src/shared/placement.ts'
      export {
        ALIGN_OFFSET,
        DOCK_PLACEMENT_DEFAULT,
        MONITOR_PLACEMENT_DEFAULT,
        PLACEMENTS,
        RAIL_PLACEMENT_DEFAULT,
        formatPlacement,
        isVerticalEdge,
        parsePlacement,
        samePlacement
      } from './src/shared/types.ts'
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

const {
  SNAP_MARGIN,
  EDGE_PAD,
  EDGE_PAD_TOP,
  PILL_GAP,
  edgeFor,
  fitAlongEdge,
  fitAmong,
  offsetFor,
  offsetForStart,
  padStart,
  spanStart,
  placementFor,
  resolveCollision,
  ALIGN_OFFSET,
  DOCK_PLACEMENT_DEFAULT,
  MONITOR_PLACEMENT_DEFAULT,
  PLACEMENTS,
  RAIL_PLACEMENT_DEFAULT,
  formatPlacement,
  isVerticalEdge,
  parsePlacement,
  samePlacement
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

console.log('\nposição das pílulas flutuantes\n')

const VP = { width: 1200, height: 800 }

// ─── A borda vencedora ────────────────────────────────────────────────────────

test('cada borda vence perto de si', () => {
  assert.equal(edgeFor(10, 400, VP), 'left')
  assert.equal(edgeFor(1190, 400, VP), 'right')
  assert.equal(edgeFor(600, 10, VP), 'top')
  assert.equal(edgeFor(600, 790, VP), 'bottom')
})

test('o meio do canvas não encaixa em nada — a pílula volta para onde estava', () => {
  // "Quase encaixou" é pior que não mover: soltar no meio é quase sempre um
  // gesto abandonado.
  assert.equal(edgeFor(600, 400, VP), null)
})

test('a margem de encaixe tem uma fronteira, e ela é testada dos dois lados', () => {
  assert.equal(edgeFor(SNAP_MARGIN, 400, VP), 'left')
  assert.equal(edgeFor(SNAP_MARGIN + 1, 400, VP), null)
})

test('nos quatro cantos vence a HORIZONTAL — escolha fixa, não sorteio', () => {
  // Num canto exato as distâncias empatam e alguém tem de decidir. O que não
  // pode é a decisão variar: o mesmo gesto daria resultados diferentes conforme
  // o arredondamento do ponteiro.
  assert.equal(edgeFor(0, 0, VP), 'left')
  assert.equal(edgeFor(1200, 0, VP), 'right')
  assert.equal(edgeFor(0, 800, VP), 'left')
  assert.equal(edgeFor(1200, 800, VP), 'right')
})

test('perto de um canto, a borda MAIS próxima vence o desempate', () => {
  // 5px do topo contra 40px da esquerda: o topo ganha, apesar de a horizontal
  // ser a preferida no empate.
  assert.equal(edgeFor(40, 5, VP), 'top')
  assert.equal(edgeFor(5, 40, VP), 'left')
})

// ─── A posição ao longo da borda ──────────────────────────────────────────────

test('numa borda horizontal, a fração sai do X', () => {
  assert.equal(offsetFor(0, 790, 'bottom', VP), 0)
  assert.equal(offsetFor(600, 790, 'bottom', VP), 0.5)
  assert.equal(offsetFor(1200, 790, 'bottom', VP), 1)
})

test('numa borda vertical, a fração sai do Y', () => {
  assert.equal(offsetFor(10, 0, 'left', VP), 0)
  assert.equal(offsetFor(10, 400, 'left', VP), 0.5)
  assert.equal(offsetFor(10, 800, 'left', VP), 1)
})

test('a posição é CONTÍNUA — nada de saltar para o terço mais próximo', () => {
  // É o ponto da mudança: antes, estes três pontos viravam todos 'start'.
  assert.equal(offsetFor(120, 790, 'bottom', VP), 0.1)
  assert.equal(offsetFor(240, 790, 'bottom', VP), 0.2)
  assert.equal(offsetFor(360, 790, 'bottom', VP), 0.3)
})

test('ponteiro fora da janela é grampeado, não vira posição negativa', () => {
  // Acontece de verdade: a captura de ponteiro continua entregando eventos
  // depois que o cursor sai da janela, e uma fração negativa jogaria a pílula
  // para fora da tela.
  assert.equal(offsetFor(-300, 790, 'bottom', VP), 0)
  assert.equal(offsetFor(9000, 790, 'bottom', VP), 1)
})

test('viewport degenerado não vira NaN', () => {
  assert.equal(offsetFor(0, 0, 'bottom', { width: 0, height: 0 }), 0.5)
})

test('placementFor junta os dois, e devolve null no meio', () => {
  assert.deepEqual(placementFor(10, 100, VP), { edge: 'left', offset: 0.125 })
  assert.equal(placementFor(600, 400, VP), null)
})

// ─── parsePlacement: nenhum estado em disco esconde a dock ───────────────────

test('parsePlacement lê as paradas nomeadas — o formato que já está em disco', () => {
  assert.deepEqual(parsePlacement('bottom/center', DOCK_PLACEMENT_DEFAULT), {
    edge: 'bottom',
    offset: 0.5
  })
  assert.deepEqual(parsePlacement('right/end', DOCK_PLACEMENT_DEFAULT), {
    edge: 'right',
    offset: 1
  })
  assert.deepEqual(parsePlacement('left/start', DOCK_PLACEMENT_DEFAULT), {
    edge: 'left',
    offset: 0
  })
})

test('parsePlacement lê a fração explícita', () => {
  assert.deepEqual(parsePlacement('top/0.317', DOCK_PLACEMENT_DEFAULT), {
    edge: 'top',
    offset: 0.317
  })
  assert.deepEqual(parsePlacement('top/0', DOCK_PLACEMENT_DEFAULT), { edge: 'top', offset: 0 })
  assert.deepEqual(parsePlacement('top/1', DOCK_PLACEMENT_DEFAULT), { edge: 'top', offset: 1 })
})

test('uma fração impossível cai no padrão em vez de esconder a pílula', () => {
  // Fora de [0,1] a pílula sairia da janela, e sem como voltar a não ser
  // editando as preferências à mão.
  for (const ruim of ['bottom/2', 'bottom/-0.5', 'bottom/1.0001', 'bottom/NaN', 'bottom/1e-3']) {
    assert.ok(
      samePlacement(parsePlacement(ruim, DOCK_PLACEMENT_DEFAULT), DOCK_PLACEMENT_DEFAULT),
      `${ruim} passou`
    )
  }
})

test('formatPlacement grava palavra nas três paradas e número no resto', () => {
  // As posições que uma versão anterior sabia ler continuam escritas como ela
  // as escrevia; só uma posição de fato nova estreia o formato numérico.
  assert.equal(formatPlacement({ edge: 'bottom', offset: 0.5 }), 'bottom/center')
  assert.equal(formatPlacement({ edge: 'bottom', offset: 0 }), 'bottom/start')
  assert.equal(formatPlacement({ edge: 'bottom', offset: 1 }), 'bottom/end')
  assert.equal(formatPlacement({ edge: 'bottom', offset: 0.3172 }), 'bottom/0.317')
})

test('qualquer fração fecha o círculo com três casas de precisão', () => {
  for (let i = 0; i <= 1000; i++) {
    const p = { edge: 'top', offset: i / 1000 }
    const back = parsePlacement(formatPlacement(p), DOCK_PLACEMENT_DEFAULT)
    assert.ok(samePlacement(back, p), `${formatPlacement(p)} não fez round-trip`)
  }
})

test('lixo em disco cai no padrão SEM lançar — a dock nunca some', () => {
  const lixeira = ['', 'cima/meio', 'bottom', 'bottom/', '/center', null, undefined, 42, {}, 'a/b/c', 'bottom/ ', 'bottom/abc']
  for (const lixo of lixeira) {
    const r = parsePlacement(lixo, DOCK_PLACEMENT_DEFAULT)
    assert.ok(samePlacement(r, DOCK_PLACEMENT_DEFAULT), `${JSON.stringify(lixo)} não caiu no padrão`)
  }
})

test('formatPlacement e parsePlacement fecham o círculo nas doze nomeadas', () => {
  assert.equal(PLACEMENTS.length, 12)
  for (const p of PLACEMENTS) {
    const back = parsePlacement(formatPlacement(p), DOCK_PLACEMENT_DEFAULT)
    assert.ok(samePlacement(back, p), `${formatPlacement(p)} não fez round-trip`)
  }
})

test('os padrões são a posição histórica das duas peças', () => {
  // Perder as preferências (um save do app nativo, que não conhece as chaves)
  // devolve exatamente a interface de antes desta feature.
  assert.equal(formatPlacement(DOCK_PLACEMENT_DEFAULT), 'bottom/center')
  assert.equal(formatPlacement(RAIL_PLACEMENT_DEFAULT), 'left/center')
  // O 0.85 da tira não é uma parada nomeada: ele grava o número, e é o único
  // dos três padrões que uma versão anterior deste binário não saberia ler.
  assert.equal(formatPlacement(MONITOR_PLACEMENT_DEFAULT), 'top/0.850')
})

test('ALIGN_OFFSET é a ponte entre o menu de contexto e a fração', () => {
  assert.deepEqual(ALIGN_OFFSET, { start: 0, center: 0.5, end: 1 })
})

test('isVerticalEdge decide a orientação da pílula', () => {
  assert.equal(isVerticalEdge('left'), true)
  assert.equal(isVerticalEdge('right'), true)
  assert.equal(isVerticalEdge('top'), false)
  assert.equal(isVerticalEdge('bottom'), false)
})

// ─── Dividir uma borda ────────────────────────────────────────────────────────
//
// Duas pílulas na mesma borda são legítimas desde que não se sobreponham. Nada
// disto é verificável com o mouse: o caso apertado só aparece numa combinação
// exata de janela estreita e dock cheia, que é justamente quando ninguém está
// olhando.

// A base de 1200px do VP: dock de 600 e rail de 46 cabem com folga de sobra.
const DOCK = 600
const RAIL = 46

test('a conta do CSS e a do módulo são a MESMA', () => {
  // spanStart reproduz o par inset+translate de floating.css. Se as duas contas
  // divergirem, o encaixe decide sobre uma posição que a tela não tem.
  assert.equal(spanStart(0, DOCK, 1200, 'bottom'), EDGE_PAD)
  assert.equal(spanStart(1, DOCK, 1200, 'bottom'), 1200 - EDGE_PAD - DOCK)
  assert.equal(spanStart(0.5, DOCK, 1200, 'bottom'), (1200 - DOCK) / 2)
})

test('spanStart e offsetForStart fecham o círculo', () => {
  for (const o of [0, 0.13, 0.5, 0.87, 1]) {
    const back = offsetForStart(spanStart(o, DOCK, 1200, 'bottom'), DOCK, 1200, 'bottom')
    assert.ok(Math.abs(back - o) < 1e-9, `${o} não fez round-trip (deu ${back})`)
  }
})

test('uma pílula maior que a borda não vira divisão por zero', () => {
  assert.equal(spanStart(0.7, 5000, 1200, 'bottom'), EDGE_PAD)
  assert.equal(offsetForStart(400, 5000, 1200, 'bottom'), 0)
})

test('longe uma da outra, ninguém se move — o caso comum', () => {
  // Dock no começo da base, rail no fim: dividir a borda é o resultado, e
  // empurrar qualquer uma seria mexer no que o usuário não pediu.
  const fit = fitAlongEdge({ offset: 0, length: DOCK }, { offset: 1, length: RAIL }, 1200, 'bottom')
  assert.equal(fit.kind, 'ok')
})

test('a folga mínima entre as duas é testada dos dois lados', () => {
  // Encostadas, as duas viram uma barra só aos olhos de quem clica.
  const total = 1200
  const dockStart = spanStart(0, DOCK, total, 'bottom') // 18
  const colada = offsetForStart(dockStart + DOCK + PILL_GAP, RAIL, total, 'bottom')
  const quase = offsetForStart(dockStart + DOCK + PILL_GAP - 1, RAIL, total, 'bottom')
  assert.equal(fitAlongEdge({ offset: 0, length: DOCK }, { offset: colada, length: RAIL }, total, 'bottom').kind, 'ok')
  assert.equal(fitAlongEdge({ offset: 0, length: DOCK }, { offset: quase, length: RAIL }, total, 'bottom').kind, 'push')
})

test('sobrepostas, quem anda é a que o usuário NÃO tocou', () => {
  // As duas no centro: a arrastada fica onde foi posta, e a outra sai de perto.
  const fit = fitAlongEdge({ offset: 0.5, length: DOCK }, { offset: 0.5, length: RAIL }, 1200, 'bottom')
  assert.equal(fit.kind, 'push')
  const start = spanStart(fit.offset, RAIL, 1200, 'bottom')
  const dockStart = spanStart(0.5, DOCK, 1200, 'bottom')
  // Sem cruzar, e com a folga inteira.
  assert.ok(start + RAIL + PILL_GAP <= dockStart || start >= dockStart + DOCK + PILL_GAP)
})

test('o empurrão vai para o lado mais PERTO de onde a outra já estava', () => {
  const total = 1200
  // Dock centrada (300..900). Rail logo à esquerda do centro: o vão da esquerda
  // é o que exige menos deslocamento.
  const esq = fitAlongEdge({ offset: 0.5, length: DOCK }, { offset: 0.35, length: RAIL }, total, 'bottom')
  assert.equal(esq.kind, 'push')
  assert.ok(spanStart(esq.offset, RAIL, total, 'bottom') < spanStart(0.5, DOCK, total, 'bottom'))

  // Espelhado: vindo da direita, ela sai pela direita.
  const dir = fitAlongEdge({ offset: 0.5, length: DOCK }, { offset: 0.65, length: RAIL }, total, 'bottom')
  assert.equal(dir.kind, 'push')
  assert.ok(spanStart(dir.offset, RAIL, total, 'bottom') > spanStart(0.5, DOCK, total, 'bottom') + DOCK)
})

test('a empurrada nunca sai da borda', () => {
  // Varre a dock por toda a base e confere que a rail termina dentro das folgas.
  const total = 1200
  for (let i = 0; i <= 100; i++) {
    for (const ro of [0, 0.25, 0.5, 0.75, 1]) {
      const fit = fitAlongEdge({ offset: i / 100, length: DOCK }, { offset: ro, length: RAIL }, total, 'bottom')
      if (fit.kind !== 'push') continue
      const start = spanStart(fit.offset, RAIL, total, 'bottom')
      assert.ok(fit.offset >= 0 && fit.offset <= 1, `fração fora de [0,1]: ${fit.offset}`)
      assert.ok(start >= EDGE_PAD - 1e-9, `começou antes da folga: ${start}`)
      assert.ok(start + RAIL <= total - EDGE_PAD + 1e-9, `passou do fim: ${start + RAIL}`)
    }
  }
})

test('empurrar nunca troca uma sobreposição por outra', () => {
  const total = 1200
  for (let i = 0; i <= 200; i++) {
    for (let j = 0; j <= 20; j++) {
      const moved = { offset: i / 200, length: DOCK }
      const other = { offset: j / 20, length: RAIL }
      const fit = fitAlongEdge(moved, other, total, 'bottom')
      if (fit.kind === 'swap') continue
      const o = fit.kind === 'push' ? fit.offset : other.offset
      const a0 = spanStart(moved.offset, DOCK, total, 'bottom')
      const b0 = spanStart(o, RAIL, total, 'bottom')
      assert.ok(
        b0 + RAIL + PILL_GAP <= a0 + 1e-9 || a0 + DOCK + PILL_GAP <= b0 + 1e-9,
        `ainda se cruzam: dock ${a0}..${a0 + DOCK}, rail ${b0}..${b0 + RAIL}`
      )
    }
  }
})

test('borda estreita demais: a saída é a troca de bordas, não o aperto', () => {
  // Uma janela de 700px não comporta uma dock de 600 mais a rail com folga.
  assert.equal(
    fitAlongEdge({ offset: 0.5, length: DOCK }, { offset: 0.5, length: RAIL }, 700, 'bottom').kind,
    'swap'
  )
})

test('cabem somadas, mas não em volta de onde a arrastada parou', () => {
  // 100 + 800 + folga cabem em 1200; com a de 100 no meio, porém, nenhum dos
  // dois vãos comporta a de 800. Aí não há empurrão possível.
  const fit = fitAlongEdge({ offset: 0.5, length: 100 }, { offset: 0.5, length: 800 }, 1200, 'bottom')
  assert.equal(fit.kind, 'swap')
})

// ─── Três pílulas na mesma borda ──────────────────────────────────────────────
//
// `fitAlongEdge` responde por um PAR, e um par de cada vez não basta: empurrar
// a rail para longe da dock pode encostá-la na tira do monitor, e o "ok" do
// primeiro par teria escondido a sobreposição que o segundo criou. `fitAmong`
// acomoda as irmãs em sequência, na ordem fixa dock → rail → monitor.
//
// Três na mesma borda é caso de canto — só acontece se o usuário empilhar as
// três de propósito —, e é exatamente por isso que precisa de teste: ninguém
// vai reproduzir isto com o mouse na frente de quem pode consertar.

const TIRA = 260

/** Os intervalos finais em px, na ordem [arrastada, ...irmãs que ficaram]. */
function spansAfter(moved, others, total, edge) {
  const fits = fitAmong(moved, others, total, edge)
  const spans = [
    {
      nome: 'arrastada',
      start: spanStart(moved.offset, moved.length, total, edge),
      length: moved.length
    }
  ]
  others.forEach((o, i) => {
    const fit = fits[i]
    if (fit.kind === 'swap') return // saiu desta borda: quem decide é resolveCollision
    const offset = fit.kind === 'push' ? fit.offset : o.offset
    spans.push({ nome: `irmã ${i}`, start: spanStart(offset, o.length, total, edge), length: o.length })
  })
  return { fits, spans }
}

/** A invariante: depois de soltar, ninguém se sobrepõe a ninguém. */
function semSobreposicao(spans) {
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]
      const b = spans[j]
      assert.ok(
        b.start + b.length + PILL_GAP <= a.start + 1e-9 ||
          a.start + a.length + PILL_GAP <= b.start + 1e-9,
        `${a.nome} (${a.start}..${a.start + a.length}) e ${b.nome} (${b.start}..${b.start + b.length}) se cruzam`
      )
    }
  }
}

test('as três cabendo na borda: quem já estava longe não se mexe', () => {
  // Uma base de 1600px comporta as três com folga. Empurrar a tira que está no
  // canto oposto seria mexer no que o usuário não pediu.
  const fits = fitAmong(
    { offset: 0.5, length: DOCK },
    [
      { offset: 0.5, length: RAIL },
      { offset: 0.85, length: TIRA }
    ],
    1600,
    'bottom'
  )
  assert.equal(fits[0].kind, 'push', 'a rail estava debaixo da dock e devia sair')
  assert.equal(fits[1].kind, 'ok', 'a tira estava longe e não devia se mexer')
})

test('as três empilhadas no centro: a arrastada fica, as outras acomodam sem cruzar', () => {
  // O caso que o par a par erra: a tira é empurrada para longe da dock e cai
  // em cima da rail, que já tinha sido acomodada. É a segunda volta de
  // `fitAmong` que desfaz isso.
  const moved = { offset: 0.5, length: DOCK }
  const others = [
    { offset: 0.5, length: RAIL },
    { offset: 0.5, length: TIRA }
  ]
  const { fits, spans } = spansAfter(moved, others, 1600, 'bottom')
  assert.deepEqual(
    fits.map((f) => f.kind),
    ['push', 'push']
  )
  assert.equal(spans.length, 3, 'ninguém devia ter precisado trocar de borda')
  semSobreposicao(spans)
})

test('a ordem de resolução é determinística — a escolha fica fixa aqui', () => {
  // Como o empate de canto de `edgeFor`: a outra ordem também funcionaria, e o
  // que não é arbitrário é a escolha estar FIXA. Trocar a ordem das irmãs muda
  // os números, e o teste é quem percebe.
  const total = 1600
  const moved = { offset: 0.5, length: DOCK }
  const others = [
    { offset: 0.5, length: RAIL },
    { offset: 0.5, length: TIRA }
  ]
  const fits = fitAmong(moved, others, total, 'bottom')
  // Dock centrada em 500..1100. A rail sai para o vão da esquerda (empate de
  // distância, e o `before` vence); a tira, empurrada pela dock, cai sobre a
  // rail e recua mais um pouco na segunda volta.
  // Arredondado ao pixel: a fração faz o round-trip por uma divisão, e o que
  // este teste fixa é a ESCOLHA, não o último bit do ponto flutuante.
  assert.equal(Math.round(spanStart(fits[0].offset, RAIL, total, 'bottom')), 442)
  assert.equal(Math.round(spanStart(fits[1].offset, TIRA, total, 'bottom')), 170)
  // E o resultado não muda entre duas chamadas com a mesma entrada.
  assert.deepEqual(fitAmong(moved, others, total, 'bottom'), fits)
})

test('as três sem caber: a arrastada fica e as outras trocam de borda', () => {
  // Uma janela de 700px não comporta a dock de 600 mais nenhuma das outras.
  // Aqui não há empurrão possível, e `swap` é o que devolve a decisão para
  // `resolveCollision` — que é reversível e nunca deixa duas no mesmo lugar.
  const { fits, spans } = spansAfter(
    { offset: 0.5, length: DOCK },
    [
      { offset: 0.5, length: RAIL },
      { offset: 0.5, length: TIRA }
    ],
    700,
    'bottom'
  )
  assert.deepEqual(
    fits.map((f) => f.kind),
    ['swap', 'swap']
  )
  assert.equal(spans.length, 1, 'sobrou alguém apertado na borda em vez de trocar')
})

test('a irmã que não cabe sai, e a que cabe continua na borda', () => {
  // Meio-termo: a rail de 46px ainda encontra vão ao lado da dock, a tira de
  // 260 não. Uma resposta só para as duas seria errada para uma delas.
  const total = 760
  const { fits, spans } = spansAfter(
    { offset: 0, length: 560 },
    [
      { offset: 0.5, length: RAIL },
      { offset: 0.5, length: TIRA }
    ],
    total,
    'bottom'
  )
  assert.equal(fits[1].kind, 'swap', 'a tira não cabia e devia trocar de borda')
  semSobreposicao(spans)
})

test('nenhuma combinação das três deixa duas empilhadas', () => {
  // Varre as três por toda a borda. É a invariante que de fato importa —
  // sobreposição é o único estado quebrado —, e ela vale em qualquer entrada.
  const total = 1600
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 8; j++) {
      for (let k = 0; k <= 8; k++) {
        const { spans } = spansAfter(
          { offset: i / 40, length: DOCK },
          [
            { offset: j / 8, length: RAIL },
            { offset: k / 8, length: TIRA }
          ],
          total,
          'bottom'
        )
        semSobreposicao(spans)
      }
    }
  }
})

test('numa vertical, as três respeitam a faixa reservada do topo', () => {
  const total = 900
  for (let i = 0; i <= 40; i++) {
    const { spans } = spansAfter(
      { offset: i / 40, length: 380 },
      [
        { offset: 0.5, length: RAIL },
        { offset: 0.2, length: 120 }
      ],
      total,
      'left'
    )
    semSobreposicao(spans)
    for (const s of spans) {
      assert.ok(s.start >= EDGE_PAD_TOP - 1e-9, `${s.nome} entrou na faixa do topo: ${s.start}`)
      assert.ok(s.start + s.length <= total - EDGE_PAD + 1e-9, `${s.nome} passou do fim`)
    }
  }
})

// ─── Colisão dock/rail ────────────────────────────────────────────────────────

test('EDGE_PAD, EDGE_PAD_TOP e PILL_GAP são os números que o CSS também usa', () => {
  // Espelham --pill-pad e --pill-safe-top em tokens.css. Mudar um sem o outro
  // desalinha a conta de encaixe da tela em silêncio.
  assert.equal(EDGE_PAD, 18)
  assert.equal(EDGE_PAD_TOP, 48)
  assert.equal(PILL_GAP, 12)
})

// ─── A faixa reservada do topo ────────────────────────────────────────────────
//
// O topo da janela já tem dono: o chip do workspace à esquerda e os controles de
// vista à direita, em `top: 10px` com 28px de altura (e os semáforos do macOS na
// mesma linha). Uma pílula que assenta em 18px cobre os dois.

test('o começo das bordas VERTICAIS desvia da faixa do topo', () => {
  // Uma rail em offset 0 encosta no mesmo canto que o chip do workspace.
  assert.equal(padStart('left'), EDGE_PAD_TOP)
  assert.equal(padStart('right'), EDGE_PAD_TOP)
  assert.equal(spanStart(0, RAIL, 800, 'left'), EDGE_PAD_TOP)
  assert.equal(spanStart(0, RAIL, 800, 'right'), EDGE_PAD_TOP)
})

test('as bordas HORIZONTAIS mantêm a folga comum nas duas pontas', () => {
  // Nelas a pílula desvia pelo outro eixo (o `top` da borda de cima), e apertar
  // o percurso encurtaria o alcance sem resolver nada.
  assert.equal(padStart('top'), EDGE_PAD)
  assert.equal(padStart('bottom'), EDGE_PAD)
  assert.equal(spanStart(0, DOCK, 1200, 'top'), EDGE_PAD)
})

test('o FIM das verticais continua na folga comum — embaixo não há nada', () => {
  assert.equal(spanStart(1, RAIL, 800, 'left'), 800 - EDGE_PAD - RAIL)
})

test('o round-trip vale em cada borda, com a folga que ela tem', () => {
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    for (const o of [0, 0.13, 0.5, 0.87, 1]) {
      const back = offsetForStart(spanStart(o, RAIL, 800, edge), RAIL, 800, edge)
      assert.ok(Math.abs(back - o) < 1e-9, `${edge}/${o} não fez round-trip (deu ${back})`)
    }
  }
})

test('o encaixe numa vertical respeita a faixa: ninguém é empurrado para cima dela', () => {
  const total = 800
  for (let i = 0; i <= 100; i++) {
    const fit = fitAlongEdge(
      { offset: i / 100, length: 380 },
      { offset: 0.5, length: RAIL },
      total,
      'left'
    )
    if (fit.kind !== 'push') continue
    const start = spanStart(fit.offset, RAIL, total, 'left')
    assert.ok(start >= EDGE_PAD_TOP - 1e-9, `entrou na faixa do topo: ${start}`)
    assert.ok(start + RAIL <= total - EDGE_PAD + 1e-9, `passou do fim: ${start + RAIL}`)
  }
})

test('bordas diferentes: ninguém se move além de quem foi arrastado', () => {
  const r = resolveCollision(
    { edge: 'top', offset: 0.5 },
    { edge: 'bottom', offset: 0.5 },
    { edge: 'left', offset: 0.5 }
  )
  assert.deepEqual(r.moved, { edge: 'top', offset: 0.5 })
  assert.deepEqual(r.other, { edge: 'left', offset: 0.5 })
})

test('mesma borda: as duas TROCAM, e a outra herda a borda que a primeira deixou', () => {
  const r = resolveCollision(
    { edge: 'left', offset: 0.42 },
    { edge: 'bottom', offset: 0.5 },
    { edge: 'left', offset: 1 }
  )
  assert.deepEqual(r.moved, { edge: 'left', offset: 0.42 })
  assert.equal(r.other.edge, 'bottom')
  // A posição da outra ao longo da borda NÃO muda: ela não foi tocada, e
  // movê-la além do necessário seria mexer no que o usuário não pediu.
  assert.equal(r.other.offset, 1)
})

test('a troca nunca deixa as duas no mesmo lugar', () => {
  // É o único estado de fato quebrado: duas pílulas sobrepostas.
  for (const moved of PLACEMENTS) {
    for (const other of PLACEMENTS) {
      for (const from of PLACEMENTS) {
        if (samePlacement(from, moved)) continue
        const r = resolveCollision(moved, from, other)
        assert.notEqual(
          r.moved.edge,
          r.other.edge,
          `mesma borda: ${formatPlacement(r.moved)} e ${formatPlacement(r.other)}`
        )
      }
    }
  }
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
