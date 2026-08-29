/**
 * Leitura de uso dos agentes — o bloco IA do monitor.
 *
 * Duas fontes, e a diferença entre elas é o assunto deste módulo:
 *
 *  - **`AgentUsage`** vem do próprio agente. O Claude Code roda um comando a
 *    cada mensagem nova e entrega um JSON no stdin (`statusLine`); `atelier
 *    statusline` é esse comando. Dado estruturado, na unidade certa, com o
 *    tamanho da janela de contexto e a hora de reset dos limites.
 *  - **`AgentStatus`** vem de `scanAgentStatus`, que raspa a tela. É o que
 *    sobra quando o agente não é Claude Code — Codex, Antigravity, OpenCode — e
 *    é por isso que ele não sai de cena.
 *
 * `mergeReading` junta as duas numa forma só, e a preferência é sempre da
 * publicada: `103 tok` raspado da tela não diz de que janela é.
 *
 * Módulo em `shared/` pelo mesmo motivo de `formatTokens`: funções puras sobre
 * tipos compartilhados, testáveis sem React e sem Electron. Quem produz é o
 * main (terminal/status-line), quem mostra é o renderer.
 *
 * ─── O que este módulo se recusa a fazer ───
 *
 * **Não soma tokens entre agentes.** Cada CLI conta o que quer chamar de token:
 * um imprime o contexto acumulado, outro entrada+saída da sessão. Somar
 * unidades diferentes produz um número errado com aparência de certo. Cada
 * agente aparece na SUA linha, com o número que ele mesmo publicou.
 *
 * **Custo, sim.** `costUsd` é dólar em todos os agentes, e `sumCost` existe
 * porque essa soma é a única honesta aqui — é a resposta para "quanto já
 * gastei" que tokens nunca deram.
 *
 * **Não trata duas leituras da mesma conta como dois agentes.** Entre agentes,
 * `aggregateLimits` tira o máximo; DENTRO de uma conta, `groupByAccount` fica
 * com a mais recente. O limite 5h/7d é um contador da conta, e o máximo entre
 * dois terminais que leem o mesmo contador só congela o valor mais velho.
 *
 * **Não inventa janela que ninguém publicou.** Quando não há `rate_limits` nem
 * `5h:80%` na tela, a célula fica vazia. Estimar a partir de tokens seria
 * fabricar justamente a métrica mais consultada do painel.
 */
import type { AgentStatus, AgentUsage, StoredAccountUsage } from './types'

/** Uma janela de limite agregada entre os agentes vivos. */
export interface UsageWindow {
  /** Como o agente a nomeia: `5h`, `7d`. */
  window: string
  /** O MAIOR percentual visto nesta janela, entre os agentes que a publicam. */
  pct: number
  /** Época em segundos, quando alguma fonte a publicou. */
  resetsAt: number | null
}

/** Qualquer coisa que carregue janelas de limite — as duas fontes carregam. */
interface HasLimits {
  limits: { window: string; pct: number; resetsAt?: number | null }[]
}

/**
 * O agregado do bloco IA: o máximo de cada janela de limite.
 *
 * Máximo, e não média nem soma, porque a pergunta real é "qual das minhas
 * janelas está mais apertada" — uma média entre um agente a 80% e outro a 0%
 * responderia 40% e esconderia exatamente o que interessa. Agentes que não
 * publicam a janela não entram no cálculo dela: eles não são um zero, são uma
 * ausência de leitura.
 *
 * A ordem de saída é a de PRIMEIRA APARIÇÃO, não alfabética: os CLIs publicam
 * `5h` antes de `7d`, e reordenar faria as colunas trocarem de lugar conforme
 * quem respondeu primeiro.
 *
 * O `resetsAt` acompanha o percentual VENCEDOR, não o menor de todos: o prazo
 * que interessa é o da janela que está apertando.
 */
export function aggregateLimits(sources: (HasLimits | undefined | null)[]): UsageWindow[] {
  const max = new Map<string, UsageWindow>()
  for (const source of sources) {
    if (!source?.limits) continue
    for (const { window, pct, resetsAt } of source.limits) {
      if (!Number.isFinite(pct)) continue
      const seen = max.get(window)
      if (seen === undefined || pct > seen.pct) {
        max.set(window, { window, pct, resetsAt: resetsAt ?? null })
      }
    }
  }
  return [...max.values()]
}

/**
 * Quantos agentes têm leitura. É o denominador honesto do bloco: um terminal de
 * shell puro nunca publica nada, e contá-lo como "agente sem uso" faria o
 * painel parecer mais vazio do que está.
 */
export function countReporting(statuses: (AgentStatus | undefined | null)[]): number {
  return statuses.filter((s) => s && (s.tokens !== null || s.limits.length > 0)).length
}

// ─── A leitura unificada ──────────────────────────────────────────────────────

/** O que a linha de um agente mostra, venha de onde vier. */
export interface AgentReading {
  /** Qual Claude está rodando. Só a fonte publicada sabe. */
  model: string | null
  tokens: number | null
  contextPct: number | null
  /** 200000 ou 1000000 — é o que dá sentido ao percentual. */
  contextWindowSize: number | null
  costUsd: number | null
  limits: { window: string; pct: number; resetsAt?: number | null }[]
  /**
   * Quando o agente publicou. `null` na leitura raspada — a tela não traz hora,
   * e inventar `Date.now()` aqui faria um número velho parecer recém-lido.
   *
   * Só a agregação POR CONTA usa este campo, e ela precisa dele: dois terminais
   * da mesma conta publicam o mesmo contador de limite em instantes diferentes,
   * e sem data não há como saber qual dos dois é o atual.
   */
  at: string | null
  /**
   * De onde veio. Vai para a UI: `screen` é uma leitura de segunda mão, e o
   * usuário merece saber quando está olhando para uma.
   */
  source: 'statusline' | 'screen' | 'none'
}

/**
 * A leitura publicada vence a raspada, campo a campo — nunca "a mais recente".
 *
 * Os dois canais correm ao mesmo tempo num terminal de Claude Code: o raspador
 * continua lendo a tela mesmo com a `statusLine` ativa. Deixar o mais recente
 * vencer faria os números oscilarem entre duas fontes de qualidade diferente a
 * cada frame do PTY.
 *
 * O raspado não é descartado quando é a ÚNICA coisa que existe para o campo:
 * antes da primeira chamada de API, `used_percentage` vem nulo, e nesse
 * intervalo o "3%" da tela é melhor que um traço.
 */
export function mergeReading(
  usage: AgentUsage | null | undefined,
  status: AgentStatus | null | undefined
): AgentReading {
  if (!usage) {
    return {
      model: null,
      tokens: status?.tokens ?? null,
      contextPct: status?.contextPct ?? null,
      contextWindowSize: null,
      costUsd: null,
      limits: status?.limits ?? [],
      at: null,
      source: status && (status.tokens !== null || status.limits.length > 0) ? 'screen' : 'none'
    }
  }
  return {
    model: usage.model,
    tokens: usage.inputTokens ?? status?.tokens ?? null,
    contextPct: usage.usedPercentage ?? status?.contextPct ?? null,
    contextWindowSize: usage.contextWindowSize,
    costUsd: usage.costUsd,
    limits: usage.limits.length > 0 ? usage.limits : (status?.limits ?? []),
    at: usage.at,
    source: 'statusline'
  }
}

/**
 * A soma de custo dos agentes. `null` quando NINGUÉM publicou custo — um total
 * de US$ 0,00 num canvas de agentes que só raspam a tela seria uma afirmação
 * falsa, e é a diferença entre "não gastei nada" e "não sei".
 */
export function sumCost(readings: AgentReading[]): number | null {
  const withCost = readings.filter((r) => typeof r.costUsd === 'number')
  if (withCost.length === 0) return null
  return withCost.reduce((acc, r) => acc + (r.costUsd as number), 0)
}

// ─── Por conta ────────────────────────────────────────────────────────────────

/**
 * O que a linha de uma CONTA mostra — o bloco "Perfis" do monitor.
 *
 * O recorte por conta não é o mesmo do bloco IA, e a diferença é a razão de
 * existir: o limite 5h/7d pertence à CONTA, não ao terminal. Dois agentes na
 * mesma conta leem o mesmo contador, e `aggregateLimits` — que tira o máximo —
 * estaria comparando uma leitura consigo mesma, escolhendo a mais VELHA sempre
 * que ela por acaso marcasse mais.
 */
export interface AccountUsage {
  /** `default` para a conta padrão; o id da conta nas demais. */
  accountId: string
  /** Janelas ainda válidas. Vazio = sem leitura — nunca 0%. */
  limits: UsageWindow[]
  /** Soma do custo dos terminais VIVOS desta conta. `null` = ninguém publicou. */
  costUsd: number | null
  /** Quantos terminais desta conta estão publicando agora. */
  live: number
  /** Quando a leitura de limites escolhida foi publicada. */
  at: string | null
  /**
   * `live` = veio de um terminal aberto agora; `stored` = é a última leitura
   * conhecida, guardada em disco e ainda dentro da validade; `none` = a conta
   * existe e não há o que dizer sobre ela.
   */
  source: 'live' | 'stored' | 'none'
}

/** Um terminal do canvas, já resolvido para a conta em que ele roda. */
export interface AccountRow {
  accountId: string
  reading: AgentReading
}

/**
 * Descarta a janela cujo reset já passou.
 *
 * Um `5h 92%` cuja hora de reset ficou para trás não é uma leitura velha, é uma
 * leitura FALSA: o contador zerou e o percentual guardado descreve uma janela
 * que não existe mais. Melhor um anel vazio.
 *
 * A janela SEM `resetsAt` sobrevive: é a raspada da tela, que nunca teve prazo,
 * e ela só chega aqui vinda de um terminal vivo — quer dizer, de agora.
 */
export function activeWindows(
  limits: { window: string; pct: number; resetsAt?: number | null }[],
  nowMs: number = Date.now()
): UsageWindow[] {
  const nowSecs = Math.floor(nowMs / 1000)
  return limits
    .filter((l) => Number.isFinite(l.pct))
    .filter((l) => typeof l.resetsAt !== 'number' || l.resetsAt > nowSecs)
    .map((l) => ({ window: l.window, pct: l.pct, resetsAt: l.resetsAt ?? null }))
}

/**
 * As leituras dos terminais viram uma linha por conta.
 *
 * Três regras, e cada uma responde a uma armadilha:
 *
 *  - **Limites: a mais FRESCA vence**, não a maior. Ver `AccountUsage` — dentro
 *    de uma conta os terminais leem o mesmo contador, e o máximo entre eles
 *    preservaria o valor obsoleto para sempre.
 *  - **Custo: SOMA**, e só dos terminais vivos. É a mesma regra de `sumCost`,
 *    pelo mesmo motivo (dólar é dólar), e a soma é por conta porque a fatura
 *    também é.
 *  - **Sem leitura ≠ zero.** A conta sem terminal aberto cai no `stored`, e se
 *    nem isso houver ela sai com `limits: []` e `source: 'none'`.
 *
 * `stored` só entra quando NÃO há leitura viva para aquela conta, e só com
 * janelas datadas: uma janela guardada sem `resetsAt` não tem como ser julgada
 * válida na sessão seguinte, e mostrá-la seria afirmar um percentual de idade
 * desconhecida.
 *
 * Contas que só aparecem no `stored` também saem na lista — a linha delas é o
 * que o painel precisa quando o canvas está sem nenhum terminal daquela conta.
 */
export function groupByAccount(
  rows: AccountRow[],
  stored: StoredAccountUsage[] = [],
  nowMs: number = Date.now()
): AccountUsage[] {
  const acc = new Map<string, AccountUsage>()
  /** O `at` da leitura viva escolhida. '' = escolhida sem data (raspada). */
  const chosenAt = new Map<string, string>()

  const slot = (accountId: string): AccountUsage => {
    const found = acc.get(accountId)
    if (found) return found
    const fresh: AccountUsage = {
      accountId,
      limits: [],
      costUsd: null,
      live: 0,
      at: null,
      source: 'none'
    }
    acc.set(accountId, fresh)
    return fresh
  }

  for (const { accountId, reading } of rows) {
    const a = slot(accountId)
    if (reading.source !== 'none') a.live += 1
    if (typeof reading.costUsd === 'number') a.costUsd = (a.costUsd ?? 0) + reading.costUsd

    const limits = activeWindows(reading.limits, nowMs)
    if (limits.length === 0) continue
    // Datas em ISO 8601 UTC comparam como texto; a sem data perde para
    // qualquer uma com data, e só vence o vazio.
    const at = reading.at ?? ''
    if (a.source === 'live' && at <= (chosenAt.get(accountId) ?? '')) continue
    a.limits = limits
    a.at = reading.at
    a.source = 'live'
    chosenAt.set(accountId, at)
  }

  for (const entry of stored) {
    const a = slot(entry.accountId)
    if (a.source === 'live') continue
    const dated = entry.limits.filter((l) => typeof l.resetsAt === 'number')
    const limits = activeWindows(dated, nowMs)
    if (limits.length === 0) continue
    a.limits = limits
    a.at = entry.at
    a.source = 'stored'
  }

  return [...acc.values()]
}

/**
 * "há 40min" — a idade de uma leitura guardada.
 *
 * Existe para a linha da conta ociosa: o percentual dela é verdadeiro (a janela
 * ainda não resetou) mas não é de agora, e mostrar os dois números sem essa
 * diferença faria a conta parada parecer tão medida quanto a que está rodando.
 */
export function agoLabel(at: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!at) return null
  const then = Date.parse(at)
  if (!Number.isFinite(then)) return null
  const mins = Math.floor((nowMs - then) / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins}min`
  const h = Math.floor(mins / 60)
  if (h < 24) return `há ${h}h`
  return `há ${Math.floor(h / 24)}d`
}

// ─── O payload da statusLine ──────────────────────────────────────────────────

/** Leitura defensiva: o payload vem de outro processo, numa versão qualquer. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * O JSON que o Claude Code entrega no stdin da `statusLine`, reduzido ao que o
 * monitor mostra.
 *
 * Leitura DEFENSIVA de ponta a ponta, e não um `as AgentUsage`: o payload é
 * escrito por um binário que se atualiza sozinho, sem passar por este código.
 * Campo novo é ignorado; campo que sumiu vira `null` e a célula mostra um
 * traço. O que não pode acontecer é um `undefined` atravessar até virar `NaN`
 * numa barra do widget.
 *
 * Devolve `null` só quando o texto nem JSON é — aí não há leitura nenhuma, e
 * gravar um objeto todo nulo apagaria a leitura anterior, que ainda valia.
 */
export function parseStatusLine(raw: string, now = new Date()): AgentUsage | null {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const model = obj(data.model)
  const ctx = obj(data.context_window)
  const cost = obj(data.cost)
  const limits = obj(data.rate_limits)
  const effort = obj(data.effort)

  return {
    model: str(model.display_name),
    modelId: str(model.id),
    inputTokens: num(ctx.total_input_tokens),
    outputTokens: num(ctx.total_output_tokens),
    contextWindowSize: num(ctx.context_window_size),
    usedPercentage: num(ctx.used_percentage),
    costUsd: num(cost.total_cost_usd),
    linesAdded: num(cost.total_lines_added),
    linesRemoved: num(cost.total_lines_removed),
    // A ordem é a mesma da UI, e é fixa: `5h` antes de `7d`. O objeto JSON não
    // garante ordem de chaves, então ela é escrita aqui em vez de herdada.
    limits: [
      readWindow('5h', limits.five_hour),
      readWindow('7d', limits.seven_day)
    ].filter((w): w is NonNullable<typeof w> => w !== null),
    effort: str(effort.level),
    fastMode: typeof data.fast_mode === 'boolean' ? data.fast_mode : null,
    sessionId: str(data.session_id),
    version: str(data.version),
    at: now.toISOString()
  }
}

/**
 * Uma janela de `rate_limits`. Ausente devolve `null` e some da lista — em vez
 * de virar 0%, que a UI leria como "janela vazia" quando é "sem leitura".
 */
function readWindow(
  name: string,
  raw: unknown
): { window: string; pct: number; resetsAt: number | null } | null {
  const w = obj(raw)
  const pct = num(w.used_percentage)
  if (pct === null) return null
  return { window: name, pct: Math.round(pct * 10) / 10, resetsAt: num(w.resets_at) }
}

/**
 * "em 2h13" — o que falta até a janela reabrir.
 *
 * Prazo, e não hora do relógio: "reseta às 14:00" obriga quem lê a fazer a
 * conta, e a conta muda de resposta conforme o fuso do agente. Vencido devolve
 * `null` (a janela já virou, e o percentual seguinte é que conta).
 */
export function untilReset(resetsAt: number | null | undefined, nowMs = Date.now()): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  const secs = resetsAt - Math.floor(nowMs / 1000)
  if (secs <= 0) return null
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`
}
