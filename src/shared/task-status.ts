/**
 * A camada de MAPEAMENTO entre o kanban do usuário e a linguagem de Tarefas.
 *
 * ─── Por que isto não é um enum de status ───
 *
 * O quadro deste app não é um checklist: as colunas são do usuário, ele as cria
 * e renomeia, e `TodoItem.status` é o `id` de uma dessas colunas. Impor cinco
 * status fixos ("pending", "in_progress", …) quebraria todo workspace que já
 * tem as suas colunas — e o `atelier todo move "Quadro" <id> <status>`, que
 * endereça a coluna pelo id, pararia de funcionar no dia da atualização.
 *
 * Então o status do domínio de Tarefas vira uma LEITURA da coluna, não uma
 * substituição dela: `columnKind` olha o id e o título e responde "isto parece
 * uma coluna de pendentes / em andamento / bloqueadas / concluídas /
 * canceladas". É o suficiente para a UI escolher ícone, cor e o rótulo em
 * português, e não custa nada a quem tem sete colunas em alemão.
 *
 * Heurística erra — e errar aqui é barato: o pior caso é um ícone diferente do
 * que a pessoa esperava, nunca um cartão no lugar errado. Nada aqui escreve.
 *
 * Módulo puro e sem dependências: roda no main, no renderer e nos testes.
 */
import type {
  Plan,
  PlanStatus,
  PlanStatusSnapshot,
  PlanStepStatus,
  PlanVersion,
  TaskOrigin,
  TaskOriginType,
  TodoColumn
} from './types'
import { TASK_ORIGIN_TYPES } from './types'

/**
 * O que uma coluna SIGNIFICA. Note que isto nunca é persistido: o que se grava
 * continua sendo o id da coluna.
 */
export type TaskStatusKind = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled'

export const TASK_STATUS_KINDS: TaskStatusKind[] = [
  'pending',
  'in_progress',
  'blocked',
  'done',
  'cancelled'
]

// ─── Rótulos (a tabela "Linguagem" do plano) ─────────────────────────────────

export const TASK_STATUS_LABELS: Record<TaskStatusKind, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  blocked: 'Bloqueada',
  done: 'Concluída',
  cancelled: 'Cancelada'
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: 'Rascunho',
  active: 'Ativo',
  paused: 'Pausado',
  completed: 'Concluído',
  abandoned: 'Abandonado'
}

export const PLAN_STEP_STATUS_LABELS: Record<PlanStepStatus, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  done: 'Concluída',
  blocked: 'Bloqueada',
  skipped: 'Ignorada'
}

/**
 * Nome do provedor, e não do campo. A UI mostra "Jira", nunca `jira` — e mostra
 * SÓ isto quando a origem vem incompleta (sem id, sem url), porque o provedor é
 * a única parte em que dá para confiar.
 */
export const TASK_ORIGIN_LABELS: Record<TaskOriginType, string> = {
  manual: 'Manual',
  jira: 'Jira',
  slack: 'Slack',
  github: 'GitHub',
  email: 'E-mail',
  api: 'API'
}

// ─── Coluna → significado ────────────────────────────────────────────────────

/** Sem acentos e sem separadores: "Em Andamento" e "em-andamento" viram o mesmo. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * A ordem importa: uma coluna "Concluído (bloqueado antes)" é rara, mas
 * "cancelado" precisa vencer "feito" e "bloqueado" precisa vencer "pendente",
 * porque quem escreve "Bloqueado / a fazer" quer dizer bloqueado.
 */
const PATTERNS: [TaskStatusKind, RegExp][] = [
  ['cancelled', /\b(cancel\w*|descart\w*|arquiv\w*|abandon\w*|recus\w*|wontfix|won t fix)\b/],
  ['blocked', /\b(block\w*|bloque\w*|imped\w*|travad\w*|espera\w*|aguard\w*|hold|waiting|paus\w*)\b/],
  ['done', /\b(done|feito|feita|conclu\w*|finaliz\w*|pronto|prontas?|complet\w*|encerrad\w*|entregue|shipped|closed)\b/],
  [
    'in_progress',
    /\b(doing|progress\w*|andamento|fazendo|executando|em curso|wip|review|revisao|teste|testing|ativo)\b/
  ],
  ['pending', /\b(todo|to do|a fazer|fazer|pendente\w*|backlog|ideias?|novo|nova|aberto|aberta|entrada|inbox)\b/]
]

/**
 * O significado de uma coluna.
 *
 * `index` e `total` existem para o caso em que o nome não diz nada — "Coluna 3",
 * "Fase B". Aí vale a convenção do quadro: a ÚLTIMA coluna é a de concluídos (é
 * a mesma regra que `atelier todo done` já usa para saber para onde mover), e
 * qualquer outra é pendente. Passar só a coluna, sem posição, desliga essa
 * parte e devolve `pending` para nomes desconhecidos.
 */
export function columnKind(column: TodoColumn, index = -1, total = -1): TaskStatusKind {
  const text = `${normalize(column.title)} ${normalize(column.id)}`
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) return kind
  }
  if (total > 1 && index === total - 1) return 'done'
  return 'pending'
}

/** O mapa inteiro do quadro, para a UI não repetir a heurística por cartão. */
export function columnKinds(columns: TodoColumn[]): Record<string, TaskStatusKind> {
  const out: Record<string, TaskStatusKind> = {}
  columns.forEach((c, n) => {
    out[c.id] = columnKind(c, n, columns.length)
  })
  return out
}

/** O rótulo em português da coluna, para resumo e tooltip. */
export function columnLabel(column: TodoColumn, index = -1, total = -1): string {
  return TASK_STATUS_LABELS[columnKind(column, index, total)]
}

// ─── Progresso derivado ──────────────────────────────────────────────────────

/** O status VIVO da etapa: o mapa do plano vence o declarado na versão. */
export function stepStatus(plan: Plan, stepId: string, declared: PlanStepStatus): PlanStepStatus {
  const live = plan.stepStatus[stepId]
  return live ?? declared
}

/**
 * O progresso do plano, calculado agora.
 *
 * Três regras que parecem detalhe e não são:
 *
 *  - `skipped` NÃO conta como concluída. Pular uma etapa é uma decisão, não um
 *    trabalho feito; contá-la faria um plano abandonado pela metade aparecer
 *    como 100%.
 *  - plano sem etapas dá `0`, e nunca `NaN` — `0/0` vazaria "NaN%" para a tela.
 *  - o percentual é ARREDONDADO para baixo (`floor`): três etapas com uma feita
 *    dão 33%, e não 33.33%. Arredondar para cima mostraria 100% com uma etapa
 *    ainda aberta, que é a única mentira que o número não pode contar.
 */
export function planSnapshot(
  plan: Plan,
  version: PlanVersion | null,
  now = new Date()
): PlanStatusSnapshot {
  const steps = version && version.planId === plan.id ? version.content.steps : []
  let completed = 0
  let blocked = 0
  let skipped = 0
  for (const step of steps) {
    const status = stepStatus(plan, step.id, step.status)
    if (status === 'done') completed++
    else if (status === 'blocked') blocked++
    else if (status === 'skipped') skipped++
  }
  const total = steps.length
  const percent = total > 0 ? Math.floor((completed / total) * 100) : 0
  return {
    planId: plan.id,
    versionId: version && version.planId === plan.id ? version.id : '',
    totalSteps: total,
    completedSteps: completed,
    blockedSteps: blocked,
    skippedSteps: skipped,
    // Guarda contra o impossível: percentual fora de 0..100 vira 0, que é o que
    // a tabela de falhas do plano pede ("progresso inválido → exibir 0%").
    progressPercent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : 0,
    lastActivityAt: plan.updatedAt || null,
    computedAt: now.toISOString()
  }
}

/** Há impedimento? É o que faz a UI mostrar o cartão como travado. */
export function isBlocked(snapshot: PlanStatusSnapshot): boolean {
  return snapshot.blockedSteps > 0
}

/**
 * Todas as etapas resolvidas, com pelo menos uma de fato feita — a condição para
 * o plano poder virar `completed`. Um plano cujas etapas foram TODAS puladas não
 * foi concluído: foi desistido, e chamar isso de concluído seria mentira.
 */
export function isFinished(plan: Plan, version: PlanVersion | null): boolean {
  const steps = version && version.planId === plan.id ? version.content.steps : []
  if (steps.length === 0) return false
  let done = 0
  for (const step of steps) {
    const status = stepStatus(plan, step.id, step.status)
    if (status === 'done') done++
    else if (status !== 'skipped') return false
  }
  return done > 0
}

// ─── Dados de terceiro ───────────────────────────────────────────────────────

/**
 * A origem de um cartão criado à mão. Manual é EXPLÍCITO — a tabela de origens
 * do plano é clara nisso, e a razão é prática: ausência de origem passa a
 * significar "cartão de antes desta feature, ainda não migrado", e essas duas
 * coisas precisam ser distinguíveis para a migração saber o que fazer.
 */
export function manualOrigin(at: string | null = null): TaskOrigin {
  return {
    type: 'manual',
    externalId: null,
    externalUrl: null,
    sourceName: null,
    importedAt: at || null,
    metadata: null
  }
}

/**
 * Normaliza uma origem vinda de fora — arquivo, IPC, adaptador de integração.
 *
 * Tipo desconhecido cai em `api`, e não em `manual`: um cartão que veio de um
 * provedor que este app ainda não conhece continua sendo importado, e chamá-lo
 * de manual mentiria sobre quem o criou. Campos que não são string viram `null`
 * em vez de vazar `undefined` para a tela.
 *
 * `metadata` atravessa INTEIRO, com campos desconhecidos e tudo: o que sobra
 * aqui é o que uma integração futura vai querer ler, e truncar no
 * armazenamento perderia dado que a tela apenas não mostra (ver
 * `metadataForDisplay`).
 */
export function normalizeOrigin(raw: unknown): TaskOrigin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  const type = typeof data.type === 'string' && TASK_ORIGIN_TYPES.includes(data.type as TaskOriginType)
    ? (data.type as TaskOriginType)
    : 'api'
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const metadata =
    !!data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : null
  return {
    type,
    externalId: text(data.externalId),
    externalUrl: text(data.externalUrl),
    sourceName: text(data.sourceName),
    importedAt: text(data.importedAt),
    metadata
  }
}

/**
 * O resumo da origem para a linha do cartão: "Jira · PROJ-123".
 *
 * Origem INCOMPLETA mostra só o provedor — é a única parte confiável quando o
 * adaptador não mandou id nem nome. Origem manual devolve string vazia: dizer
 * "Manual" em todo cartão do quadro seria ruído em 100% das linhas.
 */
export function originSummary(origin: TaskOrigin | null): string {
  if (!origin || origin.type === 'manual') return ''
  const label = TASK_ORIGIN_LABELS[origin.type]
  const detail = origin.externalId ?? origin.sourceName
  return detail ? `${label} · ${detail}` : label
}

/**
 * A URL da origem externa, se for segura de clicar. `null` significa "renderize
 * como TEXTO".
 *
 * Isto não é firula: `externalUrl` vem de um Jira, de um webhook, de um arquivo
 * que alguém editou à mão. Um `javascript:` ou um `file:` num link do canvas é
 * execução de código de terceiro dentro do app; um `data:` é uma página inteira
 * fingindo ser um ticket. Só `http` e `https`, e só com host — o resto vira
 * texto, que é inofensivo e ainda deixa a pessoa ver o que estava lá.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return url.toString()
  } catch {
    return null
  }
}

export function isSafeExternalUrl(value: unknown): boolean {
  return safeExternalUrl(value) !== null
}

/**
 * `metadata` para EXIBIR — nunca para gravar.
 *
 * O armazenamento preserva o que veio; a tela não. Um campo `description` de um
 * ticket do Jira tem 40 KB de HTML, e jogá-lo num detalhe do nó trava o
 * renderer. Trunca valor a valor e limita a quantidade de chaves, mantendo a
 * ordem original para a leitura não embaralhar a cada render.
 */
export function metadataForDisplay(
  metadata: Record<string, unknown> | null,
  maxKeys = 12,
  maxChars = 200
): { key: string; value: string; truncated: boolean }[] {
  if (!metadata) return []
  return Object.entries(metadata)
    .slice(0, maxKeys)
    .map(([key, raw]) => {
      let value: string
      try {
        value = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw)
      } catch {
        // Referência circular vinda de um adaptador mal escrito não pode
        // derrubar o painel inteiro.
        value = '…'
      }
      const truncated = value.length > maxChars
      return { key, value: truncated ? `${value.slice(0, maxChars)}…` : value, truncated }
    })
}
