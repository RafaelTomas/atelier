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
import type { CanvasNode, TodoBoard, TodoItem, UUID, WidgetContent } from '@shared/types'
import { Constants } from '../../constants'
import { makeWidgetContent } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { paths } from '../../persistence/paths'
import { apply, create, read } from '../../todo/todo-store'
import { notifyRenderer } from '../../../ipc/notify'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier todo <list|add|move|done|show|create> …'

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
  return widgetOf(node).view.title || 'TODO'
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

function takeFlags(args: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  const named = ['--status', '--assign', '--notes', '--tags']
  for (let i = 0; i < args.length; i++) {
    if (named.includes(args[i])) flags.set(args[i].slice(2), args[++i] ?? '')
    else if (args[i] === '--mine') flags.set('mine', '1')
    else rest.push(args[i])
  }
  return { rest, flags }
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

  return [
    item.title,
    `  id:       ${item.id}`,
    `  status:   ${item.status}`,
    `  assignee: ${item.assignee || '(none)'}`,
    `  tags:     ${item.tags.join(', ') || '(none)'}`,
    `  created:  ${item.createdAt}`,
    `  updated:  ${item.updatedAt}`,
    `  done:     ${item.doneAt ?? '(not done)'}`,
    item.notes ? `\n${item.notes}` : ''
  ]
    .filter(Boolean)
    .join('\n')
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
