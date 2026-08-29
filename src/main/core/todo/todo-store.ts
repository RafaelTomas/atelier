/**
 * O quadro de TODO em disco, e as operações sobre ele.
 *
 * Um arquivo por nó, em `workspaces/<wsId>/todos/<contentId>.json` — a mesma
 * decisão da nota, da tabela, da imagem e do cofre: conteúdo pesado ou de
 * escrita frequente não entra no `workspace.json`.
 *
 * ─── A escrita é uma OPERAÇÃO, nunca "grave este arquivo" ───
 *
 * Dois agentes mexendo no mesmo quadro é o caso NORMAL aqui, não a exceção. Se a
 * API fosse "leia, mude no seu lado, grave o arquivo inteiro", duas mudanças em
 * cartões DIFERENTES resultariam numa apagando a outra — o agente que gravasse
 * por último escreveria por cima de um quadro que já não era o que ele leu.
 *
 * Então toda escrita é `apply(file, op)`: o main lê o arquivo AGORA, aplica a
 * operação sobre essa versão e grava. Uma fila por arquivo serializa as
 * chamadas, então duas operações concorrentes viram duas leituras-modificações
 * em sequência, e as duas sobrevivem.
 *
 * A gravação é atômica (`tmp` + `rename`), como as tabelas: um crash no meio
 * deixaria um JSON pela metade, e o quadro inteiro se perderia.
 *
 * Módulo sem `electron` — roda no smoke headless.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TodoBoard, TodoColumn, TodoItem, UUID } from '@shared/types'
import { TODO_DEFAULT_COLUMNS } from '@shared/types'
import { uuid } from '../coding'

/** Espaçamento inicial entre cartões. Esparso para caber inserção no meio. */
const ORDER_STEP = 1000

/** Abaixo disto a distância entre dois vizinhos não comporta mais um cartão. */
const ORDER_MIN_GAP = 1

export function makeBoard(title: string, columns: TodoColumn[] = TODO_DEFAULT_COLUMNS): TodoBoard {
  return { version: 1, title, columns: columns.map((c) => ({ ...c })), items: [] }
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/**
 * Lê e CONSERTA o quadro, sem gravar.
 *
 * O conserto acontece na leitura, em memória: um item cujo `status` aponta para
 * uma coluna que não existe mais cai na primeira coluna em vez de sumir da
 * vista. Sumir seria o pior resultado possível — o cartão continuaria no arquivo
 * e ninguém o veria para consertá-lo.
 *
 * Devolve `null` quando o arquivo não é um quadro. `null` é diferente de quadro
 * vazio de propósito: o nó abre com aviso e NÃO sobrescreve o arquivo, o mesmo
 * pudor do modo seguro do workspace.
 */
export function parseBoard(raw: string): TodoBoard | null {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const columns: TodoColumn[] = Array.isArray(data.columns)
    ? data.columns
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({ id: str(c.id), title: str(c.title, str(c.id)) }))
        .filter((c) => c.id !== '')
    : []

  // O quadro precisa de pelo menos uma coluna: sem nenhuma, nenhum item teria
  // onde existir e o nó abriria vazio para sempre.
  const cols = columns.length > 0 ? columns : TODO_DEFAULT_COLUMNS.map((c) => ({ ...c }))
  const known = new Set(cols.map((c) => c.id))

  const items: TodoItem[] = Array.isArray(data.items)
    ? data.items
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map((i, n) => {
          const status = str(i.status)
          return {
            id: (str(i.id) || uuid()) as UUID,
            title: str(i.title),
            // Status órfão (coluna apagada à mão no JSON) → primeira coluna.
            status: known.has(status) ? status : cols[0].id,
            order: typeof i.order === 'number' && Number.isFinite(i.order) ? i.order : (n + 1) * ORDER_STEP,
            assignee: str(i.assignee),
            notes: str(i.notes),
            tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === 'string') : [],
            createdAt: str(i.createdAt),
            updatedAt: str(i.updatedAt),
            doneAt: typeof i.doneAt === 'string' ? i.doneAt : null
          }
        })
        .filter((i) => i.title !== '')
    : []

  return {
    version: typeof data.version === 'number' ? data.version : 1,
    title: str(data.title, 'Quadro'),
    columns: cols,
    items
  }
}

export async function readBoard(file: string): Promise<TodoBoard | null> {
  try {
    return parseBoard(await readFile(file, 'utf8'))
  } catch {
    // Arquivo ausente é um quadro que ainda não foi gravado — diferente de
    // arquivo corrompido, que devolve null e faz o nó avisar.
    return makeBoard('Quadro')
  }
}

async function writeBoard(file: string, board: TodoBoard): Promise<void> {
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify(board, null, 2), 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

// ─── Ordenação ────────────────────────────────────────────────────────────────

export function itemsIn(board: TodoBoard, status: string): TodoItem[] {
  return board.items.filter((i) => i.status === status).sort((a, b) => a.order - b.order)
}

/**
 * A posição de um cartão que entra numa coluna, entre `before` e `after`.
 *
 * A média dos vizinhos: inserir no meio não toca em nenhum outro cartão, que é o
 * que evita a coluna inteira ser reescrita a cada arrasto (e, com dois agentes,
 * o que evita uma reescrita apagar a do outro).
 *
 * `null` significa "reindexe": os vizinhos ficaram tão próximos que não cabe
 * mais nada entre eles — depois de ~50 inserções sucessivas no mesmo ponto.
 */
export function orderBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return ORDER_STEP
  if (before === null) return (after as number) - ORDER_STEP
  if (after === null) return before + ORDER_STEP
  if (after - before < ORDER_MIN_GAP) return null
  return (before + after) / 2
}

/** Redistribui uma coluna em 1000, 2000, 3000… Só quando `orderBetween` desiste. */
function reindex(board: TodoBoard, status: string): void {
  itemsIn(board, status).forEach((item, n) => {
    item.order = (n + 1) * ORDER_STEP
  })
}

// ─── Operações ────────────────────────────────────────────────────────────────

export type TodoOp =
  | { type: 'add'; title: string; status?: string; assignee?: string; notes?: string; tags?: string[] }
  | { type: 'move'; id: UUID; status: string; before?: UUID | null; after?: UUID | null }
  | { type: 'edit'; id: UUID; title?: string; notes?: string; assignee?: string; tags?: string[] }
  | { type: 'remove'; id: UUID }
  | { type: 'columns'; columns: TodoColumn[] }
  | { type: 'title'; title: string }

export interface OpResult {
  board: TodoBoard
  /** O item tocado, quando a operação tocou um. */
  item?: TodoItem
  error?: string
}

/**
 * Aplica a operação sobre o quadro DADO, e devolve o quadro novo.
 *
 * Função pura: quem lê e grava é `apply`. Separar as duas é o que torna as
 * regras (ordem fracionária, status órfão, `doneAt`) testáveis sem tocar disco.
 */
export function applyOp(board: TodoBoard, op: TodoOp, now = new Date()): OpResult {
  const at = now.toISOString()
  const known = new Set(board.columns.map((c) => c.id))
  const next: TodoBoard = { ...board, columns: [...board.columns], items: board.items.map((i) => ({ ...i })) }

  switch (op.type) {
    case 'add': {
      const status = op.status && known.has(op.status) ? op.status : next.columns[0].id
      if (op.status && !known.has(op.status)) {
        return { board, error: unknownStatus(op.status, next) }
      }
      const last = itemsIn(next, status).at(-1)
      const item: TodoItem = {
        id: uuid(),
        title: op.title,
        status,
        order: (last?.order ?? 0) + ORDER_STEP,
        assignee: op.assignee ?? '',
        notes: op.notes ?? '',
        tags: op.tags ?? [],
        createdAt: at,
        updatedAt: at,
        doneAt: status === lastColumn(next) ? at : null
      }
      next.items.push(item)
      return { board: next, item }
    }

    case 'move': {
      const item = next.items.find((i) => i.id === op.id)
      if (!item) return { board, error: `no item with id ${op.id}` }
      if (!known.has(op.status)) return { board, error: unknownStatus(op.status, next) }

      item.status = op.status
      item.updatedAt = at
      // `doneAt` marca a chegada na ÚLTIMA coluna e é limpo ao sair dela: um
      // cartão que volta para "Fazendo" não pode continuar dizendo que terminou.
      item.doneAt = op.status === lastColumn(next) ? (item.doneAt ?? at) : null

      const coluna = itemsIn(next, op.status).filter((i) => i.id !== item.id)
      const beforeItem = op.before ? coluna.find((i) => i.id === op.before) : null
      const afterItem = op.after ? coluna.find((i) => i.id === op.after) : null
      const order = orderBetween(
        beforeItem?.order ?? (op.before === undefined && op.after ? null : (coluna.at(-1)?.order ?? null)),
        afterItem?.order ?? null
      )
      if (order === null) {
        reindex(next, op.status)
        // Depois de reindexar, o meio existe de novo.
        const recol = itemsIn(next, op.status).filter((i) => i.id !== item.id)
        const b = op.before ? recol.find((i) => i.id === op.before)?.order ?? null : null
        const a = op.after ? recol.find((i) => i.id === op.after)?.order ?? null : null
        item.order = orderBetween(b, a) ?? (recol.at(-1)?.order ?? 0) + ORDER_STEP
      } else {
        item.order = order
      }
      return { board: next, item }
    }

    case 'edit': {
      const item = next.items.find((i) => i.id === op.id)
      if (!item) return { board, error: `no item with id ${op.id}` }
      if (op.title !== undefined) item.title = op.title
      if (op.notes !== undefined) item.notes = op.notes
      if (op.assignee !== undefined) item.assignee = op.assignee
      if (op.tags !== undefined) item.tags = op.tags
      item.updatedAt = at
      return { board: next, item }
    }

    case 'remove': {
      const before = next.items.length
      next.items = next.items.filter((i) => i.id !== op.id)
      if (next.items.length === before) return { board, error: `no item with id ${op.id}` }
      return { board: next }
    }

    case 'columns': {
      const cols = op.columns.filter((c) => c.id)
      if (cols.length === 0) return { board, error: 'a board needs at least one column' }
      next.columns = cols
      // Cartões da coluna que sumiu vão para a primeira, e não para o limbo.
      const ids = new Set(cols.map((c) => c.id))
      for (const item of next.items) {
        if (!ids.has(item.status)) item.status = cols[0].id
      }
      return { board: next }
    }

    case 'title': {
      next.title = op.title
      return { board: next }
    }
  }
}

function lastColumn(board: TodoBoard): string {
  return board.columns.at(-1)?.id ?? board.columns[0].id
}

function unknownStatus(status: string, board: TodoBoard): string {
  const valid = board.columns.map((c) => `'${c.id}'`).join(', ')
  return `unknown status '${status}'. Valid: ${valid}.`
}

// ─── A fila por arquivo ───────────────────────────────────────────────────────

/**
 * Uma corrente de promessas por arquivo.
 *
 * Sem ela, dois `apply` simultâneos leriam o MESMO quadro e o segundo gravaria
 * por cima do primeiro — que é exatamente o bug que este módulo existe para não
 * ter. Com ela, a leitura do segundo acontece depois da gravação do primeiro.
 */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(file) ?? Promise.resolve()
  // `catch` antes de encadear: uma operação que falha não pode travar a fila
  // daquele arquivo para o resto da sessão.
  const next = prev.then(task, task)
  queues.set(
    file,
    next.catch(() => undefined)
  )
  return next
}

/**
 * Lê, aplica e grava — serializado por arquivo.
 *
 * Um quadro corrompido RECUSA a operação em vez de sobrescrever: o arquivo pode
 * ser o trabalho de alguém, e um `add` não é motivo para descartá-lo.
 */
export function apply(file: string, op: TodoOp): Promise<OpResult> {
  return enqueue(file, async () => {
    const board = await readBoard(file)
    if (!board) {
      return { board: makeBoard('Quadro'), error: 'the board file is corrupt — fix or remove it' }
    }
    const result = applyOp(board, op)
    if (result.error) return result
    await writeBoard(file, result.board)
    return result
  })
}

/** Leitura serializada com as escritas — nunca lê um arquivo em meio a um rename. */
export function read(file: string): Promise<TodoBoard | null> {
  return enqueue(file, () => readBoard(file))
}

/** Cria o arquivo do quadro. Recusa se já existe: criar não pode apagar. */
export async function create(file: string, title: string, columns?: TodoColumn[]): Promise<TodoBoard> {
  return enqueue(file, async () => {
    const board = makeBoard(title, columns)
    await writeBoard(file, board)
    return board
  })
}

/** Só para teste — a fila é global ao processo. */
export function resetQueues(): void {
  queues.clear()
}
