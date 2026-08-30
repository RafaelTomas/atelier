/**
 * Guarda os Planos — versionamento, progresso derivado e leitura defensiva.
 *
 * O que este arquivo protege é invisível na tela até doer. Uma versão que deixa
 * de ser imutável apaga a decisão anterior do usuário sem aviso; um `skipped`
 * contado como feito mostra 100% num plano abandonado pela metade; um
 * `currentVersionId` reapontado "para ajudar" escolhe por conta própria qual
 * versão era a atual. Nenhum dos três produz erro — só um plano mentindo, que é
 * pior.
 *
 * Uso: node scripts/test-plans.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const home = await mkdtemp(join(tmpdir(), 'atelier-plans-'))
process.env.ATELIER_HOME = home

const outdir = await mkdtemp(join(tmpdir(), 'atelier-plans-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        apply,
        applyPlanOp,
        currentVersion,
        emptyContent,
        eventsOf,
        makeBook,
        parseBook,
        planForTask,
        read,
        versionsOf
      } from './src/main/core/todo/plan-store.ts'
      export {
        columnKind,
        columnKinds,
        isBlocked,
        isFinished,
        manualOrigin,
        metadataForDisplay,
        normalizeOrigin,
        originSummary,
        planSnapshot,
        safeExternalUrl,
        stepStatus,
        PLAN_STATUS_LABELS,
        PLAN_STEP_STATUS_LABELS,
        TASK_STATUS_LABELS
      } from './src/shared/task-status.ts'
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

const {
  apply,
  applyPlanOp,
  currentVersion,
  eventsOf,
  makeBook,
  parseBook,
  planForTask,
  read,
  versionsOf,
  columnKind,
  columnKinds,
  isBlocked,
  isFinished,
  manualOrigin,
  metadataForDisplay,
  normalizeOrigin,
  originSummary,
  planSnapshot,
  safeExternalUrl,
  stepStatus,
  PLAN_STATUS_LABELS,
  PLAN_STEP_STATUS_LABELS,
  TASK_STATUS_LABELS
} = await import(pathToFileURL(outfile).href)

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

console.log('\nplanos de tarefa\n')

/** Um livro com um plano de N etapas, já ativo. */
function bookWith(...titles) {
  const r = applyPlanOp(makeBook(), {
    type: 'create',
    taskId: 'TAREFA-1',
    title: 'Plano de importação',
    objective: 'Trazer os tickets sem perder nada',
    status: 'active',
    content: { steps: titles.map((t) => ({ id: '', title: t, description: null, status: 'pending', order: 0 })) }
  })
  return { book: r.book, plan: r.plan, version: r.version }
}

// ─── Criação e versionamento ─────────────────────────────────────────────────

await test('plano criado já nasce com a versão 1 — plano sem versão é inconsistente', () => {
  const { book, plan, version } = bookWith('A', 'B')
  assert.equal(version.versionNumber, 1)
  assert.equal(plan.currentVersionId, version.id)
  assert.equal(versionsOf(book, plan.id).length, 1)
})

await test('a criação registra plan_created e plan_version_created', () => {
  const { book, plan } = bookWith('A')
  const tipos = eventsOf(book, plan.id).map((e) => e.type)
  assert.ok(tipos.includes('plan_created'))
  assert.ok(tipos.includes('plan_version_created'))
})

await test('duas tarefas não compartilham plano, e a mesma tarefa não ganha dois', () => {
  const { book } = bookWith('A')
  const r = applyPlanOp(book, { type: 'create', taskId: 'TAREFA-1', title: 'Outro' })
  assert.match(r.error, /already has a plan/)
  assert.equal(r.book.plans.length, 1)
})

await test('editar a ESTRUTURA cria versão nova e preserva a anterior', () => {
  const { book, plan, version } = bookWith('A', 'B')
  const r = applyPlanOp(book, {
    type: 'revise',
    planId: plan.id,
    content: { steps: [{ id: '', title: 'A', description: null, status: 'pending', order: 1 }] },
    changeSummary: 'cortei a etapa B'
  })
  assert.equal(r.version.versionNumber, 2)
  assert.equal(r.plan.currentVersionId, r.version.id)
  const antiga = versionsOf(r.book, plan.id).find((v) => v.id === version.id)
  assert.equal(antiga.content.steps.length, 2, 'a versão 1 foi reescrita — ela é imutável')
})

await test('mudar título ou objetivo também é estrutural', () => {
  const { book, plan } = bookWith('A')
  const r = applyPlanOp(book, { type: 'revise', planId: plan.id, title: 'Outro nome' })
  assert.equal(r.version.versionNumber, 2)
  assert.equal(r.plan.title, 'Outro nome')
})

await test('salvar o MESMO conteúdo não cria versão duplicada', () => {
  // Salvar duas vezes o mesmo texto não é uma decisão nova; virar versão encheria
  // o histórico de ruído e esconderia as mudanças de verdade.
  const { book, plan, version } = bookWith('A', 'B')
  const r = applyPlanOp(book, {
    type: 'revise',
    planId: plan.id,
    content: { steps: version.content.steps }
  })
  assert.equal(versionsOf(r.book, plan.id).length, 1)
})

await test('marcar etapa NÃO cria versão — só evento', () => {
  const { book, plan, version } = bookWith('A', 'B')
  const r = applyPlanOp(book, {
    type: 'step',
    planId: plan.id,
    stepId: version.content.steps[0].id,
    status: 'done'
  })
  assert.equal(versionsOf(r.book, plan.id).length, 1, 'um clique em checkbox virou versão')
  assert.equal(r.version.content.steps[0].status, 'pending', 'a versão imutável foi tocada')
  assert.equal(r.plan.stepStatus[version.content.steps[0].id], 'done')
  assert.ok(eventsOf(r.book, plan.id).some((e) => e.type === 'step_completed'))
})

await test('o estado atual NÃO depende dos eventos', () => {
  // Eventos alimentam timeline e auditoria. Reconstruir estado por replay faria
  // um log truncado apagar o trabalho do usuário.
  const { book, plan, version } = bookWith('A')
  const r = applyPlanOp(book, {
    type: 'step',
    planId: plan.id,
    stepId: version.content.steps[0].id,
    status: 'done'
  })
  const semEventos = { ...r.book, events: [] }
  const snap = planSnapshot(semEventos.plans[0], currentVersion(semEventos, semEventos.plans[0]))
  assert.equal(snap.completedSteps, 1)
  assert.equal(snap.progressPercent, 100)
})

await test('todas as etapas feitas levam o plano ATIVO a completed', () => {
  let { book, plan, version } = bookWith('A', 'B')
  for (const st of version.content.steps) {
    book = applyPlanOp(book, { type: 'step', planId: plan.id, stepId: st.id, status: 'done' }).book
  }
  assert.equal(book.plans[0].status, 'completed')
  assert.ok(eventsOf(book, plan.id).some((e) => e.type === 'plan_completed'))
})

await test('um rascunho com etapas marcadas continua rascunho', () => {
  const criado = applyPlanOp(makeBook(), {
    type: 'create',
    taskId: 'T',
    title: 'P',
    content: { steps: [{ id: '', title: 'A', description: null, status: 'pending', order: 1 }] }
  })
  const r = applyPlanOp(criado.book, {
    type: 'step',
    planId: criado.plan.id,
    stepId: criado.version.content.steps[0].id,
    status: 'done'
  })
  assert.equal(r.plan.status, 'draft', 'um rascunho se concluiu sozinho')
})

await test('pausar e ativar registram evento; repetir o mesmo status não', () => {
  const { book, plan } = bookWith('A')
  const pausado = applyPlanOp(book, { type: 'status', planId: plan.id, status: 'paused' })
  assert.ok(eventsOf(pausado.book, plan.id).some((e) => e.type === 'plan_paused'))
  const denovo = applyPlanOp(pausado.book, { type: 'status', planId: plan.id, status: 'paused' })
  assert.equal(
    eventsOf(denovo.book, plan.id).filter((e) => e.type === 'plan_paused').length,
    1
  )
})

await test('revisar um plano sem versão atual é RECUSADO', () => {
  // Plano inconsistente: a versão nova nasceria descolada do histórico, e o
  // usuário ainda pode consertar o arquivo à mão.
  const { book, plan } = bookWith('A')
  const quebrado = { ...book, plans: [{ ...plan, currentVersionId: null }] }
  const r = applyPlanOp(quebrado, { type: 'revise', planId: plan.id, title: 'X' })
  assert.match(r.error, /no current version/)
})

// ─── Progresso derivado ──────────────────────────────────────────────────────

await test('três etapas com uma concluída dão 33%', () => {
  const { book, plan, version } = bookWith('A', 'B', 'C')
  const r = applyPlanOp(book, {
    type: 'step',
    planId: plan.id,
    stepId: version.content.steps[0].id,
    status: 'done'
  })
  const snap = planSnapshot(r.plan, currentVersion(r.book, r.plan))
  assert.equal(snap.progressPercent, 33, 'arredondar para cima mostraria 100% com etapa aberta')
  assert.equal(snap.completedSteps, 1)
  assert.equal(snap.totalSteps, 3)
})

await test('plano sem etapas dá 0, e nunca NaN', () => {
  const criado = applyPlanOp(makeBook(), { type: 'create', taskId: 'T', title: 'Vazio' })
  const snap = planSnapshot(criado.plan, criado.version)
  assert.equal(snap.progressPercent, 0)
  assert.ok(Number.isFinite(snap.progressPercent))
  assert.equal(snap.totalSteps, 0)
})

await test('etapa pulada NÃO conta como concluída', () => {
  // Contar faria um plano abandonado pela metade aparecer como 100%.
  const { book, plan, version } = bookWith('A', 'B')
  const r = applyPlanOp(book, {
    type: 'step',
    planId: plan.id,
    stepId: version.content.steps[0].id,
    status: 'skipped'
  })
  const snap = planSnapshot(r.plan, currentVersion(r.book, r.plan))
  assert.equal(snap.completedSteps, 0)
  assert.equal(snap.skippedSteps, 1)
  assert.equal(snap.progressPercent, 0)
})

await test('etapa bloqueada marca o snapshot com blockedSteps > 0', () => {
  const { book, plan, version } = bookWith('A', 'B')
  const r = applyPlanOp(book, {
    type: 'step',
    planId: plan.id,
    stepId: version.content.steps[1].id,
    status: 'blocked'
  })
  const snap = planSnapshot(r.plan, currentVersion(r.book, r.plan))
  assert.equal(snap.blockedSteps, 1)
  assert.ok(isBlocked(snap), 'a UI não teria como mostrar o impedimento')
})

await test('um plano com TODAS as etapas puladas não é um plano concluído', () => {
  let { book, plan, version } = bookWith('A', 'B')
  for (const st of version.content.steps) {
    book = applyPlanOp(book, { type: 'step', planId: plan.id, stepId: st.id, status: 'skipped' }).book
  }
  assert.equal(isFinished(book.plans[0], currentVersion(book, book.plans[0])), false)
  assert.equal(book.plans[0].status, 'active', 'desistir virou concluir')
})

await test('o status vivo vence o declarado na versão', () => {
  const { book, plan, version } = bookWith('A')
  const st = version.content.steps[0]
  assert.equal(stepStatus(plan, st.id, st.status), 'pending')
  const r = applyPlanOp(book, { type: 'step', planId: plan.id, stepId: st.id, status: 'in_progress' })
  assert.equal(stepStatus(r.plan, st.id, st.status), 'in_progress')
})

// ─── Leitura defensiva ───────────────────────────────────────────────────────

await test('arquivo corrompido devolve null — e o painel avisa em vez de sobrescrever', () => {
  assert.equal(parseBook('{ não sou json'), null)
  assert.equal(parseBook('[1,2,3]'), null)
  assert.equal(parseBook(''), null)
})

await test('versão que aponta para OUTRO plano é ignorada na leitura', () => {
  const raw = JSON.stringify({
    version: 1,
    plans: [{ id: 'P1', taskId: 'T1', title: 'Um', currentVersionId: 'V9' }],
    versions: [{ id: 'V9', planId: 'P2', versionNumber: 1, content: { steps: [] } }],
    events: []
  })
  const book = parseBook(raw)
  assert.equal(book.versions.length, 0, 'uma versão de outro plano entrou no histórico')
  assert.equal(book.plans[0].currentVersionId, null, 'o plano ficou apontando para o vazio')
})

await test('currentVersionId quebrado vira null, e NÃO é reapontado sozinho', () => {
  // Reapontar seria adivinhar qual versão o usuário considerava atual. `null` é
  // lido como plano inconsistente, e a UI impede edição destrutiva.
  const book = parseBook(
    JSON.stringify({
      plans: [{ id: 'P1', taskId: 'T1', title: 'Um', currentVersionId: 'sumiu' }],
      versions: [{ id: 'V1', planId: 'P1', versionNumber: 1, content: { steps: [] } }]
    })
  )
  assert.equal(book.plans[0].currentVersionId, null)
  assert.equal(currentVersion(book, book.plans[0]), null)
})

await test('etapa sem id ganha id na leitura', () => {
  // Sem id, ela não teria como receber status vivo nem aparecer num evento, e
  // sumiria da timeline em silêncio.
  const book = parseBook(
    JSON.stringify({
      plans: [{ id: 'P1', taskId: 'T1', title: 'Um', currentVersionId: 'V1' }],
      versions: [
        { id: 'V1', planId: 'P1', versionNumber: 1, content: { steps: [{ title: 'sem id' }] } }
      ]
    })
  )
  const step = book.versions[0].content.steps[0]
  assert.ok(step.id, 'a etapa continuou sem id')
  assert.equal(step.status, 'pending', 'status ausente devia cair em pending')
})

await test('status desconhecido em arquivo antigo cai em valor seguro', () => {
  const book = parseBook(
    JSON.stringify({
      plans: [{ id: 'P1', taskId: 'T1', title: 'Um', status: 'inventado', stepStatus: { s1: 'voando' } }],
      versions: []
    })
  )
  assert.equal(book.plans[0].status, 'draft')
  assert.deepEqual(book.plans[0].stepStatus, {}, 'um status inventado entrou no mapa vivo')
})

await test('plano sem tarefa dona é descartado; evento órfão também', () => {
  const book = parseBook(
    JSON.stringify({
      plans: [{ id: 'P1', title: 'Sem dono' }],
      versions: [{ id: 'V1', planId: 'P1', versionNumber: 1, content: { steps: [] } }],
      events: [{ id: 'E1', planId: 'P1', taskId: 'T1', type: 'plan_created' }]
    })
  )
  assert.equal(book.plans.length, 0)
  assert.equal(book.versions.length, 0)
  assert.equal(book.events.length, 0)
})

await test('tipo de evento desconhecido ATRAVESSA — auditoria não se apaga', () => {
  const book = parseBook(
    JSON.stringify({
      plans: [{ id: 'P1', taskId: 'T1', title: 'Um' }],
      events: [{ id: 'E1', planId: 'P1', taskId: 'T1', type: 'plan_teleported' }]
    })
  )
  assert.equal(book.events.length, 1)
  assert.equal(book.events[0].type, 'plan_teleported')
})

// ─── Origem externa ──────────────────────────────────────────────────────────

await test('URL externa inválida NÃO vira link', () => {
  // `externalUrl` vem de um Jira, de um webhook, de um arquivo editado à mão. Um
  // `javascript:` num link do canvas é código de terceiro rodando dentro do app.
  assert.equal(safeExternalUrl('javascript:alert(1)'), null)
  assert.equal(safeExternalUrl('file:///etc/passwd'), null)
  assert.equal(safeExternalUrl('data:text/html,<h1>oi'), null)
  assert.equal(safeExternalUrl('nem url é'), null)
  assert.equal(safeExternalUrl(''), null)
  assert.equal(safeExternalUrl(null), null)
  assert.equal(safeExternalUrl(42), null)
  assert.ok(safeExternalUrl('https://jira.example.com/browse/PROJ-123'))
})

await test('metadata com campos desconhecidos não quebra a leitura', () => {
  const origem = normalizeOrigin({
    type: 'jira',
    externalId: 'PROJ-123',
    externalUrl: 'https://jira.example.com/browse/PROJ-123',
    sourceName: 'Plataforma',
    importedAt: '2026-08-29T10:00:00Z',
    metadata: { sprint: 7, labels: ['a'], campoQueNinguemConhece: { fundo: true } }
  })
  assert.equal(origem.type, 'jira')
  assert.deepEqual(origem.metadata.labels, ['a'])
  assert.equal(origem.metadata.campoQueNinguemConhece.fundo, true)
})

await test('provedor desconhecido cai em api, e não em manual', () => {
  // Chamar de manual mentiria sobre quem criou o cartão.
  assert.equal(normalizeOrigin({ type: 'linear' }).type, 'api')
  assert.equal(normalizeOrigin({ type: 'manual' }).type, 'manual')
  assert.equal(normalizeOrigin(null), null)
  assert.equal(normalizeOrigin('jira'), null)
})

await test('origem incompleta mostra só o provedor', () => {
  assert.equal(originSummary({ type: 'slack', externalId: null, sourceName: null }), 'Slack')
  assert.equal(originSummary({ type: 'jira', externalId: 'PROJ-1' }), 'Jira · PROJ-1')
  assert.equal(originSummary(manualOrigin('2026-01-01T00:00:00Z')), '', 'Manual virou ruído na linha')
  assert.equal(originSummary(null), '')
})

await test('metadata grande demais é truncada no DETALHE, não no armazenamento', () => {
  const enorme = 'x'.repeat(5000)
  const linhas = metadataForDisplay({ description: enorme }, 12, 200)
  assert.equal(linhas[0].truncated, true)
  assert.ok(linhas[0].value.length < 250)
  const origem = normalizeOrigin({ type: 'jira', metadata: { description: enorme } })
  assert.equal(origem.metadata.description.length, 5000, 'o armazenamento perdeu dado')
})

// ─── Coluna → significado ────────────────────────────────────────────────────

await test('columnKind lê as colunas padrão em português', () => {
  assert.equal(columnKind({ id: 'todo', title: 'A fazer' }, 0, 3), 'pending')
  assert.equal(columnKind({ id: 'doing', title: 'Fazendo' }, 1, 3), 'in_progress')
  assert.equal(columnKind({ id: 'done', title: 'Feito' }, 2, 3), 'done')
})

await test('columnKind entende colunas do usuário, com acento e sem', () => {
  assert.equal(columnKind({ id: 'em-andamento', title: 'Em Andamento' }, 1, 4), 'in_progress')
  assert.equal(columnKind({ id: 'bloqueadas', title: 'Bloqueadas' }, 2, 4), 'blocked')
  assert.equal(columnKind({ id: 'concluido', title: 'Concluído' }, 3, 4), 'done')
  assert.equal(columnKind({ id: 'cancelado', title: 'Cancelado' }, 2, 4), 'cancelled')
})

await test('coluna de nome opaco cai na posição: a última é a de concluídos', () => {
  // É a mesma convenção que `atelier todo done` já usa para saber para onde
  // mover, e a que `doneAt` do quadro carimba.
  assert.equal(columnKind({ id: 'c1', title: 'Fase A' }, 0, 3), 'pending')
  assert.equal(columnKind({ id: 'c3', title: 'Fase C' }, 2, 3), 'done')
})

await test('columnKinds devolve o quadro inteiro de uma vez', () => {
  const mapa = columnKinds([
    { id: 'ideias', title: 'Ideias' },
    { id: 'wip', title: 'WIP' },
    { id: 'pronto', title: 'Pronto' }
  ])
  assert.deepEqual(mapa, { ideias: 'pending', wip: 'in_progress', pronto: 'done' })
})

await test('os rótulos visíveis estão em português', () => {
  assert.equal(TASK_STATUS_LABELS.in_progress, 'Em andamento')
  assert.equal(TASK_STATUS_LABELS.done, 'Concluída')
  assert.equal(PLAN_STATUS_LABELS.draft, 'Rascunho')
  assert.equal(PLAN_STATUS_LABELS.completed, 'Concluído')
  assert.equal(PLAN_STEP_STATUS_LABELS.skipped, 'Ignorada')
})

// ─── Disco e concorrência ────────────────────────────────────────────────────

await test('salvar e reler preserva planos, versões e eventos', async () => {
  const file = join(home, 'ida-e-volta.json')
  const criado = await apply(file, {
    type: 'create',
    taskId: 'T1',
    title: 'Plano',
    status: 'active',
    content: { steps: [{ id: '', title: 'A', description: null, status: 'pending', order: 1 }] }
  })
  await apply(file, {
    type: 'step',
    planId: criado.plan.id,
    stepId: criado.version.content.steps[0].id,
    status: 'blocked'
  })

  const book = await read(file)
  const plan = planForTask(book, 'T1')
  assert.ok(plan)
  assert.equal(versionsOf(book, plan.id).length, 1)
  assert.ok(eventsOf(book, plan.id).some((e) => e.type === 'step_blocked'))
  const snap = planSnapshot(plan, currentVersion(book, plan))
  assert.equal(snap.blockedSteps, 1)
})

await test('duas escritas concorrentes em planos diferentes SOBREVIVEM as duas', async () => {
  const file = join(home, 'concorrente.json')
  await Promise.all([
    apply(file, { type: 'create', taskId: 'T-A', title: 'do agente A' }),
    apply(file, { type: 'create', taskId: 'T-B', title: 'do agente B' })
  ])
  const book = await read(file)
  const titulos = book.plans.map((p) => p.title).sort()
  assert.deepEqual(titulos, ['do agente A', 'do agente B'], 'uma das duas escritas se perdeu')
})

await test('a gravação é atômica — nenhum .tmp fica para trás', async () => {
  const file = join(home, 'atomico.json')
  await apply(file, { type: 'create', taskId: 'T', title: 'P' })
  await readFile(file, 'utf8')
  await assert.rejects(() => readFile(`${file}.tmp`, 'utf8'))
})

await test('arquivo corrompido RECUSA a operação em vez de sobrescrever', async () => {
  // Ali está o histórico inteiro dos planos daquele quadro, e ninguém o
  // reconstrói.
  const file = join(home, 'corrompido.json')
  await writeFile(file, '{ pela metade', 'utf8')
  const r = await apply(file, { type: 'create', taskId: 'T', title: 'P' })
  assert.match(r.error, /corrupt/)
  assert.equal(await readFile(file, 'utf8'), '{ pela metade', 'o arquivo foi sobrescrito')
})

await test('arquivo que ainda não existe abre como livro vazio, e não como erro', async () => {
  const book = await read(join(home, 'nunca-gravado.json'))
  assert.ok(book)
  assert.equal(book.plans.length, 0)
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
