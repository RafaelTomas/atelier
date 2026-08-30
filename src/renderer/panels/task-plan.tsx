/**
 * A leitura de Tarefa sobre o cartão do quadro — resumo, Plano e timeline.
 *
 * ─── Por que isto é só LEITURA do kanban ───
 *
 * Não existe entidade `Task` paralela ao cartão. `TodoItem.status` continua
 * sendo o id de uma coluna que o usuário criou, e a coluna continua mandando no
 * status. O que este arquivo desenha é a camada de cima: `columnKind` responde
 * "esta coluna parece de pendentes / em andamento / concluídas", e daí saem
 * rótulo e cor. Quem tem sete colunas em alemão não perde nada; quem tem três
 * em português ganha o vocabulário do plano de graça.
 *
 * ─── Componentes sem store, de propósito ───
 *
 * Tudo aqui recebe por prop e devolve por callback: nada lê `store`, nada chama
 * IPC. É o que permite `scripts/test-task-ui.mjs` renderizar estas mesmas
 * funções com `react-dom/server` e conferir o que a tela DIZ — que é onde as
 * regras sutis (progresso derivado, URL insegura virando texto, histórico em
 * ordem decrescente) morrem em silêncio quando quebram.
 *
 * Quem tem estado e IPC é `todo-panel.tsx`.
 */
import type {
  Plan,
  PlanBook,
  PlanStatusEvent,
  PlanStatusSnapshot,
  PlanStep,
  PlanStepStatus,
  PlanVersion,
  TaskOrigin,
  TodoItem
} from '@shared/types'
import { PLAN_STEP_STATUSES } from '@shared/types'
import {
  metadataForDisplay,
  originSummary,
  PLAN_EVENT_LABELS,
  PLAN_STATUS_LABELS,
  PLAN_STEP_STATUS_LABELS,
  planSnapshot,
  safeExternalUrl,
  stepStatus,
  TASK_ORIGIN_LABELS
} from '@shared/task-status'

/** Quantos eventos a timeline mostra. Ela é atividade RECENTE, não auditoria. */
const RECENT_EVENTS = 12

/**
 * Tudo o que o painel precisa saber sobre o Plano de um cartão, num objeto só.
 *
 * As mesmas consultas existem em `core/todo/plan-store.ts`, e não dá para
 * reusá-las: aquele módulo abre `node:fs` para ler e gravar o arquivo, e o
 * renderer não tem — nem deve ter — acesso a disco. O que se repete aqui são
 * quatro `find`/`filter` sobre um livro já lido; o que NÃO se repete é a regra,
 * porque o progresso continua saindo de `planSnapshot` e a ordem decrescente do
 * histórico continua sendo a mesma decisão escrita lá.
 */
export interface TaskPlanView {
  plan: Plan | null
  /** `null` com `plan` presente é o plano INCONSISTENTE — ver `TaskDetail`. */
  version: PlanVersion | null
  versions: PlanVersion[]
  events: PlanStatusEvent[]
  snapshot: PlanStatusSnapshot | null
}

export function planView(book: PlanBook | null, item: TodoItem): TaskPlanView {
  const empty: TaskPlanView = { plan: null, version: null, versions: [], events: [], snapshot: null }
  if (!book || !item.activePlanId) return empty
  const plan = book.plans.find((p) => p.id === item.activePlanId && p.taskId === item.id) ?? null
  if (!plan) return empty

  const version = plan.currentVersionId
    ? (book.versions.find((v) => v.id === plan.currentVersionId && v.planId === plan.id) ?? null)
    : null
  return {
    plan,
    version,
    versions: book.versions
      .filter((v) => v.planId === plan.id)
      .sort((a, b) => b.versionNumber - a.versionNumber),
    events: book.events
      .filter((e) => e.planId === plan.id)
      .slice(-RECENT_EVENTS)
      .reverse(),
    snapshot: planSnapshot(plan, version)
  }
}

/**
 * Há trabalho em aberto no Plano? É o gatilho da decisão explícita ao concluir a
 * Tarefa. Etapa `skipped` NÃO está em aberto: pular foi a decisão.
 */
export function hasOpenSteps(snapshot: PlanStatusSnapshot | null): boolean {
  if (!snapshot || snapshot.totalSteps === 0) return false
  return snapshot.completedSteps + snapshot.skippedSteps < snapshot.totalSteps
}

/**
 * Prioridade sai das TAGS, e não de um campo novo.
 *
 * O plano pede "prioridade, se existir", e o cartão não tem esse campo — nem vai
 * ter nesta entrega: acrescentá-lo ao `TodoItem` mudaria o arquivo do quadro, o
 * CLI e o decoder do app nativo por causa de uma linha de resumo. Tag é o que o
 * usuário já usa para isso hoje, e ler dali não obriga ninguém a nada: quem não
 * marca prioridade simplesmente não vê a pílula.
 */
const PRIORITIES: [RegExp, string][] = [
  [/^(urgente|urgent|p0)$/i, 'Urgente'],
  [/^(alta|alto|high|p1)$/i, 'Alta'],
  [/^(m[eé]dia|medium|p2)$/i, 'Média'],
  [/^(baixa|baixo|low|p3)$/i, 'Baixa']
]

export function priorityOf(item: TodoItem): string | null {
  for (const tag of item.tags) {
    for (const [re, label] of PRIORITIES) {
      if (re.test(tag)) return label
    }
  }
  return null
}

/**
 * O progresso do plano em texto — `Plano 60%`, ou `Plano —` quando o plano está
 * inconsistente.
 *
 * O número vem SEMPRE do snapshot derivado, nunca de um campo guardado: um
 * percentual persistido diverge no primeiro arquivo editado à mão e passa a
 * mentir sem produzir erro nenhum.
 */
function progressText(snapshot: PlanStatusSnapshot | null): string {
  if (!snapshot || snapshot.versionId === '') return 'Plano —'
  return `Plano ${snapshot.progressPercent}%`
}

interface SummaryProps {
  item: TodoItem
  /** O rótulo pt-BR da COLUNA em que o cartão está — ver `columnLabel`. */
  statusLabel: string
  snapshot: PlanStatusSnapshot | null
}

/**
 * A linha compacta do cartão: `Jira · Em andamento · Plano 60%`.
 *
 * Origem manual não entra — `originSummary` devolve vazio para ela, e dizer
 * "Manual" em todo cartão seria ruído em 100% das linhas do quadro.
 */
export function TaskSummary({ item, statusLabel, snapshot }: SummaryProps): JSX.Element {
  const origin = originSummary(item.origin)
  const priority = priorityOf(item)
  const blocked = !!snapshot && snapshot.blockedSteps > 0

  return (
    <span className="task-meta">
      {origin && <span className="task-chip is-origin">{origin}</span>}
      <span className="task-chip">{statusLabel}</span>
      {priority && <span className="task-chip is-priority">{priority}</span>}
      {item.activePlanId && (
        <span className={blocked ? 'task-chip is-blocked' : 'task-chip is-plan'}>
          {progressText(snapshot)}
        </span>
      )}
    </span>
  )
}

/**
 * A barra de progresso. `aria-valuenow` além do texto porque a barra é a única
 * parte do resumo que um leitor de tela não conseguiria narrar sozinho.
 */
function Progress({ snapshot }: { snapshot: PlanStatusSnapshot }): JSX.Element {
  return (
    <div className="task-progress">
      <div
        className="task-progress-track"
        role="progressbar"
        aria-valuenow={snapshot.progressPercent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="task-progress-fill" style={{ width: `${snapshot.progressPercent}%` }} />
      </div>
      <span className="task-progress-text">
        {snapshot.progressPercent}% · {snapshot.completedSteps}/{snapshot.totalSteps} etapas
        {snapshot.skippedSteps > 0 ? ` · ${snapshot.skippedSteps} ignorada(s)` : ''}
      </span>
    </div>
  )
}

/**
 * A origem externa. O link só existe se `safeExternalUrl` deixar.
 *
 * Isto não é estética: `externalUrl` veio de um Jira, de um webhook ou de um
 * arquivo que alguém editou à mão, e um `javascript:` num link do canvas é
 * execução de código de terceiro dentro do app. Reprovado, o endereço aparece
 * como TEXTO — inofensivo, e ainda deixa a pessoa ver o que estava lá.
 */
function Origin({ origin }: { origin: TaskOrigin }): JSX.Element {
  const href = safeExternalUrl(origin.externalUrl)
  const detail = origin.externalId ?? origin.sourceName
  const fields = metadataForDisplay(origin.metadata)

  return (
    <div className="task-origin">
      <span className="task-origin-name">{TASK_ORIGIN_LABELS[origin.type]}</span>
      {/* Origem incompleta mostra só o provedor: sem id e sem nome, é a única
          parte em que dá para confiar. */}
      {detail && <span className="task-origin-id">{detail}</span>}
      {origin.externalUrl &&
        (href ? (
          <a className="task-origin-link" href={href} target="_blank" rel="noreferrer noopener">
            {href}
          </a>
        ) : (
          <span className="task-origin-unsafe" title="endereço recusado — não é http(s)">
            {origin.externalUrl}
          </span>
        ))}
      {fields.length > 0 && (
        <dl className="task-origin-meta">
          {fields.map((f) => (
            <div key={f.key} className="task-origin-field">
              <dt>{f.key}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function Step({
  step,
  status,
  editable,
  onStatus
}: {
  step: PlanStep
  status: PlanStepStatus
  editable: boolean
  onStatus: (status: PlanStepStatus) => void
}): JSX.Element {
  return (
    <li className={`task-step is-${status}`}>
      <span className="task-step-order">{step.order}</span>
      <span className="task-step-body">
        <span className="task-step-title">{step.title}</span>
        {step.description && <span className="task-step-desc">{step.description}</span>}
      </span>
      {editable ? (
        <select
          className="task-step-status"
          value={status}
          aria-label={`status da etapa ${step.title}`}
          onChange={(e) => onStatus(e.target.value as PlanStepStatus)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {PLAN_STEP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PLAN_STEP_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      ) : (
        <span className="task-step-frozen">{PLAN_STEP_STATUS_LABELS[status]}</span>
      )}
    </li>
  )
}

interface DetailProps {
  item: TodoItem
  statusLabel: string
  plan: Plan | null
  /** A versão ATUAL. `null` com plano presente significa plano inconsistente. */
  version: PlanVersion | null
  /** Todas as versões do plano, da mais nova para a mais velha. */
  versions: PlanVersion[]
  events: PlanStatusEvent[]
  snapshot: PlanStatusSnapshot | null
  onAddPlan: () => void
  onStepStatus: (stepId: string, status: PlanStepStatus) => void
  onClose: () => void
}

/**
 * O painel expandido de uma Tarefa.
 *
 * Um plano com `currentVersionId` quebrado é mostrado como INCONSISTENTE e
 * perde as ações de edição. O painel não reaponta o ponteiro sozinho: escolher
 * uma versão por conta própria decidiria, no lugar do usuário, qual era a atual
 * — e o histórico que ele ainda pode consertar à mão iria junto.
 */
export function TaskDetail({
  item,
  statusLabel,
  plan,
  version,
  versions,
  events,
  snapshot,
  onAddPlan,
  onStepStatus,
  onClose
}: DetailProps): JSX.Element {
  const broken = !!plan && !version
  const priority = priorityOf(item)
  const steps = version ? [...version.content.steps].sort((a, b) => a.order - b.order) : []
  const blocked = !!snapshot && snapshot.blockedSteps > 0

  return (
    <div className="task-detail" onMouseDown={(e) => e.stopPropagation()}>
      <div className="task-detail-head">
        <h4 className="task-detail-title">{item.title}</h4>
        <button type="button" className="task-back" onClick={onClose} title="Voltar ao quadro">
          voltar
        </button>
      </div>

      <div className="task-detail-meta">
        <span className="task-chip">{statusLabel}</span>
        {priority && <span className="task-chip is-priority">{priority}</span>}
        {item.assignee && <span className="task-chip">{item.assignee}</span>}
      </div>

      {item.notes && <p className="task-notes">{item.notes}</p>}

      {item.origin && item.origin.type !== 'manual' && (
        <section className="task-section">
          <h5 className="task-section-title">Origem</h5>
          <Origin origin={item.origin} />
        </section>
      )}

      <section className="task-section">
        <h5 className="task-section-title">Plano</h5>

        {!plan && (
          <div className="task-noplan">
            <p className="task-quiet">Esta Tarefa ainda não tem Plano.</p>
            <button type="button" className="btn is-primary task-add-plan" onClick={onAddPlan}>
              Adicionar plano
            </button>
          </div>
        )}

        {plan && (
          <>
            <div className="task-plan-head">
              <span className="task-plan-title">{plan.title}</span>
              <span className="task-chip">{PLAN_STATUS_LABELS[plan.status]}</span>
            </div>
            {plan.objective && <p className="task-plan-objective">{plan.objective}</p>}

            {broken && (
              <p className="task-warning">
                Plano inconsistente: a versão atual não existe mais neste arquivo. A edição está
                bloqueada até que o arquivo seja corrigido — nada será reapontado automaticamente.
              </p>
            )}

            {blocked && (
              <p className="task-warning is-blocked">
                {snapshot?.blockedSteps} etapa(s) bloqueada(s) — o Plano está impedido.
              </p>
            )}

            {snapshot && !broken && <Progress snapshot={snapshot} />}

            {steps.length > 0 && (
              <ul className="task-steps">
                {steps.map((step) => (
                  <Step
                    key={step.id}
                    step={step}
                    status={stepStatus(plan, step.id, step.status)}
                    editable={!broken}
                    onStatus={(s) => onStepStatus(step.id, s)}
                  />
                ))}
              </ul>
            )}
            {steps.length === 0 && !broken && <p className="task-quiet">Nenhuma etapa neste Plano.</p>}

            {version && version.content.risks.length > 0 && (
              <NoteList title="Riscos" items={version.content.risks} />
            )}
            {version && version.content.assumptions.length > 0 && (
              <NoteList title="Premissas" items={version.content.assumptions} />
            )}
            {version && version.content.dependencies.length > 0 && (
              <NoteList title="Dependências" items={version.content.dependencies} />
            )}
          </>
        )}
      </section>

      {plan && versions.length > 0 && (
        <section className="task-section">
          <h5 className="task-section-title">Histórico de versões</h5>
          {/* Decrescente: a versão de agora é a que se procura, e as antigas só
              interessam para comparar com ela. */}
          <ol className="task-versions">
            {versions.map((v) => (
              <li
                key={v.id}
                className={
                  v.id === plan.currentVersionId ? 'task-version is-current' : 'task-version'
                }
              >
                <span className="task-version-n">v{v.versionNumber}</span>
                <span className="task-version-body">
                  <span className="task-version-summary">
                    {v.changeSummary ?? `${v.content.steps.length} etapa(s)`}
                  </span>
                  <span className="task-version-when">{when(v.createdAt)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {plan && events.length > 0 && (
        <section className="task-section">
          <h5 className="task-section-title">Atividade recente</h5>
          <ol className="task-events">
            {events.map((e) => (
              <li key={e.id} className="task-event">
                {/* `type` desconhecido cai cru na tela: ele pode ter vindo de uma
                    versão mais nova do app, e sumir com a linha esconderia
                    auditoria que o arquivo preservou de propósito. */}
                <span className="task-event-what">{PLAN_EVENT_LABELS[e.type] ?? e.type}</span>
                <span className="task-event-when">{when(e.createdAt)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

function NoteList({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="task-notelist">
      <h6 className="task-section-title">{title}</h6>
      <ul className="task-notelist-items">
        {items.map((text, n) => (
          <li key={`${n}-${text}`}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

/** Data curta, e o ISO cru quando o campo veio vazio ou ilegível de um arquivo. */
function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || '—'
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

interface DecisionProps {
  title: string
  snapshot: PlanStatusSnapshot
  onFinish: () => void
  onPause: () => void
  onCancel: () => void
}

/**
 * A decisão explícita que o plano exige ao concluir uma Tarefa cujo Plano ativo
 * ainda tem etapas abertas.
 *
 * Inline, e não um modal: o gesto que a disparou foi arrastar um cartão dentro
 * de um nó, e uma folha no meio da tela para perguntar sobre ele seria
 * desproporcional. Não há opção "concluir o Plano junto" de propósito — marcar
 * como concluído um plano com etapas abertas seria gravar uma mentira; pausar
 * diz a verdade e é reversível.
 */
export function TaskDecision({
  title,
  snapshot,
  onFinish,
  onPause,
  onCancel
}: DecisionProps): JSX.Element {
  const open = snapshot.totalSteps - snapshot.completedSteps - snapshot.skippedSteps
  return (
    <div className="task-decision" onMouseDown={(e) => e.stopPropagation()}>
      <p className="task-decision-text">
        <strong>{title}</strong> tem {open} etapa(s) em aberto no Plano ativo. Como quer concluir?
      </p>
      <div className="task-decision-actions">
        <button type="button" className="btn is-primary" onClick={onFinish}>
          Concluir assim mesmo
        </button>
        <button type="button" className="btn" onClick={onPause}>
          Concluir e pausar o Plano
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Voltar
        </button>
      </div>
    </div>
  )
}
