/**
 * Quadro de Tarefas — kanban e lista, sobre a mesma fonte.
 *
 * O quadro vive num arquivo por nó, não na store nem no `workspace.json` (ver
 * core/todo/todo-store.ts). Este painel lê esse arquivo pelo IPC e guarda o
 * resultado em `useState` LOCAL, pela mesma regra do monitor e do git: a store
 * notifica todos os assinantes a cada `set()`, e um quadro que mudasse ali
 * re-renderizaria o canvas inteiro a cada cartão arrastado.
 *
 * ─── Toda escrita é uma operação ───
 *
 * Nunca "grave este quadro". O usuário arrastando um cartão e um agente
 * marcando outro pelo `atelier todo` acontecem ao mesmo tempo — é o caso NORMAL
 * num canvas multi-agente. Mandar o quadro inteiro faria um desfazer o outro em
 * silêncio; mandar a operação faz as duas sobreviverem.
 *
 * ─── Duas vistas, uma intenção ───
 *
 * `view.mode` é o que o USUÁRIO escolheu. Num nó estreito o painel cai sozinho
 * para a lista sem mexer no `view`: a vista gravada é a intenção, não o que
 * coube na tela — alargar o nó de volta devolve o kanban sem ele ter de pedir.
 *
 * ─── Dois arquivos, uma tela ───
 *
 * Os Planos moram em `plans/<file>.json`, ao lado do quadro, e são lidos aqui
 * junto com ele. Ficam separados porque o quadro é reescrito a cada arrasto de
 * cartão enquanto versões e eventos crescem sem limite — juntá-los faria cada
 * cartão movido reescrever todo o histórico. O que a tela mostra é a junção dos
 * dois, e o progresso é sempre DERIVADO por `planSnapshot`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanBook, PlanStepStatus, TodoBoard, TodoItem, UUID } from '@shared/types'
import { columnKinds, TASK_STATUS_LABELS } from '@shared/task-status'
import type { TaskStatusKind } from '@shared/task-status'
import { IconPlus, IconTrash } from '../icons'
import { store, useStore } from '../state/store'
import { hasOpenSteps, planView, TaskDecision, TaskDetail, TaskSummary } from './task-plan'

/** Espelha Constants.todoListBreakpoint. Abaixo disto o kanban não é legível. */
const LIST_BREAKPOINT = 420

interface Props {
  nodeId: UUID
  /** Nome do arquivo do quadro (`view.file`). */
  file: string
  /** `view.mode` — a INTENÇÃO do usuário, não o que coube. */
  mode: 'kanban' | 'list'
  onChangeMode: (mode: 'kanban' | 'list') => void
}

export function TodoPanel({ nodeId, file, mode, onChangeMode }: Props): JSX.Element {
  const { workspace } = useStore()
  const wsId = workspace?.id ?? null

  const [board, setBoard] = useState<TodoBoard | null>(null)
  const [book, setBook] = useState<PlanBook | null>(null)
  /** Distinto de `board === null`: "ainda não li" não é "arquivo corrompido". */
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  /** O cartão aberto no painel expandido. Um por vez — o nó é estreito. */
  const [openId, setOpenId] = useState<UUID | null>(null)
  /** A conclusão que espera decisão explícita: cartão e coluna de destino. */
  const [pending, setPending] = useState<{ id: UUID; status: string } | null>(null)

  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId || !file) return
    // Em paralelo: são dois arquivos independentes, e serializar as leituras só
    // faria o nó piscar em duas etapas a cada mudança vinda do CLI.
    const [nextBoard, nextBook] = await Promise.all([
      window.atelier.todo.read(wsId, file),
      window.atelier.plans.read(wsId, file)
    ])
    setBoard(nextBoard)
    setBook(nextBook)
    setLoaded(true)
  }, [wsId, file])

  useEffect(() => {
    void reload()
  }, [reload])

  // O agente mexeu no quadro pelo CLI. Sem isto o nó mostraria o quadro de antes
  // até alguém tocar nele — e ver o cartão andar sozinho é o ponto da feature.
  useEffect(() => {
    return window.atelier.todo.onChanged((p) => {
      if (p.nodeId === nodeId) void reload()
    })
  }, [nodeId, reload])

  /**
   * A largura decide a vista EXIBIDA, e nunca a gravada. `ResizeObserver` em vez
   * de media query porque quem muda de tamanho é o nó, não a janela.
   */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < LIST_BREAKPOINT))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  /** O significado de cada coluna, calculado uma vez por quadro e não por cartão. */
  const kinds: Record<string, TaskStatusKind> = useMemo(
    () => (board ? columnKinds(board.columns) : {}),
    [board]
  )

  const run = async (op: unknown): Promise<void> => {
    if (!wsId || !file) return
    const result = await window.atelier.todo.apply(wsId, file, op)
    if ('error' in result) {
      store.showNotice(result.error)
      // Relê mesmo no erro: o quadro em memória pode estar velho, e é
      // justamente por isso que a operação foi recusada.
      void reload()
      return
    }
    setBoard(result.board)
  }

  /** Escrita no livro de planos. Mesma disciplina: operação, nunca o arquivo. */
  const runPlan = async (op: unknown): Promise<{ planId: string } | null> => {
    if (!wsId || !file) return null
    const result = await window.atelier.plans.apply(wsId, file, op)
    if ('error' in result) {
      store.showNotice(result.error)
      void reload()
      return null
    }
    setBook(result.book)
    return result.plan ? { planId: result.plan.id } : null
  }

  const add = (): void => {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    void run({ type: 'add', title })
  }

  /**
   * Mover um cartão — e a única regra de negócio que a UI carrega sozinha.
   *
   * Concluir uma Tarefa cujo Plano ativo ainda tem etapas abertas exige decisão
   * EXPLÍCITA: mover em silêncio deixaria o quadro dizendo "feito" e o Plano
   * dizendo "faltam três", que é a divergência que este painel existe para não
   * criar. A pergunta só aparece na entrada da coluna de concluídos, e nunca ao
   * tirar o cartão de lá.
   */
  const moveTo = (item: TodoItem, status: string): void => {
    const view = planView(book, item)
    if (kinds[status] === 'done' && kinds[item.status] !== 'done' && hasOpenSteps(view.snapshot)) {
      setPending({ id: item.id, status })
      return
    }
    void run({ type: 'move', id: item.id, status })
  }

  /**
   * Cria o Plano e aponta o cartão para ele — os passos 2, 3 e 4 do fluxo
   * "Adicionar Plano a uma Tarefa", em um gesto.
   *
   * Nasce `active`, e não `draft`: quem clica em "Adicionar plano" dentro do
   * cartão já está trabalhando nele, e só a partir de `active` o store deixa o
   * plano virar `completed` sozinho quando a última etapa é marcada.
   */
  const addPlan = async (item: TodoItem): Promise<void> => {
    const created = await runPlan({ type: 'create', taskId: item.id, title: item.title, status: 'active' })
    if (!created) return
    await run({ type: 'plan', id: item.id, planId: created.planId })
  }

  if (!loaded) return <div className="todo-empty">carregando…</div>

  // `null` depois de carregado é arquivo corrompido. O painel AVISA e não
  // escreve nada: o arquivo pode ser o trabalho de alguém, e abrir um quadro
  // vazio por cima dele o destruiria no primeiro cartão criado.
  if (!board) {
    return (
      <div className="todo-empty">
        <p>O arquivo deste quadro não pôde ser lido.</p>
        <p className="todo-hint">
          Ele não foi alterado. Conserte o JSON em <code>todos/{file}.json</code> e reabra o nó.
        </p>
      </div>
    )
  }

  const label = (status: string): string => TASK_STATUS_LABELS[kinds[status] ?? 'pending']

  const open = openId ? (board.items.find((i) => i.id === openId) ?? null) : null
  if (open) {
    const view = planView(book, open)
    return (
      <div className="todo" ref={ref}>
        <TaskDetail
          item={open}
          statusLabel={label(open.status)}
          plan={view.plan}
          version={view.version}
          versions={view.versions}
          events={view.events}
          snapshot={view.snapshot}
          onAddPlan={() => void addPlan(open)}
          onStepStatus={(stepId, status: PlanStepStatus) => {
            if (!view.plan) return
            void runPlan({ type: 'step', planId: view.plan.id, stepId, status })
          }}
          onClose={() => setOpenId(null)}
        />
      </div>
    )
  }

  const decide = pending ? (board.items.find((i) => i.id === pending.id) ?? null) : null
  const decideView = decide ? planView(book, decide) : null
  if (decide && pending && decideView?.snapshot) {
    return (
      <div className="todo" ref={ref}>
        <TaskDecision
          title={decide.title}
          snapshot={decideView.snapshot}
          onFinish={() => {
            setPending(null)
            void run({ type: 'move', id: decide.id, status: pending.status })
          }}
          onPause={() => {
            setPending(null)
            void (async () => {
              await run({ type: 'move', id: decide.id, status: pending.status })
              if (decideView.plan) {
                await runPlan({ type: 'status', planId: decideView.plan.id, status: 'paused' })
              }
            })()
          }}
          onCancel={() => setPending(null)}
        />
      </div>
    )
  }

  const showKanban = mode === 'kanban' && !narrow

  return (
    <div className="todo" ref={ref}>
      <div className="todo-bar">
        <input
          className="todo-input"
          placeholder="nova tarefa…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
            // O canvas escuta teclas globais; sem isto, digitar no campo
            // dispararia atalhos de ferramenta enquanto se escreve.
            e.stopPropagation()
          }}
        />
        <button type="button" className="icon-btn ghost-btn" onClick={add} title="Adicionar tarefa">
          <IconPlus size={14} />
        </button>
        <button
          type="button"
          className="todo-mode"
          onClick={() => onChangeMode(mode === 'kanban' ? 'list' : 'kanban')}
          title={
            narrow && mode === 'kanban'
              ? 'o nó está estreito demais para o kanban — alargue-o'
              : 'alternar entre quadro e lista'
          }
        >
          {mode === 'kanban' ? 'quadro' : 'lista'}
        </button>
      </div>

      {showKanban ? (
        <div className="todo-columns">
          {board.columns.map((col) => (
            <div
              key={col.id}
              className={dragging && dragging !== col.id ? 'todo-column is-target' : 'todo-column'}
              onDragOver={(e) => {
                // Sem o preventDefault o navegador recusa o drop e o cartão
                // volta sozinho para a coluna de origem.
                e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain')
                setDragging(null)
                const item = board.items.find((i) => i.id === id)
                if (item) moveTo(item, col.id)
              }}
            >
              <h5 className="todo-column-title">
                {col.title}
                <span className="todo-count">
                  {board.items.filter((i) => i.status === col.id).length}
                </span>
              </h5>
              {sorted(board, col.id).map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  statusLabel={label(item.status)}
                  snapshot={planView(book, item).snapshot}
                  onOpen={() => setOpenId(item.id)}
                  onDragStart={() => setDragging(col.id)}
                  onDragEnd={() => setDragging(null)}
                  onRemove={() => void run({ type: 'remove', id: item.id })}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <ul className="todo-list">
          {board.columns.map((col) => {
            const items = sorted(board, col.id)
            if (items.length === 0) return null
            const last = board.columns.at(-1)?.id
            return (
              <li key={col.id}>
                <h5 className="todo-column-title">{col.title}</h5>
                <ul className="todo-list-items">
                  {items.map((item) => (
                    <li key={item.id} className="todo-line">
                      {/* A caixa move para a ÚLTIMA coluna e de volta para a
                          primeira — é o gesto de duas posições que a lista
                          comporta. Reordenar entre colunas do meio é do kanban. */}
                      <input
                        type="checkbox"
                        checked={item.status === last}
                        onChange={(e) =>
                          moveTo(item, e.target.checked && last ? last : board.columns[0].id)
                        }
                      />
                      <button
                        type="button"
                        className={
                          item.status === last ? 'todo-line-title is-done' : 'todo-line-title'
                        }
                        onClick={() => setOpenId(item.id)}
                      >
                        {item.title}
                      </button>
                      <TaskSummary
                        item={item}
                        statusLabel={label(item.status)}
                        snapshot={planView(book, item).snapshot}
                      />
                      {item.assignee && <span className="todo-who">{item.assignee}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
          {board.items.length === 0 && <li className="todo-empty">nenhuma tarefa ainda</li>}
        </ul>
      )}
    </div>
  )
}

function sorted(board: TodoBoard, status: string): TodoItem[] {
  return board.items.filter((i) => i.status === status).sort((a, b) => a.order - b.order)
}

function Card({
  item,
  statusLabel,
  snapshot,
  onOpen,
  onDragStart,
  onDragEnd,
  onRemove
}: {
  item: TodoItem
  statusLabel: string
  snapshot: ReturnType<typeof planView>['snapshot']
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div
      className="todo-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      // O canvas trata mousedown na bolha: sem parar aqui, arrastar um cartão
      // também viraria retângulo de seleção no canvas de baixo.
      onMouseDown={(e) => e.stopPropagation()}
      // Clique abre o painel expandido; o arrasto continua sendo o gesto de
      // mover, e um não atrapalha o outro porque `click` só dispara sem arrasto.
      onClick={onOpen}
      title={item.notes || undefined}
    >
      <span className="todo-card-title">{item.title}</span>
      <TaskSummary item={item} statusLabel={statusLabel} snapshot={snapshot} />
      {item.assignee && <span className="todo-who">{item.assignee}</span>}
      {/* Apagar é do USUÁRIO, e só aqui: o CLI não tem `delete`, pela mesma
          linha do cofre — o agente cria, mas não destrói. */}
      <button
        type="button"
        className="icon-btn ghost-btn todo-remove"
        title="Excluir tarefa"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        <IconTrash size={12} />
      </button>
    </div>
  )
}
