/**
 * Os planos de um quadro em disco, e as operações sobre eles.
 *
 * Um arquivo por nó, em `workspaces/<wsId>/plans/<contentId>.json`, ao lado do
 * quadro. Não entra no `todos/<contentId>.json` de propósito: o quadro é
 * reescrito a cada arrasto de cartão, e versões e eventos de plano crescem sem
 * limite — juntá-los faria cada cartão movido reescrever todo o histórico.
 *
 * ─── A escrita é uma OPERAÇÃO, nunca "grave este arquivo" ───
 *
 * Mesma disciplina de `todo-store.ts`, e pela mesma razão: dois agentes mexendo
 * no mesmo quadro é o caso NORMAL. Toda escrita é `apply(file, op)` — o main lê
 * o arquivo AGORA, aplica a operação sobre essa versão e grava, com uma fila por
 * arquivo serializando as chamadas. Gravação atômica (`tmp` + `rename`): um
 * crash no meio deixaria um JSON pela metade e levaria o histórico junto.
 *
 * ─── Imutabilidade, e o que ela obriga ───
 *
 * `PlanVersion` é imutável depois de criada. Isso decide o desenho inteiro:
 * marcar uma etapa como feita NÃO pode tocar a versão, senão cada clique em
 * checkbox criaria uma versão nova e o histórico viraria ruído. Então o status
 * vivo das etapas mora em `Plan.stepStatus`, um mapa por id de etapa, e o que a
 * versão guarda é o status DECLARADO quando aquela versão foi escrita.
 *
 * Mudança ESTRUTURAL (etapas add/remove/reorder, título, objetivo, riscos,
 * premissas, dependências, notas) cria versão. Status de etapa registra evento.
 * A fronteira entre as duas é a função `sameContent`.
 *
 * Eventos alimentam timeline e auditoria, e NUNCA são a fonte do estado atual:
 * o estado está no `Plan`, na `PlanVersion` e em `stepStatus`, e sobrevive a uma
 * lista de eventos truncada, perdida ou fora de ordem.
 *
 * Módulo sem `electron` — roda no smoke headless.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  Plan,
  PlanBook,
  PlanContent,
  PlanStatus,
  PlanStatusEvent,
  PlanStatusEventType,
  PlanStep,
  PlanStepStatus,
  PlanVersion
} from '@shared/types'
import { PLAN_STATUSES, PLAN_STEP_STATUSES } from '@shared/types'
import { isFinished } from '@shared/task-status'
import { uuid } from '../coding'

/**
 * Teto de eventos por arquivo. A timeline é histórico, não banco: sem teto, um
 * agente marcando etapas num laço faria o arquivo crescer para sempre e cada
 * leitura do painel pagaria por isso. Cortam-se os MAIS ANTIGOS, porque a
 * timeline é lida do fim para o começo.
 */
const MAX_EVENTS = 500

export function makeBook(): PlanBook {
  return { version: 1, plans: [], versions: [], events: [] }
}

export function emptyContent(): PlanContent {
  return { steps: [], assumptions: [], risks: [], dependencies: [], notes: null }
}

// ─── Leitura ──────────────────────────────────────────────────────────────────

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Objeto simples, ou `null`. Array não conta: `metadata` e `payload` são mapas. */
function record(v: unknown): Record<string, unknown> | null {
  return !!v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function stepStatusOf(v: unknown): PlanStepStatus {
  return (PLAN_STEP_STATUSES as string[]).includes(str(v)) ? (v as PlanStepStatus) : 'pending'
}

function parseStep(raw: Record<string, unknown>, n: number): PlanStep {
  return {
    // Etapa sem id ganha id aqui, na migração: sem id ela não teria como receber
    // status vivo nem aparecer num evento, e sumiria da timeline em silêncio.
    id: str(raw.id) || uuid(),
    title: str(raw.title) || 'Etapa sem título',
    description: optStr(raw.description),
    status: stepStatusOf(raw.status),
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : n + 1
  }
}

function parseContent(raw: unknown): PlanContent {
  const data = record(raw)
  if (!data) return emptyContent()
  const steps = Array.isArray(data.steps)
    ? data.steps
        .map((s) => record(s))
        .filter((s): s is Record<string, unknown> => s !== null)
        .map(parseStep)
    : []
  return {
    steps,
    assumptions: strList(data.assumptions),
    risks: strList(data.risks),
    dependencies: strList(data.dependencies),
    notes: optStr(data.notes)
  }
}

/**
 * Lê e CONSERTA o livro de planos, sem gravar — mesmo pudor do quadro.
 *
 * Três consertos que valem ser ditos:
 *
 *  - versão que aponta para OUTRO plano é descartada na leitura. Ela é lixo de
 *    arquivo mexido à mão, e mantê-la faria o histórico de um plano mostrar
 *    etapas de outro;
 *  - `currentVersionId` que não existe mais vira `null` em vez de ser
 *    reapontado para a última versão. `null` é lido como plano INCONSISTENTE, e
 *    a UI impede edição destrutiva — reapontar sozinho seria adivinhar qual
 *    versão o usuário considerava atual;
 *  - `stepStatus` com ids de etapas que não existem mais é mantido em memória
 *    mas ignorado no cálculo. Apagá-lo perderia o status de uma etapa que uma
 *    versão futura pode trazer de volta com o mesmo id.
 *
 * Devolve `null` quando o arquivo não é um livro de planos — o painel avisa e
 * NÃO sobrescreve, porque o arquivo pode ser o trabalho de alguém.
 */
export function parseBook(raw: string): PlanBook | null {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    const asRecord = record(parsed)
    if (!asRecord) return null
    data = asRecord
  } catch {
    return null
  }

  const plans: Plan[] = Array.isArray(data.plans)
    ? data.plans
        .map((p) => record(p))
        .filter((p): p is Record<string, unknown> => p !== null)
        .map((p) => {
          const live: Record<string, PlanStepStatus> = {}
          const rawLive = record(p.stepStatus)
          if (rawLive) {
            for (const [id, value] of Object.entries(rawLive)) {
              if ((PLAN_STEP_STATUSES as string[]).includes(str(value))) {
                live[id] = value as PlanStepStatus
              }
            }
          }
          return {
            id: str(p.id) || uuid(),
            taskId: str(p.taskId),
            title: str(p.title) || 'Plano sem título',
            objective: str(p.objective),
            status: (PLAN_STATUSES as string[]).includes(str(p.status))
              ? (p.status as PlanStatus)
              : 'draft',
            currentVersionId: optStr(p.currentVersionId),
            stepStatus: live,
            createdAt: str(p.createdAt),
            updatedAt: str(p.updatedAt)
          }
        })
        // Plano sem dono não tem onde ser visto: nenhum cartão o mostraria, e
        // ele só serviria para inflar o arquivo.
        .filter((p) => p.taskId !== '')
    : []

  const planIds = new Set(plans.map((p) => p.id))

  const versions: PlanVersion[] = Array.isArray(data.versions)
    ? data.versions
        .map((v) => record(v))
        .filter((v): v is Record<string, unknown> => v !== null)
        .map((v) => ({
          id: str(v.id) || uuid(),
          planId: str(v.planId),
          versionNumber:
            typeof v.versionNumber === 'number' && Number.isFinite(v.versionNumber)
              ? v.versionNumber
              : 1,
          content: parseContent(v.content),
          changeSummary: optStr(v.changeSummary),
          createdBy: optStr(v.createdBy),
          createdAt: str(v.createdAt)
        }))
        .filter((v) => planIds.has(v.planId))
    : []

  const versionIds = new Map(versions.map((v) => [v.id, v.planId]))
  for (const plan of plans) {
    // Ponteiro para versão inexistente, ou para versão de OUTRO plano.
    if (plan.currentVersionId && versionIds.get(plan.currentVersionId) !== plan.id) {
      plan.currentVersionId = null
    }
  }

  const events: PlanStatusEvent[] = Array.isArray(data.events)
    ? data.events
        .map((e) => record(e))
        .filter((e): e is Record<string, unknown> => e !== null)
        .map((e) => ({
          id: str(e.id) || uuid(),
          taskId: str(e.taskId),
          planId: str(e.planId),
          versionId: optStr(e.versionId),
          type: str(e.type) as PlanStatusEventType,
          payload: record(e.payload),
          createdAt: str(e.createdAt)
        }))
        // Evento de plano que não existe mais é ruído: o painel não teria onde
        // desenhá-lo. Um `type` desconhecido, porém, ATRAVESSA — ele pode ter
        // vindo de uma versão mais nova do app, e descartá-lo apagaria auditoria.
        .filter((e) => planIds.has(e.planId))
        .slice(-MAX_EVENTS)
    : []

  return {
    version: typeof data.version === 'number' ? data.version : 1,
    plans,
    versions,
    events
  }
}

export async function readBook(file: string): Promise<PlanBook | null> {
  try {
    return parseBook(await readFile(file, 'utf8'))
  } catch {
    // Arquivo ausente é um quadro que ainda não tem plano nenhum — diferente de
    // arquivo corrompido, que devolve null e faz o painel avisar.
    return makeBook()
  }
}

async function writeBook(file: string, book: PlanBook): Promise<void> {
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(tmp, JSON.stringify(book, null, 2), 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

// ─── Consultas ────────────────────────────────────────────────────────────────

export function planById(book: PlanBook, planId: string): Plan | null {
  return book.plans.find((p) => p.id === planId) ?? null
}

/** O plano ativo de um cartão. Vários planos por cartão é caso do futuro. */
export function planForTask(book: PlanBook, taskId: string): Plan | null {
  return book.plans.find((p) => p.taskId === taskId) ?? null
}

/**
 * A versão atual do plano, ou `null` quando o ponteiro está quebrado — que é o
 * sinal de "plano inconsistente", e não motivo para devolver a última versão
 * qualquer.
 */
export function currentVersion(book: PlanBook, plan: Plan): PlanVersion | null {
  if (!plan.currentVersionId) return null
  return book.versions.find((v) => v.id === plan.currentVersionId && v.planId === plan.id) ?? null
}

/** As versões daquele plano, da mais nova para a mais velha — ordem da UI. */
export function versionsOf(book: PlanBook, planId: string): PlanVersion[] {
  return book.versions.filter((v) => v.planId === planId).sort((a, b) => b.versionNumber - a.versionNumber)
}

/** Os eventos daquele plano, do mais novo para o mais velho. */
export function eventsOf(book: PlanBook, planId: string, limit = 20): PlanStatusEvent[] {
  return book.events
    .filter((e) => e.planId === planId)
    .slice(-limit)
    .reverse()
}

// ─── A fronteira entre "evento" e "versão nova" ──────────────────────────────

/**
 * Dois conteúdos são o MESMO plano?
 *
 * O `status` declarado das etapas fica de fora da comparação de propósito: ele
 * não é estrutura, é o retrato do momento em que a versão nasceu. Se entrasse,
 * uma revisão que só reordena etapas depois de duas terem sido concluídas
 * criaria diferença onde não há mudança de plano nenhuma.
 */
function sameContent(a: PlanContent, b: PlanContent): boolean {
  if (a.steps.length !== b.steps.length) return false
  for (let n = 0; n < a.steps.length; n++) {
    const x = a.steps[n]
    const y = b.steps[n]
    if (x.id !== y.id || x.title !== y.title || x.description !== y.description) return false
  }
  return (
    a.notes === b.notes &&
    sameList(a.assumptions, b.assumptions) &&
    sameList(a.risks, b.risks) &&
    sameList(a.dependencies, b.dependencies)
  )
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, n) => x === b[n])
}

/** Ordena e renumera as etapas: a ordem da lista É a ordem do plano. */
function normalizeSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((s, n) => ({ ...s, id: s.id || uuid(), order: n + 1 }))
}

// ─── Operações ────────────────────────────────────────────────────────────────

export type PlanOp =
  /** Cria o plano e a versão 1 num gesto só — plano sem versão é inconsistente. */
  | {
      type: 'create'
      taskId: string
      title: string
      objective?: string
      content?: Partial<PlanContent>
      createdBy?: string | null
      status?: PlanStatus
    }
  /** Mudança estrutural. Cria versão nova SE algo de fato mudou. */
  | {
      type: 'revise'
      planId: string
      title?: string
      objective?: string
      content?: Partial<PlanContent>
      changeSummary?: string | null
      createdBy?: string | null
    }
  /** Status vivo de uma etapa. Registra evento; NUNCA cria versão. */
  | { type: 'step'; planId: string; stepId: string; status: PlanStepStatus }
  /** Ciclo de vida do plano: rascunho → ativo → pausado → concluído. */
  | { type: 'status'; planId: string; status: PlanStatus }
  /** Apaga o plano, suas versões e seus eventos. Gesto do usuário, no nó. */
  | { type: 'remove'; planId: string }

export interface PlanOpResult {
  book: PlanBook
  plan?: Plan
  version?: PlanVersion
  error?: string
}

function makeEvent(
  type: PlanStatusEventType,
  plan: Plan,
  versionId: string | null,
  at: string,
  payload: Record<string, unknown> | null = null
): PlanStatusEvent {
  return { id: uuid(), taskId: plan.taskId, planId: plan.id, versionId, type, payload, createdAt: at }
}

function pushEvent(book: PlanBook, event: PlanStatusEvent): void {
  book.events.push(event)
  if (book.events.length > MAX_EVENTS) book.events = book.events.slice(-MAX_EVENTS)
}

const STEP_EVENTS: Partial<Record<PlanStepStatus, PlanStatusEventType>> = {
  in_progress: 'step_started',
  done: 'step_completed',
  blocked: 'step_blocked',
  skipped: 'step_skipped'
}

/**
 * Aplica a operação sobre o livro DADO, e devolve o livro novo.
 *
 * Função pura: quem lê e grava é `apply`. Separar as duas é o que torna as
 * regras (versionamento, imutabilidade, conclusão automática) testáveis sem
 * tocar disco.
 */
export function applyPlanOp(book: PlanBook, op: PlanOp, now = new Date()): PlanOpResult {
  const at = now.toISOString()
  const next: PlanBook = {
    ...book,
    plans: book.plans.map((p) => ({ ...p, stepStatus: { ...p.stepStatus } })),
    versions: [...book.versions],
    events: [...book.events]
  }

  switch (op.type) {
    case 'create': {
      if (!op.taskId) return { book, error: 'a plan needs a task' }
      if (next.plans.some((p) => p.taskId === op.taskId)) {
        // Um plano ativo por tarefa na primeira entrega. Criar o segundo em
        // silêncio deixaria o cartão apontando para um e mostrando o outro.
        return { book, error: `task ${op.taskId} already has a plan` }
      }
      const content: PlanContent = { ...emptyContent(), ...op.content }
      content.steps = normalizeSteps(content.steps ?? [])

      const plan: Plan = {
        id: uuid(),
        taskId: op.taskId,
        title: op.title || 'Plano sem título',
        objective: op.objective ?? '',
        status: op.status ?? 'draft',
        currentVersionId: null,
        stepStatus: {},
        createdAt: at,
        updatedAt: at
      }
      const version: PlanVersion = {
        id: uuid(),
        planId: plan.id,
        versionNumber: 1,
        content,
        changeSummary: null,
        createdBy: op.createdBy ?? null,
        createdAt: at
      }
      plan.currentVersionId = version.id

      next.plans.push(plan)
      next.versions.push(version)
      pushEvent(next, makeEvent('plan_created', plan, version.id, at))
      pushEvent(next, makeEvent('plan_version_created', plan, version.id, at, { versionNumber: 1 }))
      return { book: next, plan, version }
    }

    case 'revise': {
      const plan = next.plans.find((p) => p.id === op.planId)
      if (!plan) return { book, error: `no plan with id ${op.planId}` }
      const base = currentVersion(next, plan)
      if (!base) {
        // Plano inconsistente: sem versão atual, "revisar" não teria de onde
        // partir e a versão nova nasceria descolada do histórico.
        return { book, error: `plan ${plan.id} has no current version — fix the file first` }
      }

      const content: PlanContent = { ...base.content, ...op.content }
      content.steps = normalizeSteps(content.steps ?? base.content.steps)
      const titleChanged = op.title !== undefined && op.title !== plan.title
      const objectiveChanged = op.objective !== undefined && op.objective !== plan.objective

      if (sameContent(base.content, content) && !titleChanged && !objectiveChanged) {
        // Nada mudou. Criar versão aqui encheria o histórico de duplicatas —
        // salvar o mesmo texto duas vezes não é uma decisão nova.
        return { book, plan, version: base }
      }

      if (titleChanged) plan.title = op.title as string
      if (objectiveChanged) plan.objective = op.objective as string
      plan.updatedAt = at

      const version: PlanVersion = {
        id: uuid(),
        planId: plan.id,
        versionNumber: Math.max(0, ...versionsOf(next, plan.id).map((v) => v.versionNumber)) + 1,
        content,
        changeSummary: op.changeSummary ?? null,
        createdBy: op.createdBy ?? null,
        createdAt: at
      }
      next.versions.push(version)
      plan.currentVersionId = version.id
      pushEvent(
        next,
        makeEvent('plan_version_created', plan, version.id, at, {
          versionNumber: version.versionNumber
        })
      )
      return { book: next, plan, version }
    }

    case 'step': {
      const plan = next.plans.find((p) => p.id === op.planId)
      if (!plan) return { book, error: `no plan with id ${op.planId}` }
      const version = currentVersion(next, plan)
      if (!version) return { book, error: `plan ${plan.id} has no current version` }
      const step = version.content.steps.find((s) => s.id === op.stepId)
      if (!step) return { book, error: `no step with id ${op.stepId} in the current version` }
      if (!(PLAN_STEP_STATUSES as string[]).includes(op.status)) {
        return { book, error: `unknown step status '${op.status}'` }
      }

      // A versão NÃO é tocada: o status vivo mora no plano. É isto que faz
      // marcar uma etapa não criar versão nova.
      plan.stepStatus[op.stepId] = op.status
      plan.updatedAt = at

      const eventType = STEP_EVENTS[op.status]
      if (eventType) {
        pushEvent(
          next,
          makeEvent(eventType, plan, version.id, at, { stepId: op.stepId, title: step.title })
        )
      }

      // "Se todas as etapas estiverem done, o Plano PODE virar completed" — e
      // só a partir de `active`: um rascunho com etapas marcadas continua sendo
      // rascunho, e um plano pausado só volta por decisão de quem o pausou.
      if (plan.status === 'active' && isFinished(plan, version)) {
        plan.status = 'completed'
        pushEvent(next, makeEvent('plan_completed', plan, version.id, at))
      }
      return { book: next, plan, version }
    }

    case 'status': {
      const plan = next.plans.find((p) => p.id === op.planId)
      if (!plan) return { book, error: `no plan with id ${op.planId}` }
      if (!(PLAN_STATUSES as string[]).includes(op.status)) {
        return { book, error: `unknown plan status '${op.status}'` }
      }
      if (plan.status === op.status) return { book, plan }
      plan.status = op.status
      plan.updatedAt = at
      const eventType: PlanStatusEventType | null =
        op.status === 'active'
          ? 'plan_activated'
          : op.status === 'paused'
            ? 'plan_paused'
            : op.status === 'completed'
              ? 'plan_completed'
              : null
      if (eventType) pushEvent(next, makeEvent(eventType, plan, plan.currentVersionId, at))
      return { book: next, plan }
    }

    case 'remove': {
      const plan = next.plans.find((p) => p.id === op.planId)
      if (!plan) return { book, error: `no plan with id ${op.planId}` }
      next.plans = next.plans.filter((p) => p.id !== op.planId)
      next.versions = next.versions.filter((v) => v.planId !== op.planId)
      next.events = next.events.filter((e) => e.planId !== op.planId)
      return { book: next }
    }
  }
}

// ─── A fila por arquivo ───────────────────────────────────────────────────────

/**
 * Uma corrente de promessas por arquivo — a mesma de `todo-store.ts`, e pela
 * mesma razão: sem ela, dois `apply` simultâneos leriam o MESMO livro e o
 * segundo gravaria por cima do primeiro.
 */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(file) ?? Promise.resolve()
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
 * Um arquivo corrompido RECUSA a operação em vez de sobrescrever: ali está o
 * histórico inteiro dos planos daquele quadro, e criar um plano não é motivo
 * para descartá-lo.
 */
export function apply(file: string, op: PlanOp): Promise<PlanOpResult> {
  return enqueue(file, async () => {
    const book = await readBook(file)
    if (!book) {
      return { book: makeBook(), error: 'the plans file is corrupt — fix or remove it' }
    }
    const result = applyPlanOp(book, op)
    if (result.error) return result
    await writeBook(file, result.book)
    return result
  })
}

/** Leitura serializada com as escritas — nunca lê um arquivo em meio a um rename. */
export function read(file: string): Promise<PlanBook | null> {
  return enqueue(file, () => readBook(file))
}

/** Só para teste — a fila é global ao processo. */
export function resetQueues(): void {
  queues.clear()
}
