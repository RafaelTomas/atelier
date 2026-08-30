/**
 * `atelier todo` — o quadro de trabalho do canvas, escrito pelo agente.
 *
 * É o que faz um kanban num canvas multi-agente valer mais do que um kanban em
 * qualquer outro lugar: o usuário vê o cartão andar de *Fazendo* para *Feito*
 * enquanto o agente trabalha, sem ninguém contar nada a ele.
 *
 * Mesma regra de escopo do resto do CLI: só os quadros CABEADOS ao terminal que
 * chama. Um agente não enxerga o quadro do canvas inteiro, só o que ligaram nele.
 *
 * Duas decisões de endereçamento, e as duas são sobre erro:
 *
 *  - o item é endereçado por id OU por prefixo de título, porque o agente lê a
 *    lista em texto e o id é um UUID que ele teria de copiar;
 *  - prefixo AMBÍGUO é erro que nomeia os candidatos, nunca "o primeiro". A
 *    mesma regra de `atelier projects info` para nomes repetidos — escolher por
 *    ele faria o agente marcar como feito um cartão que não é o dele.
 *
 * Não há `delete` aqui: apagar cartão é gesto do usuário, no nó. Mesma linha do
 * cofre, onde o agente cria mas não destrói.
 */
import type {
  CanvasNode,
  PlanBook,
  PlanStepStatus,
  TodoBoard,
  TodoItem,
  UUID,
  WidgetContent
} from '@shared/types'
import { PLAN_STEP_STATUSES } from '@shared/types'
import { originSummary, planSnapshot, stepStatus } from '@shared/task-status'
import { Constants } from '../../constants'
import { makeWidgetContent } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { paths } from '../../persistence/paths'
import { apply, create, read } from '../../todo/todo-store'
import {
  apply as applyPlan,
  currentVersion,
  planForTask,
  read as readPlans
} from '../../todo/plan-store'
import { notifyRenderer } from '../../../ipc/notify'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier todo <list|add|move|done|show|create|plan|step> …'

export async function handleTodo(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'list':
      return listItems(args, tid)
    case 'add':
      return addItem(args, tid)
    case 'move':
      return moveItem(args, tid)
    case 'done':
      return doneItem(args, tid)
    case 'show':
      return showItem(args, tid)
    case 'create':
      return createBoard(args, tid)
    case 'plan':
      return planCommand(args, tid)
    case 'step':
      return stepCommand(args, tid)
    default:
      return USAGE
  }
}

// ─── Achar o quadro ───────────────────────────────────────────────────────────

/** Nós de quadro cabeados ao chamador. */
function boardNodes(tid: UUID): CanvasNode[] {
  return connectedNodes(tid).filter(
    (n) => n.content.type === 'widget' && n.content.value.kind === 'todo'
  )
}

function widgetOf(node: CanvasNode): WidgetContent {
  return node.content.value as WidgetContent
}

function boardTitle(node: CanvasNode): string {
  return widgetOf(node).view.title || 'Tarefas'
}

/**
 * O quadro pedido pelo nome, ou o ÚNICO cabeado quando o nome é omitido.
 *
 * Omitir o nome com dois quadros ligados é erro: adivinhar qual deles faria o
 * agente escrever no quadro errado, e nada na resposta denunciaria isso.
 */
function findBoard(tid: UUID, name?: string): CanvasNode | string {
  const nodes = boardNodes(tid)
  if (nodes.length === 0) {
    return "error: no TODO board connected to this terminal. Create one with 'atelier todo create \"Title\"'."
  }
  if (!name) {
    if (nodes.length === 1) return nodes[0]
    const names = nodes.map((n) => `'${boardTitle(n)}'`).join(', ')
    return `error: several boards are connected (${names}). Name the one you mean.`
  }

  const needle = name.toLowerCase().trim()
  const exact = nodes.filter((n) => boardTitle(n).toLowerCase() === needle)
  if (exact.length === 1) return exact[0]

  const partial = nodes.filter((n) => boardTitle(n).toLowerCase().includes(needle))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    const names = partial.map((n) => `'${boardTitle(n)}'`).join(', ')
    return `error: '${name}' matches several boards: ${names}.`
  }
  const names = nodes.map((n) => `'${boardTitle(n)}'`).join(', ')
  return `error: no connected board named '${name}'. Connected: ${names}.`
}

/** Caminho do arquivo do quadro daquele nó. */
function fileFor(tid: UUID, node: CanvasNode): string | null {
  const ws = workspaceForTerminal(tid)
  const file = widgetOf(node).view.file
  if (!ws || !file) return null
  return paths.todoFile(ws.id, file)
}

/** Os planos daquele quadro — mesmo nome de arquivo, outra pasta. */
function planFileFor(tid: UUID, node: CanvasNode): string | null {
  const ws = workspaceForTerminal(tid)
  const file = widgetOf(node).view.file
  if (!ws || !file) return null
  return paths.planFile(ws.id, file)
}

/**
 * O item por id completo ou por prefixo de TÍTULO.
 *
 * Ambíguo é erro que nomeia os candidatos: escolher o primeiro faria o agente
 * mover um cartão que não é o que ele quis dizer, e a resposta pareceria certa.
 */
function findItem(board: TodoBoard, needle: string): TodoItem | string {
  const alvo = needle.toLowerCase().trim()

  const byId = board.items.filter((i) => i.id.toLowerCase() === alvo)
  if (byId.length === 1) return byId[0]

  const byPrefix = board.items.filter((i) => i.id.toLowerCase().startsWith(alvo))
  if (byPrefix.length === 1) return byPrefix[0]

  const byTitle = board.items.filter((i) => i.title.toLowerCase().startsWith(alvo))
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    const nomes = byTitle.map((i) => `'${i.title}' (${i.id.slice(0, 8)})`).join(', ')
    return `error: '${needle}' matches several items: ${nomes}. Use the id.`
  }

  const contains = board.items.filter((i) => i.title.toLowerCase().includes(alvo))
  if (contains.length === 1) return contains[0]
  if (contains.length > 1) {
    const nomes = contains.map((i) => `'${i.title}' (${i.id.slice(0, 8)})`).join(', ')
    return `error: '${needle}' matches several items: ${nomes}. Use the id.`
  }
  return `error: no item matching '${needle}'.`
}

function takeFlags(args: string[]): {
  rest: string[]
  flags: Map<string, string>
  /**
   * `--step` é o único flag REPETÍVEL. A alternativa (`--steps "a,b,c"`) faria
   * uma etapa com vírgula no texto virar duas, e etapa de plano é frase.
   */
  steps: string[]
} {
  const rest: string[] = []
  const flags = new Map<string, string>()
  const steps: string[] = []
  const named = ['--status', '--assign', '--notes', '--tags', '--title', '--objective', '--summary']
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--step') steps.push(args[++i] ?? '')
    else if (named.includes(args[i])) flags.set(args[i].slice(2), args[++i] ?? '')
    else if (args[i] === '--mine') flags.set('mine', '1')
    else rest.push(args[i])
  }
  return { rest, flags, steps: steps.filter(Boolean) }
}

/** Nome do terminal chamador — é o que `--mine` e `--assign` sem valor usam. */
function callerName(tid: UUID): string {
  const ws = workspaceForTerminal(tid)
  const node = ws?.node(tid)
  return node?.content.type === 'terminal' ? node.content.value.name : ''
}

// ─── Verbos ───────────────────────────────────────────────────────────────────

async function listItems(argv: string[], tid: UUID): Promise<string> {
  const { rest, flags } = takeFlags(argv)
  const node = findBoard(tid, rest[2])
  if (typeof node === 'string') return node
  const file = fileFor(tid, node)
  if (!file) return 'error: this board has no file yet'

  const board = await read(file)
  if (!board) return 'error: the board file is corrupt — the user needs to fix it in the node'

  const mine = flags.has('mine') ? callerName(tid) : null
  const status = flags.get('status')
  if (status && !board.columns.some((c) => c.id === status)) {
    return unknownStatus(status, board)
  }

  const linhas: string[] = [`${board.title}:`]
  for (const col of board.columns) {
    if (status && col.id !== status) continue
    const items = board.items
      .filter((i) => i.status === col.id)
      .filter((i) => !mine || i.assignee === mine)
      .sort((a, b) => a.order - b.order)
    linhas.push(`  ${col.title} (${col.id}) — ${items.length}`)
    for (const i of items) {
      const quem = i.assignee ? `  [${i.assignee}]` : ''
      linhas.push(`    ${i.id.slice(0, 8)}  ${i.title}${quem}`)
    }
  }
  if (mine) linhas.push(`  (filtered to '${mine}')`)
  return linhas.join('\n')
}

async function addItem(argv: string[], tid: UUID): Promise<string> {
  const { rest, flags } = takeFlags(argv)
  const boardName = rest[2]
  const title = rest[3]
  if (!boardName || !title) {
    return 'error: usage: atelier todo add "Board" "title" [--status doing] [--assign "Name"] [--notes "…"]'
  }

  const node = findBoard(tid, boardName)
  if (typeof node === 'string') return node
  const file = fileFor(tid, node)
  if (!file) return 'error: this board has no file yet'

  const board = await read(file)
  if (board && board.items.length >= Constants.todoMaxItems) {
    return `error: this board already has ${board.items.length} items (limit ${Constants.todoMaxItems}).`
  }

  const tags = flags.get('tags')
  const result = await apply(file, {
    type: 'add',
    title,
    status: flags.get('status'),
    assignee: flags.get('assign'),
    notes: flags.get('notes'),
    tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined
  })
  if (result.error) return `error: ${result.error}`

  notifyBoard(tid, node)
  const item = result.item as TodoItem
  return `Added '${item.title}' to ${boardTitle(node)} (${item.status}), id ${item.id.slice(0, 8)}.`
}

async function moveItem(argv: string[], tid: UUID): Promise<string> {
  const { rest } = takeFlags(argv)
  const [, , boardName, needle, status] = rest
  if (!boardName || !needle || !status) {
    return 'error: usage: atelier todo move "Board" <id|"title prefix"> <status>'
  }
  return moveTo(tid, boardName, needle, status)
}

async function doneItem(argv: string[], tid: UUID): Promise<string> {
  const { rest } = takeFlags(argv)
  const [, , boardName, needle] = rest
  if (!boardName || !needle) {
    return 'error: usage: atelier todo done "Board" <id|"title prefix">'
  }
  const node = findBoard(tid, boardName)
  if (typeof node === 'string') return node
  const file = fileFor(tid, node)
  if (!file) return 'error: this board has no file yet'
  const board = await read(file)
  if (!board) return 'error: the board file is corrupt'
  // A ÚLTIMA coluna é "feito", venha ela a se chamar como for: o usuário pode
  // ter renomeado as colunas, e um `done` que procurasse literalmente 'done'
  // falharia num quadro em português.
  return moveTo(tid, boardName, needle, board.columns.at(-1)?.id ?? 'done')
}

async function moveTo(tid: UUID, boardName: string, needle: string, status: string): Promise<string> {
  const node = findBoard(tid, boardName)
  if (typeof node === 'string') return node
  const file = fileFor(tid, node)
  if (!file) return 'error: this board has no file yet'

  const board = await read(file)
  if (!board) return 'error: the board file is corrupt — the user needs to fix it in the node'
  if (!board.columns.some((c) => c.id === status)) return unknownStatus(status, board)

  const item = findItem(board, needle)
  if (typeof item === 'string') return item

  const result = await apply(file, { type: 'move', id: item.id, status })
  if (result.error) return `error: ${result.error}`

  notifyBoard(tid, node)
  return `Moved '${item.title}' to ${status}.`
}

async function showItem(argv: string[], tid: UUID): Promise<string> {
  const { rest } = takeFlags(argv)
  const [, , boardName, needle] = rest
  if (!boardName || !needle) return 'error: usage: atelier todo show "Board" <id|"title prefix">'

  const node = findBoard(tid, boardName)
  if (typeof node === 'string') return node
  const file = fileFor(tid, node)
  if (!file) return 'error: this board has no file yet'
  const board = await read(file)
  if (!board) return 'error: the board file is corrupt'

  const item = findItem(board, needle)
  if (typeof item === 'string') return item

  const planFile = planFileFor(tid, node)
  const book = planFile ? await readPlans(planFile) : null
  const plan = book ? planForTask(book, item.id) : null

  return [
    item.title,
    `  id:       ${item.id}`,
    `  status:   ${item.status}`,
    `  assignee: ${item.assignee || '(none)'}`,
    `  tags:     ${item.tags.join(', ') || '(none)'}`,
    // Origem manual não é impressa: dizer "Manual" em todo cartão feito à mão
    // seria ruído em quase toda linha da saída.
    originSummary(item.origin) ? `  origin:   ${originSummary(item.origin)}` : '',
    plan && book ? `  plan:     ${plan.title} — ${progressOf(book, plan.id)}` : '',
    `  created:  ${item.createdAt}`,
    `  updated:  ${item.updatedAt}`,
    `  done:     ${item.doneAt ?? '(not done)'}`,
    item.notes ? `\n${item.notes}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

// ─── Planos ───────────────────────────────────────────────────────────────────

/**
 * O plano do cartão: mostra, cria ou revisa.
 *
 * Sem `--step`, `--title` ou `--objective`, MOSTRA. Um `plan` de dedo errado que
 * criasse plano vazio apagaria da vista o plano que o usuário escreveu — e
 * apagar não é gesto do agente aqui, pela mesma regra que tira o `delete` deste
 * CLI.
 *
 * Com etapas, cria (se não há plano) ou revisa (se há). Revisar é mudança
 * ESTRUTURAL: nasce uma versão nova, e a anterior fica inteira no histórico.
 * Marcar etapa é o outro verbo, `step`, que não cria versão nenhuma.
 */
async function planCommand(argv: string[], tid: UUID): Promise<string> {
  const { rest, flags, steps } = takeFlags(argv)
  const [, , boardName, needle] = rest
  if (!boardName || !needle) {
    return 'error: usage: atelier todo plan "Board" <id|"title prefix"> [--title "…"] [--objective "…"] [--step "…"]…'
  }

  const found = await locate(tid, boardName, needle)
  if (typeof found === 'string') return found
  const { node, item, planFile } = found

  const book = await readPlans(planFile)
  if (!book) return 'error: the plans file is corrupt — the user needs to fix it in the node'
  const existing = planForTask(book, item.id)

  if (steps.length === 0 && !flags.has('title') && !flags.has('objective')) {
    if (!existing) return `'${item.title}' has no plan yet. Create one with --step "…".`
    return planReport(book, existing.id)
  }

  const content =
    steps.length > 0
      ? {
          steps: steps.map((title, n) => ({
            // Id vazio: `plan-store` gera o definitivo. Aqui o CLI não tem o que
            // dizer sobre identidade de etapa.
            id: '',
            title,
            description: null,
            status: 'pending' as const,
            order: n + 1
          }))
        }
      : undefined

  const result = existing
    ? await applyPlan(planFile, {
        type: 'revise',
        planId: existing.id,
        title: flags.get('title'),
        objective: flags.get('objective'),
        content,
        changeSummary: flags.get('summary') ?? null,
        createdBy: callerName(tid) || null
      })
    : await applyPlan(planFile, {
        type: 'create',
        taskId: item.id,
        title: flags.get('title') || item.title,
        objective: flags.get('objective') ?? '',
        content,
        createdBy: callerName(tid) || null,
        // Um plano escrito por agente nasce ATIVO, e não rascunho: ele já é o
        // que aquele agente vai executar em seguida.
        status: 'active'
      })
  if (result.error) return `error: ${result.error}`

  // O cartão só aponta para o plano DEPOIS de ele existir em disco: um ponteiro
  // para um plano que a gravação perdeu seria um cartão prometendo, para sempre,
  // um plano que ninguém consegue abrir.
  const plan = result.plan ?? existing
  const boardFile = fileFor(tid, node)
  if (!existing && plan && boardFile) {
    await apply(boardFile, { type: 'plan', id: item.id, planId: plan.id })
  }
  notifyBoard(tid, node)
  return plan ? planReport(result.book, plan.id) : 'error: the plan vanished after the write'
}

/**
 * Status vivo de uma etapa. NÃO cria versão — é o ponto inteiro do desenho: uma
 * versão por clique em checkbox tornaria o histórico ilegível.
 */
async function stepCommand(argv: string[], tid: UUID): Promise<string> {
  const { rest } = takeFlags(argv)
  const [, , boardName, needle, which, status] = rest
  if (!boardName || !needle || !which || !status) {
    return 'error: usage: atelier todo step "Board" <id|"title prefix"> <step number|"step prefix"> <pending|in_progress|done|blocked|skipped>'
  }
  if (!(PLAN_STEP_STATUSES as string[]).includes(status)) {
    return `error: unknown step status '${status}'. Valid: ${PLAN_STEP_STATUSES.join(', ')}.`
  }

  const found = await locate(tid, boardName, needle)
  if (typeof found === 'string') return found
  const { node, item, planFile } = found

  const book = await readPlans(planFile)
  if (!book) return 'error: the plans file is corrupt'
  const plan = planForTask(book, item.id)
  if (!plan) return `error: '${item.title}' has no plan.`
  const version = currentVersion(book, plan)
  if (!version) {
    return `error: the plan of '${item.title}' has no current version — the user needs to fix the file.`
  }

  // A etapa vem por NÚMERO (o que o relatório imprime) ou por prefixo de título,
  // a mesma dupla do cartão: o id da etapa é um UUID que o agente teria de
  // copiar da tela.
  const n = Number(which)
  const byNumber = Number.isInteger(n) && n > 0 ? version.content.steps[n - 1] : undefined
  const alvo = which.toLowerCase().trim()
  const byTitle = version.content.steps.filter((st) => st.title.toLowerCase().startsWith(alvo))
  const step = byNumber ?? (byTitle.length === 1 ? byTitle[0] : undefined)
  if (!step) {
    if (byTitle.length > 1) {
      const nomes = byTitle.map((st) => `'${st.title}'`).join(', ')
      return `error: '${which}' matches several steps: ${nomes}. Use the number.`
    }
    return `error: no step '${which}' in the current version.`
  }

  const result = await applyPlan(planFile, {
    type: 'step',
    planId: plan.id,
    stepId: step.id,
    status: status as PlanStepStatus
  })
  if (result.error) return `error: ${result.error}`
  notifyBoard(tid, node)
  return `Step '${step.title}' is now ${status}. ${progressOf(result.book, plan.id)}`
}

/** Cartão e os dois arquivos de uma vez — os verbos de plano precisam dos três. */
async function locate(
  tid: UUID,
  boardName: string,
  needle: string
): Promise<{ node: CanvasNode; item: TodoItem; planFile: string } | string> {
  const node = findBoard(tid, boardName)
  if (typeof node === 'string') return node
  const file = fileFor(tid, node)
  const planFile = planFileFor(tid, node)
  if (!file || !planFile) return 'error: this board has no file yet'
  const board = await read(file)
  if (!board) return 'error: the board file is corrupt — the user needs to fix it in the node'
  const item = findItem(board, needle)
  if (typeof item === 'string') return item
  return { node, item, planFile }
}

function progressOf(book: PlanBook, planId: string): string {
  const plan = book.plans.find((p) => p.id === planId)
  if (!plan) return ''
  const snap = planSnapshot(plan, currentVersion(book, plan))
  const travado = snap.blockedSteps > 0 ? `, ${snap.blockedSteps} blocked` : ''
  return `${snap.progressPercent}% (${snap.completedSteps}/${snap.totalSteps}${travado})`
}

function planReport(book: PlanBook, planId: string): string {
  const plan = book.plans.find((p) => p.id === planId)
  if (!plan) return 'error: no such plan'
  const version = currentVersion(book, plan)
  const linhas = [
    `${plan.title} — ${plan.status}, ${progressOf(book, plan.id)}`,
    plan.objective ? `  ${plan.objective}` : ''
  ]
  if (!version) {
    linhas.push('  (this plan has no current version — the user needs to fix the file)')
    return linhas.filter(Boolean).join('\n')
  }
  linhas.push(`  version ${version.versionNumber}`)
  version.content.steps.forEach((st, n) => {
    linhas.push(`    ${n + 1}. [${stepStatus(plan, st.id, st.status)}] ${st.title}`)
  })
  return linhas.filter(Boolean).join('\n')
}

/**
 * Cria o nó do quadro, já cabeado ao chamador — mesmo gesto do `note create`,
 * do `table create` e do `portal open`.
 */
async function createBoard(argv: string[], tid: UUID): Promise<string> {
  const { rest } = takeFlags(argv)
  const title = rest[2]
  if (!title) return 'error: usage: atelier todo create "Title" [column…]'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  // Colunas extras viram id a partir do título: o agente escreve "A fazer" e o
  // status vira `a-fazer`, que é o que ele vai digitar no `move`.
  const extra = rest.slice(3).filter(Boolean)
  const columns =
    extra.length > 0
      ? extra.map((t) => ({ id: slug(t), title: t })).filter((c) => c.id)
      : undefined
  if (columns && columns.length === 0) return 'error: those column names produced no valid ids'

  const fileName = `${crypto.randomUUID()}`
  const content = makeWidgetContent('todo', null, { title, file: fileName, mode: 'kanban' })

  const node = makeCanvasNode(
    {
      x: caller.frame.x + caller.frame.width + 60,
      y: caller.frame.y,
      width: Constants.todoDefaultWidth,
      height: Constants.todoDefaultHeight
    },
    { type: 'widget', value: content }
  )

  await create(paths.todoFile(ws.id, fileName), title, columns)
  ws.addNode(node)
  ws.addConnection(tid, node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  const cols = (columns ?? [{ id: 'todo' }, { id: 'doing' }, { id: 'done' }])
    .map((c) => c.id)
    .join(', ')
  return `Created board '${title}' with columns ${cols}, connected to this terminal.`
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function unknownStatus(status: string, board: TodoBoard): string {
  const valid = board.columns.map((c) => `'${c.id}'`).join(', ')
  return `error: unknown status '${status}'. Valid: ${valid}.`
}

/**
 * Avisa o renderer que o quadro mudou POR FORA.
 *
 * O nó lê o arquivo; sem este empurrão ele mostraria o quadro de antes do
 * `atelier todo move` até alguém mexer nele — e o ponto da feature é justamente
 * o usuário ver o cartão andar enquanto o agente trabalha.
 */
function notifyBoard(tid: UUID, node: CanvasNode): void {
  const ws = workspaceForTerminal(tid)
  if (ws) notifyRenderer('todo:changed', { workspaceId: ws.id, nodeId: node.id })
}
