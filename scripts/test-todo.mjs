/**
 * Guarda o quadro de TODO — o formato e as operações, sem UI.
 *
 * O que este arquivo protege não é visível no canvas. Um cartão com status órfão
 * SOME da vista mas continua no arquivo; duas operações concorrentes em cartões
 * diferentes resultam numa apagando a outra; uma ordem fracionária que colapsa
 * empilha todos os cartões no mesmo ponto. Nenhum desses três produz erro — só
 * um quadro errado, que é pior.
 *
 * Uso: node scripts/test-todo.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const home = await mkdtemp(join(tmpdir(), 'atelier-todo-'))
process.env.ATELIER_HOME = home

const outdir = await mkdtemp(join(tmpdir(), 'atelier-todo-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        apply,
        applyOp,
        create,
        itemsIn,
        makeBoard,
        orderBetween,
        parseBoard,
        read,
        resetQueues
      } from './src/main/core/todo/todo-store.ts'
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

const { apply, applyOp, create, itemsIn, makeBoard, orderBetween, parseBoard, read } = await import(
  pathToFileURL(outfile).href
)

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

console.log('\nquadro de TODO\n')

/** Um quadro com os cartões dados, já na coluna pedida. */
function boardWith(...titles) {
  let board = makeBoard('Sprint')
  for (const t of titles) board = applyOp(board, { type: 'add', title: t }).board
  return board
}

// ─── Operações ────────────────────────────────────────────────────────────────

await test('add põe o cartão na primeira coluna e carimba as datas', () => {
  const { board, item } = applyOp(makeBoard('Sprint'), { type: 'add', title: 'Etapa 3' })
  assert.equal(board.items.length, 1)
  assert.equal(item.status, 'todo')
  assert.equal(item.title, 'Etapa 3')
  assert.ok(item.createdAt)
  assert.equal(item.updatedAt, item.createdAt)
  assert.equal(item.doneAt, null, 'nasceu marcado como feito')
})

await test('add com status explícito respeita a coluna pedida', () => {
  const { item } = applyOp(makeBoard('S'), { type: 'add', title: 'X', status: 'doing' })
  assert.equal(item.status, 'doing')
})

await test('add com status inexistente é ERRO que lista os válidos', () => {
  // Silenciosamente cair na primeira coluna faria o agente achar que marcou
  // "fazendo" quando não marcou.
  const r = applyOp(makeBoard('S'), { type: 'add', title: 'X', status: 'fazendo' })
  assert.ok(r.error, 'aceitou um status que não existe')
  assert.match(r.error, /'todo'/)
  assert.match(r.error, /'doing'/)
  assert.equal(r.board.items.length, 0, 'criou o cartão mesmo com erro')
})

await test('move para a última coluna carimba doneAt', () => {
  const b = boardWith('A')
  const id = b.items[0].id
  const { item } = applyOp(b, { type: 'move', id, status: 'done' })
  assert.equal(item.status, 'done')
  assert.ok(item.doneAt, 'chegou em Feito sem doneAt')
})

await test('voltar de Feito LIMPA o doneAt', () => {
  // Um cartão que volta para Fazendo não pode continuar dizendo que terminou.
  let b = boardWith('A')
  const id = b.items[0].id
  b = applyOp(b, { type: 'move', id, status: 'done' }).board
  assert.ok(b.items[0].doneAt)
  const { item } = applyOp(b, { type: 'move', id, status: 'doing' })
  assert.equal(item.doneAt, null)
})

await test('move para status inexistente é erro e não move nada', () => {
  const b = boardWith('A')
  const r = applyOp(b, { type: 'move', id: b.items[0].id, status: 'arquivado' })
  assert.match(r.error, /unknown status/)
  assert.equal(r.board.items[0].status, 'todo')
})

await test('move de um id que não existe é erro', () => {
  const r = applyOp(boardWith('A'), { type: 'move', id: 'nao-existe', status: 'doing' })
  assert.match(r.error, /no item with id/)
})

await test('edit muda só o que foi pedido e atualiza updatedAt', () => {
  const b = boardWith('A')
  b.items[0].updatedAt = '2020-01-01T00:00:00.000Z'
  const { item } = applyOp(b, { type: 'edit', id: b.items[0].id, notes: 'olhar o log' })
  assert.equal(item.title, 'A', 'o título mudou sem ninguém pedir')
  assert.equal(item.notes, 'olhar o log')
  assert.notEqual(item.updatedAt, '2020-01-01T00:00:00.000Z')
})

await test('remove tira o cartão; remover duas vezes é erro', () => {
  const b = boardWith('A', 'B')
  const id = b.items[0].id
  const r1 = applyOp(b, { type: 'remove', id })
  assert.equal(r1.board.items.length, 1)
  assert.match(applyOp(r1.board, { type: 'remove', id }).error, /no item with id/)
})

// ─── Ordem fracionária ────────────────────────────────────────────────────────

await test('orderBetween põe o cartão no meio dos vizinhos', () => {
  assert.equal(orderBetween(1000, 2000), 1500)
  assert.equal(orderBetween(null, 1000), 0)
  assert.equal(orderBetween(3000, null), 4000)
  assert.equal(orderBetween(null, null), 1000)
})

await test('orderBetween DESISTE quando não cabe mais nada entre os dois', () => {
  // É o sinal de reindexar. Sem ele, os cartões colapsariam todos no mesmo
  // ponto e a ordem da coluna viraria a de inserção.
  assert.equal(orderBetween(1000, 1000.5), null)
  assert.equal(orderBetween(1000, 1000), null)
})

await test('mover para o meio não reescreve os vizinhos', () => {
  let b = boardWith('A', 'B', 'C')
  const [a, x, c] = b.items
  const ordemA = a.order
  const ordemC = c.order
  b = applyOp(b, { type: 'move', id: x.id, status: 'todo', before: a.id, after: c.id }).board

  const porId = (id) => b.items.find((i) => i.id === id)
  assert.equal(porId(a.id).order, ordemA, 'o vizinho de cima foi reescrito')
  assert.equal(porId(c.id).order, ordemC, 'o vizinho de baixo foi reescrito')
  assert.ok(porId(x.id).order > ordemA && porId(x.id).order < ordemC)
})

await test('a reindexação dispara quando a distância colapsa', () => {
  let b = boardWith('A', 'B')
  // Encosta os dois primeiros para forçar o caso.
  b.items[0].order = 1000
  b.items[1].order = 1000.4
  b = applyOp(b, { type: 'add', title: 'C' }).board
  const alvo = b.items.find((i) => i.title === 'C')
  b = applyOp(b, {
    type: 'move',
    id: alvo.id,
    status: 'todo',
    before: b.items[0].id,
    after: b.items[1].id
  }).board

  const ordens = itemsIn(b, 'todo').map((i) => i.order)
  const unicos = new Set(ordens)
  assert.equal(unicos.size, ordens.length, `dois cartões na mesma posição: ${ordens}`)
  for (let n = 1; n < ordens.length; n++) {
    assert.ok(ordens[n] > ordens[n - 1], `a ordem não é crescente: ${ordens}`)
  }
})

// ─── Colunas ──────────────────────────────────────────────────────────────────

await test('status órfão cai na primeira coluna e NÃO some da vista', () => {
  // Sumir seria o pior resultado: o cartão continuaria no arquivo e ninguém o
  // veria para consertá-lo.
  const raw = JSON.stringify({
    version: 1,
    title: 'S',
    columns: [{ id: 'todo', title: 'A fazer' }],
    items: [{ id: 'x', title: 'Perdido', status: 'coluna-apagada', order: 1000 }]
  })
  const board = parseBoard(raw)
  assert.equal(board.items.length, 1, 'o cartão sumiu')
  assert.equal(board.items[0].status, 'todo')
})

await test('apagar uma coluna leva os cartões dela para a primeira', () => {
  let b = boardWith('A')
  b = applyOp(b, { type: 'move', id: b.items[0].id, status: 'doing' }).board
  const r = applyOp(b, {
    type: 'columns',
    columns: [{ id: 'todo', title: 'A fazer' }, { id: 'done', title: 'Feito' }]
  })
  assert.equal(r.board.items[0].status, 'todo')
})

await test('um quadro sem coluna nenhuma é recusado', () => {
  // Sem coluna, nenhum cartão teria onde existir.
  assert.match(applyOp(makeBoard('S'), { type: 'columns', columns: [] }).error, /at least one/)
})

await test('quadro sem colunas no arquivo cai nas três padrão', () => {
  const board = parseBoard(JSON.stringify({ version: 1, title: 'S', columns: [], items: [] }))
  assert.equal(board.columns.length, 3)
})

// ─── Leitura defensiva ────────────────────────────────────────────────────────

await test('arquivo corrompido devolve null — e o nó avisa em vez de sobrescrever', () => {
  assert.equal(parseBoard('{ não sou json'), null)
  assert.equal(parseBoard('[1,2,3]'), null)
  assert.equal(parseBoard(''), null)
})

await test('campos com tipo errado não viram NaN nem undefined', () => {
  const board = parseBoard(
    JSON.stringify({
      columns: [{ id: 'todo', title: 'A fazer' }],
      items: [
        { id: 'a', title: 'ok', status: 'todo', order: 'muito', tags: ['x', 3], notes: null }
      ]
    })
  )
  assert.equal(typeof board.items[0].order, 'number')
  assert.ok(Number.isFinite(board.items[0].order))
  assert.deepEqual(board.items[0].tags, ['x'])
  assert.equal(board.items[0].notes, '')
})

await test('item sem título ganha nome em vez de sumir', () => {
  // Descartar seria perder o TODO de alguém em silêncio: o cartão continuaria no
  // arquivo e ninguém o veria para renomeá-lo. Mesma regra do status órfão.
  const board = parseBoard(
    JSON.stringify({ columns: [{ id: 'todo', title: 'T' }], items: [{ id: 'a', status: 'todo' }] })
  )
  assert.equal(board.items.length, 1)
  assert.equal(board.items[0].title, 'Tarefa sem título')
})

// ─── Migração para Tarefas ───────────────────────────────────────────────────

await test('quadro ANTIGO carrega sem perder nenhum TODO, e todos viram manuais', () => {
  // Origem manual é EXPLÍCITA, e não ausência de origem: é isso que distingue
  // "criado à mão" de "arquivo de antes desta feature".
  const antigo = JSON.stringify({
    version: 1,
    title: 'Sprint de março',
    columns: [
      { id: 'todo', title: 'A fazer' },
      { id: 'doing', title: 'Fazendo' },
      { id: 'done', title: 'Feito' }
    ],
    items: [
      {
        id: 'A',
        title: 'Corrigir importação',
        status: 'doing',
        order: 1000,
        assignee: 'Rita',
        notes: 'olhar o log',
        tags: ['bug'],
        createdAt: '2026-03-01T10:00:00Z',
        updatedAt: '2026-03-02T10:00:00Z'
      },
      { id: 'B', title: 'Publicar', status: 'done', order: 2000, doneAt: '2026-03-03T10:00:00Z' }
    ]
  })
  const board = parseBoard(antigo)
  assert.equal(board.items.length, 2, 'a migração perdeu um cartão')

  const a = board.items[0]
  assert.equal(a.assignee, 'Rita', 'o responsável se perdeu na migração')
  assert.deepEqual(a.tags, ['bug'])
  assert.equal(a.notes, 'olhar o log')
  assert.equal(a.order, 1000)
  assert.equal(board.items[1].doneAt, '2026-03-03T10:00:00Z')

  assert.equal(a.origin.type, 'manual')
  assert.equal(a.origin.importedAt, '2026-03-01T10:00:00Z', 'inventou "importado hoje"')
  assert.equal(a.activePlanId, null, 'cartão sem plano nasceu apontando para um')
})

await test('origem externa sobrevive à leitura, com metadata desconhecida e tudo', () => {
  const board = parseBoard(
    JSON.stringify({
      columns: [{ id: 'todo', title: 'A fazer' }],
      items: [
        {
          id: 'A',
          title: 'Ticket',
          status: 'todo',
          origin: {
            type: 'jira',
            externalId: 'PROJ-123',
            externalUrl: 'https://jira.example.com/browse/PROJ-123',
            sourceName: 'Plataforma',
            importedAt: '2026-08-29T10:00:00Z',
            metadata: { sprint: 7, campoQueNinguemConhece: { fundo: true } }
          },
          activePlanId: 'PLANO-1'
        }
      ]
    })
  )
  const origem = board.items[0].origin
  assert.equal(origem.type, 'jira')
  assert.equal(origem.externalId, 'PROJ-123')
  assert.equal(origem.metadata.campoQueNinguemConhece.fundo, true)
  assert.equal(board.items[0].activePlanId, 'PLANO-1')
})

await test('origem com lixo no lugar do objeto não derruba a leitura', () => {
  const board = parseBoard(
    JSON.stringify({
      columns: [{ id: 'todo', title: 'A fazer' }],
      items: [
        { id: 'A', title: 'X', status: 'todo', origin: 'jira', activePlanId: 42 },
        { id: 'B', title: 'Y', status: 'todo', origin: { type: 'jira', externalId: 7 } }
      ]
    })
  )
  assert.equal(board.items[0].origin.type, 'manual')
  assert.equal(board.items[0].activePlanId, null)
  assert.equal(board.items[1].origin.type, 'jira')
  assert.equal(board.items[1].origin.externalId, null, 'um número virou id externo')
})

await test('add carimba origem manual, e as operações NÃO derrubam os campos novos', () => {
  // O CLI e o painel aplicam operações sobre o quadro inteiro; um `move` que
  // esquecesse `origin` apagaria a procedência do cartão em silêncio.
  let b = makeBoard('S')
  b = applyOp(b, { type: 'add', title: 'A' }).board
  assert.equal(b.items[0].origin.type, 'manual')
  assert.equal(b.items[0].activePlanId, null)

  const jira = {
    type: 'jira',
    externalId: 'PROJ-9',
    externalUrl: 'https://jira.example.com/browse/PROJ-9',
    sourceName: null,
    importedAt: null,
    metadata: null
  }
  b = applyOp(b, { type: 'origin', id: b.items[0].id, origin: jira }).board
  b = applyOp(b, { type: 'plan', id: b.items[0].id, planId: 'PLANO-1' }).board
  b = applyOp(b, { type: 'move', id: b.items[0].id, status: 'doing' }).board
  b = applyOp(b, { type: 'edit', id: b.items[0].id, notes: 'nota' }).board
  b = applyOp(b, { type: 'columns', columns: [{ id: 'todo', title: 'A fazer' }] }).board

  assert.equal(b.items[0].origin.externalId, 'PROJ-9', 'a origem se perdeu numa operação')
  assert.equal(b.items[0].activePlanId, 'PLANO-1', 'o ponteiro do plano se perdeu')
})

await test('desanexar a origem devolve o cartão à condição de manual', () => {
  let b = applyOp(makeBoard('S'), { type: 'add', title: 'A' }).board
  b = applyOp(b, { type: 'origin', id: b.items[0].id, origin: { type: 'slack' } }).board
  assert.equal(b.items[0].origin.type, 'slack')
  b = applyOp(b, { type: 'origin', id: b.items[0].id, origin: null }).board
  assert.equal(b.items[0].origin.type, 'manual', 'ficou sem origem nenhuma')
})

// ─── Concorrência: o ponto inteiro do módulo ─────────────────────────────────

await test('duas operações concorrentes em cartões diferentes SOBREVIVEM as duas', async () => {
  // É o caso normal num canvas multi-agente. Sem a fila, os dois leriam o mesmo
  // quadro e o segundo gravaria por cima do primeiro.
  const file = join(home, 'concorrente.json')
  await create(file, 'Sprint')

  await Promise.all([
    apply(file, { type: 'add', title: 'do agente A' }),
    apply(file, { type: 'add', title: 'do agente B' })
  ])

  const board = await read(file)
  const titulos = board.items.map((i) => i.title).sort()
  assert.deepEqual(titulos, ['do agente A', 'do agente B'], 'uma das duas escritas se perdeu')
})

await test('dez escritas concorrentes não perdem nenhuma', async () => {
  const file = join(home, 'dez.json')
  await create(file, 'Sprint')
  await Promise.all(
    Array.from({ length: 10 }, (_, n) => apply(file, { type: 'add', title: `item ${n}` }))
  )
  const board = await read(file)
  assert.equal(board.items.length, 10)
})

await test('uma operação que FALHA não trava a fila daquele arquivo', async () => {
  const file = join(home, 'fila.json')
  await create(file, 'Sprint')
  const ruim = apply(file, { type: 'move', id: 'nao-existe', status: 'doing' })
  const bom = apply(file, { type: 'add', title: 'depois do erro' })
  await ruim
  const r = await bom
  assert.ok(!r.error, `a operação seguinte falhou: ${r.error}`)
  assert.equal((await read(file)).items.length, 1)
})

// ─── Disco ────────────────────────────────────────────────────────────────────

await test('a gravação é atômica — nenhum .tmp fica para trás', async () => {
  const file = join(home, 'atomico.json')
  await create(file, 'Sprint')
  await apply(file, { type: 'add', title: 'A' })
  await readFile(file, 'utf8')
  await assert.rejects(() => readFile(`${file}.tmp`, 'utf8'))
})

await test('arquivo corrompido RECUSA a operação em vez de sobrescrever', async () => {
  // O arquivo pode ser o trabalho de alguém; um `add` não é motivo para
  // descartá-lo. Mesmo pudor do modo seguro do workspace.
  const file = join(home, 'corrompido.json')
  await writeFile(file, '{ pela metade', 'utf8')
  const r = await apply(file, { type: 'add', title: 'X' })
  assert.match(r.error, /corrupt/)
  assert.equal(await readFile(file, 'utf8'), '{ pela metade', 'o arquivo foi sobrescrito')
})

await test('arquivo que ainda não existe abre como quadro vazio, e não como erro', async () => {
  const board = await read(join(home, 'nunca-gravado.json'))
  assert.ok(board)
  assert.equal(board.items.length, 0)
  assert.equal(board.columns.length, 3)
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
