/**
 * Guarda a UI do nó Tarefas — o que a tela DIZ.
 *
 * As regras do domínio já têm dono em `test-plans.mjs`. O que morre em silêncio
 * é a distância entre elas e o pixel: um progresso lido de um campo guardado em
 * vez de derivado, um `externalUrl` de terceiro virando `<a href>` sem passar
 * pelo filtro, um histórico ordenado crescente que faz a versão atual sumir no
 * fim da lista, um plano inconsistente que continua oferecendo edição. Nenhum
 * dos quatro produz erro — só uma tela mentindo.
 *
 * Por isso os componentes de `panels/task-plan.tsx` não tocam store nem IPC:
 * são funções de props, e dá para renderizá-las com `react-dom/server` e ler o
 * HTML resultante, sem navegador e sem mock de janela.
 *
 * Uso: node scripts/test-task-ui.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-task-ui-'))
const outfile = join(outdir, 'ui.mjs')

// React entra no BUNDLE, e não fica externo: o artefato é gravado num diretório
// temporário, onde a resolução de `node_modules` do projeto não alcança.
await esbuild.build({
  stdin: {
    contents: `
      export { createElement } from 'react'
      export { renderToStaticMarkup } from 'react-dom/server'
      export {
        hasOpenSteps,
        planView,
        priorityOf,
        TaskDecision,
        TaskDetail,
        TaskSummary
      } from './src/renderer/panels/task-plan.tsx'
      export { applyPlanOp, makeBook } from './src/main/core/todo/plan-store.ts'
      export { applyOp, makeBoard } from './src/main/core/todo/todo-store.ts'
      export { columnKinds, planSnapshot, TASK_STATUS_LABELS } from './src/shared/task-status.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['electron'],
  // O renderizador de servidor do React é CJS e pede `stream` em tempo de
  // execução. Num bundle ESM o `require` não existe, e o shim do esbuild lança
  // antes de qualquer teste rodar; devolver um `require` de verdade resolve.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const {
  createElement: h,
  renderToStaticMarkup,
  hasOpenSteps,
  planView,
  priorityOf,
  TaskDecision,
  TaskDetail,
  TaskSummary,
  applyPlanOp,
  makeBook,
  applyOp,
  makeBoard,
  columnKinds,
  planSnapshot,
  TASK_STATUS_LABELS
} = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}

const html = (element) => renderToStaticMarkup(element)

// ─── Fábricas ────────────────────────────────────────────────────────────────

function card(over = {}) {
  return {
    id: 'T1',
    title: 'Corrigir importação de tickets',
    status: 'doing',
    order: 1000,
    assignee: '',
    notes: '',
    tags: [],
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    doneAt: null,
    origin: { type: 'manual', externalId: null, externalUrl: null, sourceName: null, importedAt: null, metadata: null },
    activePlanId: null,
    ...over
  }
}

/** Um livro com um plano de `steps` etapas, já apontado pelo cartão. */
function withPlan(item, steps, over = {}) {
  const r = applyPlanOp(makeBook(), {
    type: 'create',
    taskId: item.id,
    title: 'Plano de correção',
    status: 'active',
    content: { steps: steps.map((title, n) => ({ id: `s${n + 1}`, title, description: null, status: 'pending', order: n + 1 })) },
    ...over
  })
  return { book: r.book, plan: r.plan, item: { ...item, activePlanId: r.plan.id } }
}

const COLUMNS = [
  { id: 'todo', title: 'A fazer' },
  { id: 'doing', title: 'Fazendo' },
  { id: 'done', title: 'Feito' }
]
const KINDS = columnKinds(COLUMNS)
const labelOf = (status) => TASK_STATUS_LABELS[KINDS[status]]

const detail = (item, book, over = {}) => {
  const view = planView(book, item)
  return h(TaskDetail, {
    item,
    statusLabel: labelOf(item.status),
    plan: view.plan,
    version: view.version,
    versions: view.versions,
    events: view.events,
    snapshot: view.snapshot,
    onAddPlan: () => {},
    onStepStatus: () => {},
    onClose: () => {},
    ...over
  })
}

// ─── O nó se chama Tarefas ───────────────────────────────────────────────────

console.log('\nlinguagem')

await test('o nó aparece como Tarefas, e nenhum rótulo visível diz TODO', async () => {
  // Rótulo é o que o usuário lê: o texto da dock e o título padrão do nó. Os
  // nomes internos (`kind: 'todo'`, `todo-panel.tsx`) continuam em inglês de
  // propósito — o plano só exige português no produto.
  const dock = await readFile(join(ROOT, 'src/renderer/dock.tsx'), 'utf8')
  assert.match(dock, /label="Tarefas"/)
  assert.match(dock, /title: 'Tarefas'/)
  const node = await readFile(join(ROOT, 'src/renderer/nodes/widget-node.tsx'), 'utf8')
  assert.match(node, /content\.view\.title \|\| 'Tarefas'/)

  const panel = await readFile(join(ROOT, 'src/renderer/panels/todo-panel.tsx'), 'utf8')
  for (const visivel of panel.match(/(?:placeholder|title)="([^"]*)"/g) ?? []) {
    assert.doesNotMatch(visivel, /TODO/i, `rótulo visível ainda diz TODO: ${visivel}`)
  }
})

await test('os textos de status aparecem em português', () => {
  const out = html(h(TaskSummary, { item: card(), statusLabel: labelOf('doing'), snapshot: null }))
  assert.match(out, /Em andamento/)
  assert.equal(labelOf('todo'), 'Pendente')
  assert.equal(labelOf('done'), 'Concluída')
})

// ─── Resumo compacto ─────────────────────────────────────────────────────────

console.log('\nresumo do cartão')

await test('origem Jira aparece no resumo, com a chave do issue', () => {
  const item = card({ origin: { type: 'jira', externalId: 'PROJ-123', externalUrl: null, sourceName: 'Atelier', importedAt: null, metadata: null } })
  assert.match(html(h(TaskSummary, { item, statusLabel: labelOf('doing'), snapshot: null })), /Jira · PROJ-123/)
})

await test('origem Slack incompleta mostra só o provedor', () => {
  // Sem id e sem nome, o provedor é a única parte confiável do que o adaptador
  // mandou — inventar o resto seria mostrar dado que não existe.
  const item = card({ origin: { type: 'slack', externalId: null, externalUrl: null, sourceName: null, importedAt: null, metadata: null } })
  const out = html(h(TaskSummary, { item, statusLabel: labelOf('doing'), snapshot: null }))
  assert.match(out, /Slack/)
  assert.doesNotMatch(out, /·/)
})

await test('origem manual NÃO aparece no resumo', () => {
  const out = html(h(TaskSummary, { item: card(), statusLabel: labelOf('doing'), snapshot: null }))
  assert.doesNotMatch(out, /Manual/)
})

await test('prioridade sai da tag, e some quando não há tag', () => {
  assert.equal(priorityOf(card({ tags: ['backend', 'urgente'] })), 'Urgente')
  assert.equal(priorityOf(card({ tags: ['backend'] })), null)
  assert.match(
    html(h(TaskSummary, { item: card({ tags: ['alta'] }), statusLabel: labelOf('doing'), snapshot: null })),
    /Alta/
  )
})

await test('o resumo mostra o progresso do Plano — 3 etapas, 1 feita, 33%', () => {
  const w = withPlan(card(), ['a', 'b', 'c'])
  const marcado = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'done' })
  const view = planView(marcado.book, w.item)
  assert.match(
    html(h(TaskSummary, { item: w.item, statusLabel: labelOf('doing'), snapshot: view.snapshot })),
    /Plano 33%/
  )
})

await test('o progresso ATUALIZA ao concluir outra etapa — e é sempre derivado', () => {
  const w = withPlan(card(), ['a', 'b', 'c'])
  let book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'done' }).book
  book = applyPlanOp(book, { type: 'step', planId: w.plan.id, stepId: 's2', status: 'done' }).book
  const view = planView(book, w.item)
  assert.equal(view.snapshot.progressPercent, 66)
  assert.match(
    html(h(TaskSummary, { item: w.item, statusLabel: labelOf('doing'), snapshot: view.snapshot })),
    /Plano 66%/
  )
  // Nenhuma versão nova nasceu de marcar etapa: o histórico é de decisões, e
  // clicar numa caixa não é uma delas.
  assert.equal(view.versions.length, 1)
})

await test('cartão sem plano não mostra pílula de Plano', () => {
  assert.doesNotMatch(
    html(h(TaskSummary, { item: card(), statusLabel: labelOf('doing'), snapshot: null })),
    /Plano/
  )
})

// ─── Adicionar plano ─────────────────────────────────────────────────────────

console.log('\nadicionar plano')

await test('"Adicionar plano" só aparece quando a Tarefa não tem Plano', () => {
  const semPlano = html(detail(card(), makeBook()))
  assert.match(semPlano, /Adicionar plano/)
  const w = withPlan(card(), ['a'])
  assert.doesNotMatch(html(detail(w.item, w.book)), /Adicionar plano/)
})

await test('o botão cria o Plano na Tarefa CERTA, com a versão 1 e o evento', () => {
  // Reproduz o gesto inteiro de `addPlan`: cria o plano e aponta o cartão.
  let board = makeBoard('Tarefas')
  board = applyOp(board, { type: 'add', title: 'primeira' }).board
  board = applyOp(board, { type: 'add', title: 'segunda' }).board
  const [a, b] = board.items

  const criado = applyPlanOp(makeBook(), { type: 'create', taskId: b.id, title: b.title, status: 'active' })
  board = applyOp(board, { type: 'plan', id: b.id, planId: criado.plan.id }).board

  const [depoisA, depoisB] = board.items
  assert.equal(depoisA.activePlanId, null, 'o plano caiu no cartão errado')
  assert.equal(depoisB.activePlanId, criado.plan.id)
  assert.equal(criado.version.versionNumber, 1)
  assert.ok(criado.book.events.some((e) => e.type === 'plan_created' && e.taskId === b.id))

  assert.match(html(detail(depoisB, criado.book)), /Plano criado/)
})

// ─── Painel expandido ────────────────────────────────────────────────────────

console.log('\npainel expandido')

await test('o histórico mostra as versões em ordem DECRESCENTE', () => {
  const w = withPlan(card(), ['a'])
  let book = applyPlanOp(w.book, { type: 'revise', planId: w.plan.id, content: { steps: [{ id: 's1', title: 'a' }, { id: 's2', title: 'b' }] }, changeSummary: 'segunda' }).book
  book = applyPlanOp(book, { type: 'revise', planId: w.plan.id, content: { steps: [{ id: 's1', title: 'a' }, { id: 's2', title: 'b' }, { id: 's3', title: 'c' }] }, changeSummary: 'terceira' }).book

  const view = planView(book, w.item)
  assert.deepEqual(view.versions.map((v) => v.versionNumber), [3, 2, 1])

  const out = html(detail(w.item, book))
  const ordem = [...out.matchAll(/task-version-n">v(\d)/g)].map((m) => m[1])
  assert.deepEqual(ordem, ['3', '2', '1'], 'a versão atual não está no topo')
  // E a atual é a marcada: é ela que o olho procura na lista.
  assert.match(out, /task-version is-current"><span class="task-version-n">v3/)
})

await test('a timeline mostra os eventos, do mais novo para o mais velho', () => {
  const w = withPlan(card(), ['a', 'b'])
  const book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'blocked' }).book
  const out = html(detail(w.item, book))
  const eventos = [...out.matchAll(/task-event-what">([^<]+)/g)].map((m) => m[1])
  assert.equal(eventos[0], 'Etapa bloqueada')
  assert.ok(eventos.includes('Plano criado'))
})

await test('as etapas aparecem com status próprio, em português', () => {
  const w = withPlan(card(), ['levantar', 'corrigir'])
  const book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'in_progress' }).book
  const out = html(detail(w.item, book))
  assert.match(out, /task-step is-in_progress/)
  assert.match(out, /task-step is-pending/)
  assert.match(out, /Em andamento/)
})

await test('etapa bloqueada aparece de forma VISÍVEL — pílula e aviso', () => {
  const w = withPlan(card(), ['a', 'b'])
  const book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's2', status: 'blocked' }).book
  const view = planView(book, w.item)
  assert.equal(view.snapshot.blockedSteps, 1)
  assert.match(
    html(h(TaskSummary, { item: w.item, statusLabel: labelOf('doing'), snapshot: view.snapshot })),
    /task-chip is-blocked/
  )
  assert.match(html(detail(w.item, book)), /1 etapa\(s\) bloqueada\(s\)/)
})

await test('a Tarefa antiga, sem origem e sem plano, continua abrindo', () => {
  // É o cartão de um workspace anterior a esta feature, lido antes da migração.
  const antigo = { ...card(), origin: null, activePlanId: null }
  const out = html(detail(antigo, null))
  assert.match(out, /Corrigir importação de tickets/)
  assert.match(out, /ainda não tem Plano/)
})

// ─── Dado de terceiro ────────────────────────────────────────────────────────

console.log('\norigem externa')

const origem = (over) => ({
  type: 'jira',
  externalId: 'PROJ-9',
  externalUrl: null,
  sourceName: 'Atelier',
  importedAt: null,
  metadata: null,
  ...over
})

await test('URL http vira link', () => {
  const item = card({ origin: origem({ externalUrl: 'https://jira.example.com/browse/PROJ-9' }) })
  assert.match(html(detail(item, null)), /<a class="task-origin-link" href="https:\/\/jira\.example\.com\/browse\/PROJ-9"/)
})

await test('URL insegura NÃO vira link — aparece como texto', () => {
  // `javascript:` num link do canvas é execução de código de terceiro dentro do
  // app. Reprovado, o endereço continua legível; só não é clicável.
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>oi</b>', 'nao-e-url']) {
    const item = card({ origin: origem({ externalUrl: url }) })
    const out = html(detail(item, null))
    assert.doesNotMatch(out, /<a /, `virou link: ${url}`)
    assert.match(out, /task-origin-unsafe/, `sumiu da tela: ${url}`)
  }
})

await test('campos desconhecidos em metadata não quebram a leitura, e o gigante é truncado', () => {
  const item = card({
    origin: origem({
      metadata: { campoQueNinguemConhece: 'ok', descricao: 'x'.repeat(5000), aninhado: { a: 1 } }
    })
  })
  const out = html(detail(item, null))
  assert.match(out, /campoQueNinguemConhece/)
  assert.match(out, /aninhado/)
  assert.ok(!out.includes('x'.repeat(300)), 'o valor gigante entrou inteiro na tela')
  assert.match(out, /…/)
})

await test('origem externa não mexe no status: quem manda é a coluna', () => {
  const item = card({ status: 'todo', origin: origem({ metadata: { status: 'Done' } }) })
  const out = html(h(TaskSummary, { item, statusLabel: labelOf(item.status), snapshot: null }))
  assert.match(out, /Pendente/)
  assert.doesNotMatch(out, /Concluída/)
})

// ─── Plano inconsistente ─────────────────────────────────────────────────────

console.log('\nplano inconsistente')

await test('plano sem versão atual avisa e PERDE a edição de etapas', () => {
  const w = withPlan(card(), ['a', 'b'])
  // O arquivo foi mexido à mão e o ponteiro ficou órfão — é o que `parseBook`
  // lê como `currentVersionId: null`, sem reapontar nada sozinho.
  const quebrado = { ...w.book, plans: [{ ...w.plan, currentVersionId: null }] }
  const out = html(detail(w.item, quebrado))
  assert.match(out, /Plano inconsistente/)
  assert.doesNotMatch(out, /<select/, 'a edição destrutiva continuou disponível')
  assert.match(out, /task-version/, 'o histórico sumiu junto — ele é o que se vai consertar')
})

await test('o resumo de um plano inconsistente mostra "Plano —", e não 0%', () => {
  const w = withPlan(card(), ['a'])
  const quebrado = { ...w.book, plans: [{ ...w.plan, currentVersionId: null }] }
  const view = planView(quebrado, w.item)
  assert.match(
    html(h(TaskSummary, { item: w.item, statusLabel: labelOf('doing'), snapshot: view.snapshot })),
    /Plano —/
  )
})

// ─── A decisão explícita ─────────────────────────────────────────────────────

console.log('\nconcluir com etapas em aberto')

await test('etapa pulada NÃO conta como em aberto', () => {
  const w = withPlan(card(), ['a', 'b'])
  let book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'done' }).book
  assert.equal(hasOpenSteps(planView(book, w.item).snapshot), true)
  book = applyPlanOp(book, { type: 'step', planId: w.plan.id, stepId: 's2', status: 'skipped' }).book
  assert.equal(hasOpenSteps(planView(book, w.item).snapshot), false)
})

await test('plano sem etapas não dispara a pergunta', () => {
  const w = withPlan(card(), [])
  assert.equal(hasOpenSteps(planView(w.book, w.item).snapshot), false)
})

await test('a decisão diz quantas etapas ficam em aberto, e não oferece concluir o Plano', () => {
  const w = withPlan(card(), ['a', 'b', 'c'])
  const book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'done' }).book
  const out = html(
    h(TaskDecision, {
      title: w.item.title,
      snapshot: planView(book, w.item).snapshot,
      onFinish: () => {},
      onPause: () => {},
      onCancel: () => {}
    })
  )
  assert.match(out, /2 etapa\(s\) em aberto/)
  assert.match(out, /Concluir assim mesmo/)
  assert.match(out, /Concluir e pausar o Plano/)
  // Marcar como concluído um plano com etapas abertas seria gravar uma mentira.
  assert.doesNotMatch(out, /Concluir o Plano/)
})

await test('a pergunta só existe na ENTRADA da coluna de concluídos', () => {
  // A regra que `moveTo` aplica: sair de "Feito" nunca pergunta nada.
  const w = withPlan(card({ status: 'done' }), ['a'])
  const snapshot = planView(w.book, w.item).snapshot
  const pergunta = (de, para) =>
    KINDS[para] === 'done' && KINDS[de] !== 'done' && hasOpenSteps(snapshot)
  assert.equal(pergunta('doing', 'done'), true)
  assert.equal(pergunta('done', 'todo'), false)
  assert.equal(pergunta('done', 'done'), false)
  assert.equal(pergunta('todo', 'doing'), false)
})

// ─── Progresso derivado, nunca guardado ──────────────────────────────────────

console.log('\nprogresso')

await test('o snapshot é recalculado, e nada do que a tela mostra vem do arquivo', () => {
  const w = withPlan(card(), ['a', 'b', 'c', 'd'])
  const book = applyPlanOp(w.book, { type: 'step', planId: w.plan.id, stepId: 's1', status: 'done' }).book
  const gravado = JSON.parse(JSON.stringify(book))
  assert.ok(
    !JSON.stringify(gravado).includes('progressPercent'),
    'o percentual foi persistido — a verdade passa a morar em dois lugares'
  )
  assert.equal(planSnapshot(book.plans[0], book.versions[0]).progressPercent, 25)
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
