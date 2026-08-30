/**
 * Tipos do domínio, compartilhados entre main e renderer.
 *
 * Estes são os modelos *em memória*. A forma serializada em disco é diferente
 * (formato Maestri) e vive em src/main/core/models/ — nunca serialize estes
 * objetos direto com JSON.stringify.
 */

export type UUID = string // sempre MAIÚSCULO, como o UUID.uuidString do Swift

// ─── Geometria ────────────────────────────────────────────────────────────────

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ─── Conteúdo de nó ───────────────────────────────────────────────────────────

export type AgentType =
  | 'claude_code'
  | 'codex'
  | 'antigravity'
  | 'gemini_cli'
  | 'open_code'
  | 'generic_shell'

export interface TerminalContent {
  agentType: string
  command: string
  name: string
  icon: string
  color: string
  id: UUID
  shellPath: string
  workingDirectory: string
  status: string
  isManager: boolean
  monitorWithOmbro: boolean
  autoScrollLocked: boolean
  shortcutMode: { kind: string }
  assignedRoleId: UUID | null
  scrollbackFile: string | null
  scrollbackLineCount: number
  lastActiveAt: string | null
  themeId: string | null
  fontFamily: string | null
  fontSize: number | null
  /**
   * Conta do Claude que este terminal usa — vira `CLAUDE_CONFIG_DIR` no spawn.
   * `null` (ou `DEFAULT_CLAUDE_ACCOUNT_ID`) = a conta padrão, ~/.claude.
   */
  claudeAccountId: string | null
  /**
   * Terminal que criou este pelo `atelier recruit`. `null` = nasceu da mão do
   * usuário, no diálogo.
   *
   * É a permissão do `atelier dismiss`: um agente só desfaz o que ele mesmo
   * recrutou. Sem esse registro, "remover um terminal conectado" deixaria um
   * agente apagar o trabalho em andamento de outro — inclusive o do usuário.
   */
  recruitedBy: UUID | null
  /**
   * Sessão anterior do Claude Code a retomar no PRÓXIMO boot deste nó, escolhida
   * no diálogo. `null` no caso normal. É consumido uma vez: assim que o boot a
   * usa, ela vira a sessão gravada do nó (`session.json`) e este campo volta a
   * `null`, para o "Sessão nova" poder zerar tudo depois.
   */
  resumeSessionId: UUID | null
}

export type StorageMode = { kind: 'managed' } | { kind: 'custom'; path: string }

export interface StickyNoteContent {
  color: string
  fileName: string | null
  fontSize: number
  hasCustomName: boolean
  isPreviewing: boolean
  storageMode: StorageMode
  /** Cor do texto. null = derivada do fundo (ver textColorFor). */
  textColor: string | null
  fontFamily: FontFamily
  alignment: TextAlignment
}

export type PortalSource = { kind: 'none' } | { kind: 'url'; url: string }

export interface PortalContent {
  id: UUID
  name: string
  currentURL: string
  source: PortalSource
  status: string
  chromeHidden: boolean
  storageScope: string
  /**
   * O agente pode CLICAR e DIGITAR neste portal.
   *
   * Padrão `false`, sempre — inclusive ao reler um portal gravado antes deste
   * campo existir. Ler é livre; agir numa sessão autenticada é decisão do
   * usuário, tomada nó a nó pelo botão do cabeçalho (Decisão C do
   * 2026-08-27-PLANO-controle-de-portal.md).
   */
  controlEnabled: boolean
}

/**
 * Partição de sessão do `<webview>` de um portal.
 *
 * Três formas em `storageScope`, e a terceira é a que faz o popup funcionar:
 *   'isolated'   → sessão só deste nó (padrão)
 *   'shared'     → sessão comum a todos os portais
 *   'persist:…'  → partição herdada de outro portal
 *
 * Sem a herança, um popup nasceria com `content.id` novo, logo partição nova,
 * logo DESLOGADO: o usuário clica num link autenticado e recebe a tela de login.
 * Ver a Decisão B do 2026-08-26-PLANO-portal.md.
 */
export function portalPartition(content: PortalContent): string {
  if (content.storageScope.startsWith('persist:')) return content.storageScope
  if (content.storageScope === 'shared') return 'persist:atelier-portal'
  return `persist:portal-${content.id}`
}

export interface FileTreeContent {
  name: string
  rootPath: string
  viewMode: string
}

/**
 * Arquivo aberto no editor de código do canvas.
 *
 * Guarda o caminho e MAIS NADA, pela mesma razão que o fileTree só guarda o
 * rootPath: campo extra em conteúdo de nó é descartado na releitura (aqui e no
 * app nativo), então guardar ali o que se deriva do disco é convite a
 * inconsistência. Linguagem vem da extensão, conteúdo vem do arquivo.
 */
export interface CodeEditorContent {
  filePath: string
}

/**
 * Resultado de uma query publicado como nó no canvas (fase 1: snapshot).
 *
 * Só identidade e metadados leves moram aqui — colunas e linhas vão para um
 * arquivo gerenciado (`tables/<id>.json`), mesma regra da sticky note. O
 * Atelier nunca toca no banco: quem executou foi o agente, com as ferramentas
 * dele, e o que chega aqui já é o resultado.
 */
export interface DataTableContent {
  id: UUID
  title: string
  fileName: string | null
  /** A query que gerou o resultado, quando o agente a informou. */
  query: string | null
  /** `postgres`, `sqlite`, `mysql`… quando informado. */
  dialect: string | null
  rowCount: number
  columnCount: number
  /** Estourou o teto de linhas/células e foi cortado. */
  truncated: boolean
  /** ISO8601 de quando o nó foi criado/atualizado. */
  executedAt: string
}

/**
 * Uma imagem no canvas — colada, arrastada do sistema ou publicada por um agente
 * (`atelier image`).
 *
 * Mesma regra da nota e da tabela: só identidade e metadados leves moram aqui;
 * os bytes vão para um arquivo gerenciado (`images/<id>.<ext>`). `naturalWidth`
 * e `naturalHeight` ficam no conteúdo porque a proporção do nó é decidida na
 * criação, antes de o renderer ter chance de medir a imagem.
 */
export interface ImageContent {
  id: UUID
  fileName: string | null
  title: string
  /** `image/png`, `image/jpeg`… — decide a extensão do arquivo e o data URL. */
  mimeType: string
  naturalWidth: number
  naturalHeight: number
  /** Texto alternativo, quando informado (`atelier image --alt`). */
  alt: string
  /** ISO8601 de quando o nó foi criado. */
  addedAt: string
}

/**
 * Painel do app hospedado num nó do canvas — o "widget".
 *
 * UM caso de enum para TODOS os painéis, e não um por painel. O enum de
 * conteúdo é compartilhado com o app nativo Swift, onde um caso desconhecido
 * faz o `JSONDecoder` LANÇAR: três widgets como três casos seriam três eventos
 * de incompatibilidade. Com o discriminador aqui dentro, é um só — e todo
 * widget futuro cabe sem tocar no formato.
 */
export interface WidgetContent {
  /**
   * Qual painel este nó hospeda. Tipado como `string`, e não como a união, de
   * propósito: um `kind` gravado por uma versão mais nova precisa ATRAVESSAR
   * este binário intacto. Estreitar aqui faria o decoder reescrever o valor e
   * o save seguinte trocaria silenciosamente o widget do usuário por outro.
   * Ver `isKnownWidgetKind` para o teste antes de renderizar.
   */
  kind: string
  /**
   * Projeto que o widget observa. null = segue o `selectedProjectId` global —
   * a fonte única continua sendo ela; um id aqui é a exceção EXPLÍCITA, e é o
   * que permite dois widgets de git de repositórios diferentes lado a lado.
   */
  projectId: UUID | null
  /**
   * Estado de vista do painel (aba changes/history, filtro, expansões). Mapa de
   * strings porque é o que o `[String: String]` do Swift lê sem caso especial —
   * e porque nada de alta frequência tem permissão de entrar aqui.
   */
  view: Record<string, string>
}

/**
 * Os painéis que este binário sabe renderizar.
 *
 * Workspaces NÃO está aqui, e a ausência é deliberada: um seletor de workspaces
 * dentro do canvas de um workspace é circular — trocar de workspace troca o
 * canvas em que o próprio nó estava. Ele vive no chip do topo, que é global à
 * janela e não pertence a canvas nenhum.
 */
export type WidgetKind = 'projects' | 'git' | 'button' | 'monitor' | 'todo'

export const WIDGET_KINDS: WidgetKind[] = ['projects', 'git', 'button', 'monitor', 'todo']

export function isKnownWidgetKind(kind: string): kind is WidgetKind {
  return (WIDGET_KINDS as string[]).includes(kind)
}

/**
 * Quadro de TODO — o plano de trabalho de um canvas, com status.
 *
 * Hoje isso mora numa nota, e nota é texto: ninguém sabe o que está EM ANDAMENTO
 * sem ler tudo, o agente que marca `[x]` reescreve o arquivo inteiro, e dois
 * agentes marcando ao mesmo tempo se sobrescrevem. Com status e colunas, o
 * usuário vê o cartão andar enquanto o agente trabalha.
 *
 * O nó é `widget` com `kind: 'todo'` — nenhum caso novo em `NodeContent`. Os
 * DADOS, porém, não cabem em `WidgetContent.view`: ele é `[String: String]` e o
 * comentário do campo proíbe alta frequência. Um quadro serializado ali seria um
 * campo de vários KB reescrito a cada arrasto de cartão, dentro do
 * `workspace.json` que o app nativo Swift também grava. Então o quadro vive num
 * arquivo por nó (`workspaces/<ws>/todos/<id>.json`), como a nota, a tabela, a
 * imagem e o cofre já fazem; `view.file` guarda só o nome.
 */
export interface TodoColumn {
  id: string
  title: string
}

export interface TodoItem {
  id: UUID
  title: string
  /** O `id` de uma coluna. Status órfão cai na primeira — ver `readBoard`. */
  status: string
  /**
   * Posição dentro da coluna. Fracionário e ESPARSO (1000, 2000, 3000): mover um
   * cartão entre dois vizinhos é a média dos dois, sem reescrever a coluna
   * inteira — que é o que permite dois agentes mexerem no quadro sem se
   * atropelarem. Reindexa só quando a distância cai abaixo de 1.
   */
  order: number
  /** Nome do terminal responsável, quando há um. É o que `--mine` filtra. */
  assignee: string
  notes: string
  tags: string[]
  createdAt: string
  updatedAt: string
  /** Preenchido ao entrar na última coluna; limpo ao sair dela. */
  doneAt: string | null
  /**
   * De onde este trabalho veio. Manual é EXPLÍCITO (`{ type: 'manual' }`), e não
   * ausência de origem: um cartão sem origem é um cartão de quadro antigo, ainda
   * não migrado, e a migração da leitura o marca como manual. `null` só
   * sobrevive em memória entre o parse e a primeira operação.
   */
  origin: TaskOrigin | null
  /**
   * O plano ativo deste cartão, se houver. O plano em si NÃO mora aqui — ele
   * vive em `plans/<file>.json`, ao lado do quadro, pela mesma razão que o
   * quadro não mora no `workspace.json`: versões e eventos crescem sem limite e
   * são reescritos por conta própria. Aqui fica só o ponteiro.
   */
  activePlanId: string | null
}

export interface TodoBoard {
  version: number
  title: string
  columns: TodoColumn[]
  items: TodoItem[]
}

/** As três colunas de um quadro novo. */
export const TODO_DEFAULT_COLUMNS: TodoColumn[] = [
  { id: 'todo', title: 'A fazer' },
  { id: 'doing', title: 'Fazendo' },
  { id: 'done', title: 'Feito' }
]

/**
 * Origem de uma Tarefa — de onde o trabalho veio.
 *
 * Tudo aqui, exceto `type`, é dado de TERCEIRO: veio de um Jira, de um Slack,
 * de um webhook. Nada disso é confiável. Daí os três cuidados que o resto do
 * código impõe: `externalUrl` só vira link depois de passar por
 * `safeExternalUrl` (ver `@shared/task-status`), `metadata` nunca é lido por
 * campo fixo pela UI, e origem externa NÃO controla o status local do cartão —
 * quem manda no status é a coluna em que o usuário o deixou.
 *
 * `metadata` é `unknown` de propósito: quem escreve integração é obrigado a
 * checar o tipo antes de usar, em vez de confiar num `any` do provedor.
 */
export type TaskOriginType = 'manual' | 'jira' | 'slack' | 'github' | 'email' | 'api'

export const TASK_ORIGIN_TYPES: TaskOriginType[] = [
  'manual',
  'jira',
  'slack',
  'github',
  'email',
  'api'
]

export interface TaskOrigin {
  type: TaskOriginType
  externalId: string | null
  externalUrl: string | null
  sourceName: string | null
  importedAt: string | null
  metadata: Record<string, unknown> | null
}

/**
 * Plano — o "como vamos fazer" de uma Tarefa.
 *
 * Entidade SEPARADA do cartão de propósito: uma tarefa importada do Jira não
 * pode ser obrigada a carregar etapas, versões e histórico só para existir. Um
 * cartão pode viver sem plano, e concluir o cartão não apaga o plano dele.
 *
 * `currentVersionId` sempre aponta para uma `PlanVersion` DESTE plano. Quando
 * não aponta (arquivo mexido à mão, versão perdida), o plano é lido como
 * inconsistente e a UI deve impedir edição destrutiva em vez de recriar a
 * versão por conta própria — recriar apagaria o histórico que o usuário ainda
 * pode consertar.
 */
export type PlanStatus = 'draft' | 'active' | 'paused' | 'completed' | 'abandoned'

export const PLAN_STATUSES: PlanStatus[] = ['draft', 'active', 'paused', 'completed', 'abandoned']

export interface Plan {
  id: string
  /** O `TodoItem.id` dono deste plano. */
  taskId: string
  title: string
  objective: string
  status: PlanStatus
  currentVersionId: string | null
  /**
   * O status VIVO de cada etapa, por id de etapa.
   *
   * Fica no plano, e não dentro da versão, porque versão é imutável e marcar uma
   * etapa como feita não é mudança estrutural: se o status morasse na versão,
   * cada clique em checkbox criaria uma versão nova e o histórico viraria ruído.
   * O que a versão guarda em `PlanStep.status` é o status DECLARADO quando
   * aquela versão foi escrita; este mapa é a camada de cima. Ids de etapas que
   * não existem mais são ignorados na leitura.
   */
  stepStatus: Record<string, PlanStepStatus>
  createdAt: string
  updatedAt: string
}

/**
 * Uma versão do plano. IMUTÁVEL depois de criada — é isso que faz o histórico
 * valer alguma coisa. Editar estrutura cria a próxima; nunca reescreve esta.
 */
export interface PlanVersion {
  id: string
  planId: string
  versionNumber: number
  content: PlanContent
  changeSummary: string | null
  createdBy: string | null
  createdAt: string
}

export interface PlanContent {
  steps: PlanStep[]
  assumptions: string[]
  risks: string[]
  dependencies: string[]
  notes: string | null
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'

export const PLAN_STEP_STATUSES: PlanStepStatus[] = [
  'pending',
  'in_progress',
  'done',
  'blocked',
  'skipped'
]

export interface PlanStep {
  id: string
  title: string
  description: string | null
  /** O status declarado NESTA versão. O vivo está em `Plan.stepStatus`. */
  status: PlanStepStatus
  order: number
}

/**
 * Progresso derivado. NÃO é persistido: é recalculado a partir do plano e da
 * versão atual (ver `planSnapshot` em `@shared/task-status`). Gravá-lo criaria
 * um segundo lugar onde a verdade mora, e os dois divergiriam no primeiro
 * arquivo editado à mão.
 */
export interface PlanStatusSnapshot {
  planId: string
  versionId: string
  totalSteps: number
  completedSteps: number
  blockedSteps: number
  skippedSteps: number
  progressPercent: number
  lastActivityAt: string | null
  computedAt: string
}

/**
 * Evento de plano — a timeline e a auditoria.
 *
 * Eventos NUNCA são a fonte do estado atual: o estado atual está no `Plan`, na
 * `PlanVersion` e em `Plan.stepStatus`, e continua legível mesmo que a lista de
 * eventos seja truncada, perdida ou reordenada. Reconstruir estado por replay
 * faria um arquivo de log corrompido apagar o trabalho do usuário.
 */
export type PlanStatusEventType =
  | 'task_created'
  | 'task_origin_attached'
  | 'plan_created'
  | 'plan_version_created'
  | 'plan_activated'
  | 'plan_paused'
  | 'plan_completed'
  | 'step_started'
  | 'step_completed'
  | 'step_blocked'
  | 'step_skipped'

export interface PlanStatusEvent {
  id: string
  taskId: string
  planId: string
  versionId: string | null
  type: PlanStatusEventType
  payload: Record<string, unknown> | null
  createdAt: string
}

/**
 * O arquivo `plans/<file>.json` inteiro — planos, versões e eventos do quadro
 * daquele nó. Um arquivo por quadro, e não um por plano: o painel precisa dos
 * planos de TODOS os cartões para desenhar o progresso na lista, e um arquivo
 * por plano viraria dezenas de leituras a cada render.
 */
export interface PlanBook {
  version: number
  plans: Plan[]
  versions: PlanVersion[]
  events: PlanStatusEvent[]
}

/**
 * Botão do canvas — um clique que dispara uma ação.
 *
 * NÃO é um caso novo de `NodeContent`: é `widget` com `kind: 'button'`, e a
 * configuração inteira mora em `WidgetContent.view`. As duas decisões são a
 * mesma: o enum de conteúdo é compartilhado com o app nativo Swift, onde um
 * caso desconhecido faz o decoder LANÇAR, e um campo novo no payload seria
 * ignorado pelo decoder de lá e DESCARTADO no primeiro save — perda silenciosa
 * da configuração do usuário. `view` é `[String: String]` dos dois lados e faz
 * round-trip intacto.
 *
 * O preço é que tudo é string. Estas duas funções são o único lugar do código
 * que sabe disso; do lado de dentro o resto trabalha com `ButtonConfig`.
 *
 * O que NÃO entra aqui: estado de execução. "Rodando" e "falhou" mudam a cada
 * clique e vivem no renderer (ver `buttonRuns` na store) — `view` é snapshot
 * persistido, e um botão que gravasse o workspace a cada clique sujaria o
 * autosave com dado descartável.
 */
export type ButtonAction = 'command' | 'prompt' | 'url'

export const BUTTON_ACTIONS: ButtonAction[] = ['command', 'prompt', 'url']

export interface ButtonConfig {
  /** Rótulo exibido e título do nó. */
  label: string
  /** Nome do catálogo de ícones do renderer — não validado aqui (ver abaixo). */
  icon: string
  color: string
  action: ButtonAction
  command: string
  prompt: string
  url: string
  /** Vazio = o diretório do projeto do widget, ou o do workspace. */
  cwd: string
  /** Terminal onde a ação roda. null = cria um novo. */
  target: UUID | null
  confirm: boolean
  /** Proposto por um agente e ainda não aceito — inerte até o usuário aceitar. */
  pending: boolean
  proposedBy: string | null
}

export const DEFAULT_BUTTON_COLOR = '#34C759'

/**
 * `action` é validado como fontFamily/alignment: um valor estranho cairia num
 * `switch` sem caso e o botão não faria nada.
 *
 * `icon` NÃO é validado: o catálogo é do renderer, e trazer `node-icons.tsx`
 * para `shared/` só para conferir um nome custaria mais do que o defeito — um
 * nome desconhecido já renderiza o ícone padrão.
 */
export function readButtonConfig(view: Record<string, string>): ButtonConfig {
  const action = view.action ?? ''
  return {
    label: view.label ?? '',
    icon: view.icon || 'bolt',
    color: view.color || DEFAULT_BUTTON_COLOR,
    action: (BUTTON_ACTIONS as string[]).includes(action) ? (action as ButtonAction) : 'command',
    command: view.command ?? '',
    prompt: view.prompt ?? '',
    url: view.url ?? '',
    cwd: view.cwd ?? '',
    target: view.target ? (view.target as UUID) : null,
    confirm: view.confirm === '1',
    pending: view.pending === '1',
    proposedBy: view.proposedBy || null
  }
}

/** Chave vazia ou falsa é OMITIDA: um `view` enxuto é o que o app nativo e o
 *  diff do arquivo de workspace mostram. */
export function writeButtonConfig(config: ButtonConfig): Record<string, string> {
  const view: Record<string, string> = {
    label: config.label,
    icon: config.icon,
    color: config.color,
    action: config.action
  }
  if (config.command) view.command = config.command
  if (config.prompt) view.prompt = config.prompt
  if (config.url) view.url = config.url
  if (config.cwd) view.cwd = config.cwd
  if (config.target) view.target = config.target
  if (config.confirm) view.confirm = '1'
  if (config.pending) view.pending = '1'
  if (config.proposedBy) view.proposedBy = config.proposedBy
  return view
}

/** O que o botão dispara, em uma linha — o que o nó pendente mostra ao usuário
 *  antes do aceite, e o que o `title` explica depois dele. */
export function buttonActionSummary(config: ButtonConfig): string {
  switch (config.action) {
    case 'prompt':
      return config.prompt
    case 'url':
      return config.url
    default:
      return config.command
  }
}

export type FontFamily = 'sans' | 'serif' | 'mono' | 'rounded'
export type FontWeight = 'light' | 'regular' | 'medium' | 'semibold' | 'bold'
export type TextAlignment = 'left' | 'center' | 'right'

export interface TextContent {
  text: string
  fontSize: number
  fontWeight: FontWeight
  color: string
  alignment: TextAlignment
  fontFamily: FontFamily
  isItalic: boolean
  isUnderlined: boolean
  isStrikethrough: boolean
  /** Fundo do rótulo. null = transparente (o padrão, sem chrome). */
  backgroundColor: string | null
  lineHeight: number
  letterSpacing: number
}

export interface ShapeContent {
  shapeType: 'rect' | 'ellipse' | 'diamond'
  fillColor: string
  strokeColor: string
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
  fillStyle: 'solid' | 'none' | 'hatched' | 'crossHatched'
  text: string
  fontSize: number
  rotation: number
}

/**
 * Nó de cofre — a IDENTIDADE de um conjunto de segredos, e a lista de nomes de
 * chave. Nenhum valor, em lugar nenhum: eles moram cifrados em
 * `vaults/<id>.vault`, e o workspace.json é arquivo em claro.
 *
 * Nome de chave em claro é aceitável e deliberado: é o que a UI e o
 * `atelier vault list` mostram sem decifrar nada, e saber que existe um segredo
 * chamado `DB_URL` não é o segredo.
 */
export interface SecretVaultKeyRef {
  key: string
  /** Entra no ambiente do PTY dos terminais ligados. */
  inEnv: boolean
  /**
   * Origem onde este segredo pode ser digitado por `portal login`. null = uso
   * em portal PROIBIDO. Quem não declarou, não autorizou.
   */
  origin: string | null
  note: string | null
  /**
   * Quando o segredo foi gravado, e por quem — o que o nó precisa para pedir a
   * troca (ver `rotationReason` em shared/vault.ts). Nenhum dos dois é o valor:
   * a projeção continua sem segredo nenhum.
   */
  updatedAt: string
  source: 'user' | 'agent'
}

export interface SecretVaultContent {
  id: UUID
  name: string
  keys: SecretVaultKeyRef[]
  /**
   * O `.vault` não pôde ser lido — `safeStorage` indisponível ou blob de outro
   * chaveiro. Gravado no conteúdo para o nó já nascer mostrando o estado certo
   * antes de a UI perguntar ao main.
   */
  locked: boolean
}

export interface StrokeContent {
  strokeType: 'line' | 'arrow'
  startPoint: Point
  endPoint: Point
  controlPoint: Point | null
  strokeColor: string
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
}

export interface FreehandContent {
  freehandType: 'pen' | 'highlighter'
  points: Point[]
  strokeColor: string
  strokeWidth: number
  opacity: number
  rotation: number
}

/**
 * Equivale ao enum NodeContent do Swift. As variantes serializam como
 * { "<tipo>": { "_0": … } } — ver models/node-content.ts.
 *
 * Eram oito, herdadas do app nativo; `codeEditor` é a nona e é o que fez o
 * schemaVersion subir para 3. `dataTable` (v4), `image` (v5) e `widget` (v6)
 * seguem a mesma lógica: um caso a mais no enum, nenhum dado transformado. Um
 * leitor mais velho não as conhece — o que a subida de versão faz a respeito
 * disso está em persistence/migrations.ts.
 *
 * `widget` é o último caso que um PAINEL vai pedir: o discriminador dele mora
 * no payload (ver WidgetContent), então painel novo não é caso novo.
 *
 * `secretVault` (v7) é o caso mais recente, e a mesma história: um caso a mais,
 * nenhum dado transformado.
 */
export type NodeContent =
  | { type: 'terminal'; value: TerminalContent }
  | { type: 'stickyNote'; value: StickyNoteContent }
  | { type: 'portal'; value: PortalContent }
  | { type: 'fileTree'; value: FileTreeContent }
  | { type: 'codeEditor'; value: CodeEditorContent }
  | { type: 'text'; value: TextContent }
  | { type: 'shape'; value: ShapeContent }
  | { type: 'stroke'; value: StrokeContent }
  | { type: 'freehand'; value: FreehandContent }
  | { type: 'dataTable'; value: DataTableContent }
  | { type: 'image'; value: ImageContent }
  | { type: 'widget'; value: WidgetContent }
  | { type: 'secretVault'; value: SecretVaultContent }

export type NodeContentType = NodeContent['type']

/** Só estes tipos aceitam conexão (espelha NodeContent.isConnectable). */
export const CONNECTABLE_TYPES: NodeContentType[] = [
  'terminal',
  'stickyNote',
  'portal',
  'dataTable',
  'image',
  'secretVault',
  // `widget` entrou pelo quadro de TODO: para o agente escrever num quadro, o
  // quadro precisa aceitar cabo. Vale para TODO widget — o de git e o de
  // projetos junto —, e é por isso que a recusa acontece por `kind` no momento
  // de aceitar a ligação (ver connectionKindForTypes abaixo), e não aqui.
  'widget'
]

export function isConnectable(content: NodeContent): boolean {
  return CONNECTABLE_TYPES.includes(content.type)
}

/**
 * O que dá para ler da linha de status do agente. Quem raspa é o main
 * (terminal/agent-status), quem mostra é o rodapé do nó no renderer.
 */
export interface AgentStatus {
  /** Tokens da sessão, como o agente conta. */
  tokens: number | null
  /** Percentual de contexto usado. */
  contextPct: number | null
  /** Janelas de limite de uso: `5h` 80%, `7d` 58%. */
  limits: UsageLimit[]
}

export type AgentUsageSource = 'statusline' | 'app-server' | 'screen' | 'none'
export type AgentProvider = 'claude' | 'codex'

export interface UsageLimit {
  provider?: AgentProvider
  bucketId?: string | null
  bucketName?: string | null
  window: string
  windowMinutes?: number | null
  pct: number
  resetsAt?: number | null
}

/**
 * O que o agente publica sobre a PRÓPRIA sessão, em vez do que dá para raspar
 * da tela dele.
 *
 * O Claude Code chama um comando a cada mensagem nova e entrega um JSON no
 * stdin — é o mecanismo da `statusLine`. `atelier statusline` é esse comando:
 * ele devolve o payload ao main pelo mesmo socket do resto do CLI, e o que
 * chega aqui é estruturado, na unidade certa e com o tamanho da janela junto.
 *
 * A diferença para `AgentStatus` não é de precisão, é de natureza. O raspador
 * lê "103 tok" e não sabe se a janela é de 200k ou de 1M; não sabe qual modelo
 * está rodando; e só enxerga uma janela de limite quando o CLI resolve
 * imprimi-la. Aqui tudo isso é campo.
 *
 * Os dois convivem: `statusLine` é do Claude Code, e o Atelier sobe cinco
 * presets. Codex, Antigravity, OpenCode e shell continuam no raspador, que por
 * isso não sai de cena — ver `mergeReading` em shared/agent-usage.ts.
 */
export interface AgentUsage {
  provider?: AgentProvider | null
  /** `model.display_name` — qual Claude está de fato rodando neste nó. */
  model: string | null
  modelId: string | null
  /** Tokens NA JANELA agora (entrada, incluindo leitura e escrita de cache). */
  inputTokens: number | null
  outputTokens: number | null
  /** 200000, ou 1000000 nos modelos de contexto estendido. */
  contextWindowSize: number | null
  /** Já calculado pelo CLI, sobre tokens de entrada. */
  usedPercentage: number | null
  sessionTokens?: number | null
  cachedInputTokens?: number | null
  cacheWriteInputTokens?: number | null
  reasoningOutputTokens?: number | null
  /**
   * Custo estimado da SESSÃO, em dólares. Diferente de tokens, esta unidade é
   * a mesma para todo agente — é o único número deste tipo que dá para somar
   * entre nós do canvas.
   */
  costUsd: number | null
  linesAdded: number | null
  linesRemoved: number | null
  /**
   * Janelas de limite de uso, com a hora do reset em segundos de época. O
   * `resetsAt` é o que o raspador nunca teve: sem ele, "7d 58%" é um número
   * sem prazo.
   */
  limits: UsageLimit[]
  effort: string | null
  fastMode: boolean | null
  sessionId: string | null
  version: string | null
  /** Quando o agente publicou isto. */
  at: string
}

/**
 * A última leitura de limites de uma CONTA do Claude, guardada entre sessões.
 *
 * É o único pedaço da telemetria que sobrevive ao fechamento do app, e a
 * exceção tem razão: `AgentUsage` é estado de SESSÃO (custo e contexto de um
 * processo que já morreu não valem nada na próxima abertura), mas as janelas de
 * limite são da CONTA e trazem a própria validade — `resetsAt` diz até quando
 * aquele percentual continua sendo verdade. Uma leitura vencida é descartada na
 * hora de mostrar, não guardada como se ainda valesse.
 *
 * Sem isto, a conta em que o usuário não tem terminal aberto AGORA apareceria
 * sempre vazia no painel de perfis — que é justamente a conta sobre a qual ele
 * precisa decidir se pode abrir mais um agente.
 *
 * Custo NÃO entra aqui: ele é da sessão, e somar dólares de sessões mortas
 * responderia outra pergunta (o gasto histórico) com a cara desta.
 */
export interface StoredAccountUsage {
  /** `DEFAULT_CLAUDE_ACCOUNT_ID` para a conta padrão (~/.claude). */
  accountId: string
  limits: UsageLimit[]
  /** Quando o agente publicou. ISO 8601. */
  at: string
}

export interface CodexAccountUsage {
  authMode: string | null
  planType: string | null
  limits: UsageLimit[]
  credits: {
    hasCredits: boolean
    unlimited: boolean
    balance: string | null
  } | null
  individualLimit: {
    limit: string
    used: string
    remainingPct: number
    resetsAt: number
  } | null
  spendControlReached: boolean | null
  rateLimitReachedType: string | null
  resetCreditsAvailable: number | null
  at: string
  source: 'live' | 'stored' | 'none'
}

export interface StoredCodexUsage {
  limits: UsageLimit[]
  planType: string | null
  credits: CodexAccountUsage['credits']
  individualLimit: CodexAccountUsage['individualLimit']
  spendControlReached: boolean | null
  rateLimitReachedType: string | null
  at: string
}

/**
 * 218000 -> "218.0k", 18500000 -> "18.5M". Fica no módulo compartilhado porque
 * quem lê o número é o main (terminal/agent-status) e quem o mostra é o renderer.
 */
export function formatTokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`
  return String(count)
}

/**
 * Uma amostra do estado da máquina — bloco PC do monitor.
 *
 * Exportado do módulo compartilhado porque quem PRODUZ é o main
 * (core/system/system-stats) e quem FORMATA é o renderer, exatamente como
 * `AgentStatus` e `formatTokens`.
 *
 * Nada disto é persistido: a amostra vive em memória e morre com a janela. Um
 * monitor que gravasse no workspace sujaria o autosave 60 vezes por minuto com
 * dado descartável — é a mesma razão pela qual `WidgetContent.view` só guarda a
 * CONFIGURAÇÃO do painel (blocos, intervalo, volume).
 */
export interface SystemStats {
  /** null enquanto não há DUAS amostras: CPU% é derivada de um delta, não lida. */
  cpuPct: number | null
  /** `os.loadavg()[0]`. null no Windows, onde o Node devolve 0 sem significado. */
  loadAvg: number | null
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  /** Volume observado. Vazio quando `statfs` falhou (caminho fora do ar). */
  diskPath: string
  /** O "quanto EU custo": processo principal + renderers + PTYs filhos. */
  appCpuPct: number
  appMemBytes: number
  at: string
}

/**
 * 999 -> "999 B", 1536 -> "1,5 KB", 1.5e9 -> "1,4 GB".
 *
 * Mora aqui pela mesma razão de `formatTokens`: quem produz o número é o main e
 * quem o mostra é o renderer. Base 1024 (o que os sistemas chamam de GB na
 * barra de memória) e vírgula decimal, como o resto da interface.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  // Bytes não têm casa decimal: "999,0 B" é ruído. A partir de KB, uma casa —
  // duas fariam a linha dançar a cada amostra sem dizer nada a mais.
  const text = u === 0 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',')
  return `${text} ${units[u]}`
}

// ─── Nó ───────────────────────────────────────────────────────────────────────

export interface CanvasNode {
  id: UUID
  frame: Rect // serializa como [[x,y],[w,h]]
  content: NodeContent
  zIndex: number
  isLocked: boolean
  createdAt: string
  lastModifiedAt: string
}

// ─── Conexões ─────────────────────────────────────────────────────────────────

export type ConnectionKind =
  | 'terminal'
  | 'note'
  | 'portal'
  | 'portalToPortal'
  | 'noteToNote'
  | 'crossFloor'
  | 'data'
  | 'secret'

export type ConnectionStatus = 'idle' | 'communicating' | 'error'

/**
 * `kind` de uma conexão a partir dos tipos dos dois nós — null = par não
 * conectável. Mora aqui, e não no WorkspaceManager, porque o renderer precisa
 * da MESMA regra para prever o cabo antes de pedi-lo ao processo principal.
 */
export function connectionKindForTypes(
  a: NodeContentType,
  b: NodeContentType
): ConnectionKind | null {
  const pair = new Set([a, b])
  if (a === 'terminal' && b === 'terminal') return 'terminal'
  if (pair.has('terminal') && pair.has('stickyNote')) return 'note'
  if (pair.has('terminal') && pair.has('portal')) return 'portal'
  if (pair.has('terminal') && pair.has('dataTable')) return 'data'
  // Imagem publicada por um agente usa o mesmo cabo do resultado de query: em
  // disco ambos caem em `dataConnections` (só referências de id), e o sentido é
  // o mesmo — um agente ligado a um artefato que ele produziu.
  if (pair.has('terminal') && pair.has('image')) return 'data'
  // Editor de código ligado a um agente: MESMO cabo `data`, não um kind novo.
  // Em disco cai em `dataConnections`, cujos campos são só referências de id
  // (`terminalId`/`dataNodeId`) — `codeEditor` é caso de enum desde a v3 e a
  // lista existe desde a v4, então nenhum documento muda de forma e o
  // `schemaVersion` não sobe. A alternativa descartada era um `kind: 'file'`
  // com `fileConnections` próprio: custaria uma migração inteira, e um Atelier
  // mais antigo ignoraria a chave nova e apagaria os cabos no primeiro
  // autosave. O ganho seria só uma cor de cabo diferente.
  if (pair.has('terminal') && pair.has('codeEditor')) return 'data'
  // Quadro de TODO ligado a um agente: MESMO cabo `data`, pela razão escrita
  // logo acima para o editor. Em disco cai em `dataConnections`, cujos campos
  // são só referências de id, então nenhum documento muda de forma e o
  // `schemaVersion` não sobe. Um `kind: 'board'` próprio custaria uma migração
  // inteira para ganhar uma cor de cabo diferente.
  if (pair.has('terminal') && pair.has('widget')) return 'data'
  // Um kind só para terminal↔cofre e portal↔cofre — e, mais tarde,
  // dataTable↔cofre. Em disco os campos são neutros (`nodeIdA`/`nodeIdB`),
  // como no crossFloor, justamente para o par novo não pedir lista nova.
  if (pair.has('secretVault') && (pair.has('terminal') || pair.has('portal'))) return 'secret'
  if (a === 'portal' && b === 'portal') return 'portalToPortal'
  if (a === 'stickyNote' && b === 'stickyNote') return 'noteToNote'
  return null
}

/** Forma normalizada usada pelo renderer e pelo ConnectionManager. */
export interface Connection {
  id: UUID
  kind: ConnectionKind
  nodeIdA: UUID
  nodeIdB: UUID
  ropePoints: number[][]
  createdAt: string
  status: ConnectionStatus
  /** Só para kind === 'crossFloor'. null = Ground. */
  floorIdA?: UUID | null
  floorIdB?: UUID | null
}

// ─── Workspace ────────────────────────────────────────────────────────────────

/**
 * Uma moldura que agrupa nós — o que a UI chama de "grupo".
 *
 * NÃO é um caso de `NodeContent`, e a diferença é o que decide se o app nativo
 * Swift abre o arquivo. Um caso desconhecido no enum de conteúdo faz o
 * `JSONDecoder` de lá LANÇAR: o workspace não abre. Uma chave desconhecida no
 * TOPO do payload, ao contrário, ele ignora em silêncio — abre normalmente, só
 * sem as molduras. O custo é que um save vindo de lá apaga `groups`: perde-se a
 * moldura, nunca os nós. Por isso `groups` nunca subiu o `schemaVersion`.
 *
 * A verdade é `nodeIds`; a contenção geométrica é só o GESTO que edita essa
 * lista (soltar um nó dentro adota, arrastar para fora solta). Duas restrições
 * que cabem numa checagem cada e eliminam a maior parte dos casos ruins: um nó
 * pertence a no máximo um grupo, e grupos não aninham.
 *
 * Sem `zIndex`: grupos vivem numa camada própria, sempre atrás dos nós, e a
 * ordem do array é o empilhamento entre eles.
 */
export interface NodeGroup {
  id: UUID
  title: string
  frame: Rect // serializa como [[x,y],[w,h]], igual ao nó
  nodeIds: UUID[]
  /** Accent da moldura e da faixa do título. */
  color: string
  isCollapsed: boolean
  createdAt: string
  lastModifiedAt: string
}

export interface WorkspacePayload {
  id: UUID
  name: string
  icon: string
  isPinned: boolean
  locationType: string
  workingDirectory: string
  preferredIDE: string
  syncConfigFiles: boolean
  canvasOrigin: Point
  canvasZoom: number
  nodes: CanvasNode[]
  connections: Connection[]
  floors: FloorEntry[]
  drawings: Drawing[]
  groups: NodeGroup[]
  createdAt: string
  lastOpenedAt: string | null
  lastModifiedAt: string
}

export interface FloorEntry {
  id: UUID
  name: string
  branchName: string
  worktreePath: string
  hooks: unknown
  createdAt: string
}

export interface Drawing {
  id: UUID
  points: number[][]
  color: string
  lineWidth: number
  createdAt: string
}

// ─── Estado global ────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  id: UUID
  name: string
  workingDirectory: string
  icon: string
  color: string
  isPinned: boolean
  locationType: string
  createdAt: string
  lastOpenedAt: string | null
}

export interface WorkspaceManifest {
  schemaVersion: number
  type: string
  app: string
  appVersion: string
  dataFormat: number
  workspaces: WorkspaceEntry[]
  files: Record<string, string>
}

export interface AppStateData {
  schemaVersion: number
  type: string
  activeWorkspaceId: UUID | null
  hasCompletedOnboarding: boolean
  hasSeenFloorOnboarding: boolean
  cleanShutdown: boolean
  lastOpenedAt: string | null
  recentWorkspaceIds: UUID[]
}

export interface Preferences {
  canvasBackground: string
  language: string
  fontSize: number
  fontFamily: string
  theme: string
  /**
   * Campo MORTO desde que a sidebar virou o rail em cascata: nada no renderer
   * lê nem escreve. Fica no tipo porque `preferences.json` é compartilhado com
   * o app nativo Swift, onde a chave continua existindo — removê-la daqui faria
   * o encoder daqui apagá-la de lá.
   */
  sidebarCollapsed: boolean
  /**
   * Largura da coluna de conteúdo do rail, em px. O nome é o do disco e não
   * mudou de propósito: reaproveitar o campo evita uma migração de preferências
   * para uma medida que significa exatamente a mesma coisa. Ver RAIL_WIDTH em
   * renderer/rail.tsx.
   */
  sidebarWidth: number
  /** Varrer atrás de projetos novos a cada boot. O aviso sempre oferece desligar. */
  autoScanOnLaunch: boolean
  /** Temas de terminal criados pelo usuário (os embutidos não ficam aqui). */
  terminalThemes: TerminalTheme[]
  /** O que fazer com um popup aberto de dentro de um portal. */
  portalPopups: PortalPopupMode
  /**
   * Onde ficam as duas pílulas flutuantes — `"bottom/center"`, `"left/center"`.
   *
   * STRINGS, e não um objeto, pela mesma razão do `view` do widget: um objeto
   * aninhado é o que o decoder do app nativo tem mais chance de REJEITAR em vez
   * de ignorar.
   *
   * Chaves DESTE binário: o app nativo Swift não as conhece, e um save de lá as
   * apaga. Aceito com os olhos abertos — perder isto devolve o padrão, que é a
   * posição histórica, e o prejuízo é ínfimo comparado ao de perder a
   * configuração de um botão do usuário. Valor inválido ou ausente cai no
   * padrão SEMPRE: ver `parsePlacement`.
   */
  dockPlacement: string
  railPlacement: string
  monitorPlacement: string
  /**
   * A tira do monitor na borda. Padrão `true`.
   *
   * É a única das pílulas que se pode desligar, e a razão é o custo: ela é
   * assinante PERMANENTE do amostrador (ver monitor-dock.tsx), então "não
   * quero pagar por isso" é um pedido legítimo. Perder a chave devolve o
   * padrão, que é a tira VISÍVEL — nenhum estado em disco pode escondê-la sem
   * deixar como trazê-la de volta.
   */
  monitorDockVisible: boolean
}

// ─── Posição das pílulas flutuantes ───────────────────────────────────────────

/**
 * Ancoragem em BORDA, com posição LIVRE ao longo dela.
 *
 * A borda não é negociável: uma pílula em `x/y` livre pode ser largada em cima
 * de um nó (e aí rouba cliques do canvas para sempre) ou ficar fora da janela
 * num redimensionamento, sem como voltar sem editar as preferências à mão.
 *
 * Ao LONGO da borda, porém, não havia razão para só três paradas: quem arrasta
 * a dock para um ponto qualquer da base espera que ela fique ali, e não que
 * salte para o terço mais próximo. `offset` é a fração desse percurso — 0 é o
 * começo da borda, 1 é o fim, 0.5 é o centro —, e é fração e não pixels para
 * sobreviver ao redimensionamento da janela: a pílula guarda a POSIÇÃO
 * relativa, não uma coordenada que a janela pode deixar para trás.
 */
export type PlacementEdge = 'top' | 'bottom' | 'left' | 'right'

/** As três paradas nomeadas — o que o menu de contexto oferece. */
export type PlacementAlign = 'start' | 'center' | 'end'

export interface Placement {
  edge: PlacementEdge
  /** 0 = início da borda, 0.5 = centro, 1 = fim. Sempre dentro de [0, 1]. */
  offset: number
}

export const PLACEMENT_EDGES: PlacementEdge[] = ['top', 'bottom', 'left', 'right']
export const PLACEMENT_ALIGNS: PlacementAlign[] = ['start', 'center', 'end']

/** A fração de cada parada nomeada. É a ponte entre o menu e o `offset`. */
export const ALIGN_OFFSET: Record<PlacementAlign, number> = {
  start: 0,
  center: 0.5,
  end: 1
}

/** As doze posições NOMEADAS, na ordem em que o menu de contexto as oferece. */
export const PLACEMENTS: Placement[] = PLACEMENT_EDGES.flatMap((edge) =>
  PLACEMENT_ALIGNS.map((align) => ({ edge, offset: ALIGN_OFFSET[align] }))
)

export const DOCK_PLACEMENT_DEFAULT: Placement = { edge: 'bottom', offset: 0.5 }
export const RAIL_PLACEMENT_DEFAULT: Placement = { edge: 'left', offset: 0.5 }
/**
 * A base é da dock e a esquerda é da rail: o topo é a borda que sobrou, e nela
 * a tira assenta abaixo do chip e dos controles de vista pelo `--pill-safe-top`
 * que já existe. O 0.85 é à direita de propósito — nascer no centro do topo é
 * nascer em cima de qualquer uma das outras duas que o usuário tenha mudado
 * para lá.
 */
export const MONITOR_PLACEMENT_DEFAULT: Placement = { edge: 'top', offset: 0.85 }

/** Borda esquerda/direita → pílula vertical; topo/base → horizontal. */
export function isVerticalEdge(edge: PlacementEdge): boolean {
  return edge === 'left' || edge === 'right'
}

export function clampOffset(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * `{ edge, offset }` → `"bottom/center"` ou `"bottom/0.317"`.
 *
 * As três frações nomeadas voltam a ser PALAVRAS. Não é cosmético: o formato em
 * disco é lido por versões mais velhas deste binário, e as posições que elas
 * conhecem continuam sendo exatamente as strings que elas sabem ler. Só uma
 * posição de fato nova — que nenhuma versão anterior saberia representar —
 * grava um número, e lá a versão velha cai no padrão em vez de quebrar.
 */
export function formatPlacement(p: Placement): string {
  const offset = clampOffset(p.offset)
  for (const align of PLACEMENT_ALIGNS) {
    if (ALIGN_OFFSET[align] === offset) return `${p.edge}/${align}`
  }
  // Três casas: sub-pixel em qualquer janela real, e o arquivo continua legível.
  return `${p.edge}/${offset.toFixed(3)}`
}

/**
 * `"bottom/center"` → `{ edge, offset }`. NUNCA lança.
 *
 * Um valor gravado que não faça sentido — lixo, uma versão mais nova, um save do
 * app nativo que passou por cima — cai no padrão. É a garantia de que a dock
 * continua alcançável: nenhum estado em disco pode escondê-la.
 */
export function parsePlacement(raw: unknown, fallback: Placement): Placement {
  if (typeof raw !== 'string') return fallback
  const parts = raw.split('/')
  if (parts.length !== 2) return fallback
  const [edge, at] = parts
  if (!PLACEMENT_EDGES.includes(edge as PlacementEdge)) return fallback

  if (PLACEMENT_ALIGNS.includes(at as PlacementAlign)) {
    return { edge: edge as PlacementEdge, offset: ALIGN_OFFSET[at as PlacementAlign] }
  }
  // Fração explícita. `Number('')` é 0 e `Number(' ')` também: sem o teste de
  // formato, `"bottom/"` viraria uma posição válida em vez de cair no padrão.
  if (!/^\d+(\.\d+)?$/.test(at)) return fallback
  const offset = Number(at)
  if (!Number.isFinite(offset) || offset > 1) return fallback
  return { edge: edge as PlacementEdge, offset }
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.edge === b.edge && a.offset === b.offset
}

/**
 * 'node'   → nasce como nó novo no canvas, ligado ao pai (padrão)
 * 'same'   → navega no próprio nó, para quem acha que popup é ruído
 * 'system' → vai para o navegador do sistema
 */
export type PortalPopupMode = 'node' | 'same' | 'system'

export const PORTAL_POPUP_MODES: PortalPopupMode[] = ['node', 'same', 'system']

/**
 * Tema de terminal. Os três embutidos ('system', 'dark', 'light') são
 * resolvidos no renderer; só os personalizados vão para preferences.json.
 */
export interface TerminalTheme {
  id: string
  name: string
  background: string
  foreground: string
}

// ─── Contas do Claude ─────────────────────────────────────────────────────────

/**
 * A conta padrão do Claude Code: o ~/.claude de sempre.
 *
 * É SINTÉTICA — nunca vai para `claude-accounts.json` e não tem diretório
 * próprio. Ela significa exatamente "não definir CLAUDE_CONFIG_DIR": apontar a
 * variável para ~/.claude não seria equivalente, porque o `claude` passaria a
 * procurar ~/.claude/.claude.json (que não existe) e trataria a conta atual do
 * usuário como um onboarding novo.
 */
export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default'

export interface ClaudeAccount {
  id: string
  label: string
  createdAt: string
}

/**
 * O que a UI mostra sobre uma conta. O e-mail e o plano saem do
 * `.claude.json` do próprio diretório; `authenticated` é a existência do
 * `.credentials.json`, que é o que decide se o `claude` vai pedir /login.
 */
export interface ClaudeAccountInfo extends ClaudeAccount {
  /** null na conta padrão — ela é a ausência de CLAUDE_CONFIG_DIR. */
  configDir: string | null
  email: string | null
  plan: string | null
  authenticated: boolean
}

// ─── Responsabilidades (agentes) ──────────────────────────────────────────────

/**
 * Uma responsabilidade atribuível a um terminal — o que a UI chama de "agente".
 *
 * Vive em ~/.atelier/roles/{UUID}.json, um arquivo por responsabilidade, no
 * mesmo dialeto Codable do resto (UUID maiúsculo, data ISO8601 sem ms).
 * `workspaceId` null = global, visível em todos os workspaces.
 */
export interface AgentRole {
  id: UUID
  name: string
  icon: string
  color: string
  /** O texto que define o foco do agente — lido por ele via `atelier role`. */
  instructions: string
  workspaceId: UUID | null
  createdAt: string
  lastModifiedAt: string
}

/**
 * Uma sessão anterior do Claude Code num diretório, candidata a `--resume`.
 * Alimenta o select "Retomar sessão" do diálogo de novo terminal.
 */
export interface ClaudeSessionSummary {
  /** Id da sessão (nome do `.jsonl` sem extensão) — vai direto no `--resume`. */
  sessionId: UUID
  /** `mtime` do arquivo, em ISO. É o critério de ordenação da lista. */
  modifiedAt: string
  /**
   * A primeira mensagem do usuário na transcrição, encurtada. Vazio quando não
   * há nenhuma ainda ou nada legível saiu do arquivo — a UI cai na data.
   */
  label: string
}

/** O que o diálogo de novo terminal entrega ao main. */
export interface TerminalDraft {
  name: string
  command: string
  agentType: string
  workingDirectory: string
  icon: string
  color: string
  monitorWithOmbro: boolean
  isManager: boolean
  themeId: string | null
  fontFamily: string | null
  fontSize: number | null
  assignedRoleId: UUID | null
  /** Conta do Claude escolhida no diálogo. null = padrão (~/.claude). */
  claudeAccountId: string | null
  /**
   * Sessão anterior do Claude Code escolhida no select "Retomar sessão". `null`
   * = sessão nova. Vale UMA vez: o primeiro boot a grava como a sessão do nó e
   * o campo é zerado — daí em diante manda o `session.json`.
   */
  resumeSessionId: UUID | null
}

// ─── Ponte renderer ⇄ main ────────────────────────────────────────────────────

export interface TerminalSpawnOptions {
  nodeId: UUID
  workspaceId: UUID
  shellPath?: string
  command?: string
  workingDirectory?: string
  cols?: number
  rows?: number
  /** Responsabilidade atribuída — vira ATELIER_ROLE_* no ambiente do PTY. */
  role?: { id: UUID; name: string } | null
  /**
   * Diretório da conta do Claude — vira `CLAUDE_CONFIG_DIR`. Ausente na conta
   * padrão: a variável então NÃO é definida, e o `claude` usa ~/.claude.
   */
  claudeConfigDir?: string
  /**
   * Variáveis vindas dos cofres ligados a este terminal. Mescladas DEPOIS das
   * `ATELIER_*`, para um cofre não conseguir sobrescrever `ATELIER_SOCKET` e
   * sequestrar o canal do CLI.
   */
  extraEnv?: Record<string, string>
  /**
   * Tipo do agente daquele nó. Chega no spawn, e não só no `setAgentInfo`
   * depois dele, porque é ele que decide se o comando ganha as flags de sessão
   * — e essa decisão precisa acontecer ANTES de o comando ser digitado.
   */
  agentType?: string
  /**
   * O que fazer com a sessão gravada deste nó:
   *
   *  - `auto` (padrão) — retoma se houver id válido. É o boot do app, o caso que
   *    dói depois de um crash ou de um restart do watcher.
   *  - `clean` — ignora e apaga o id. É o "Sessão nova": quem clica ali quer
   *    começar limpo, e ressuscitar a conversa anterior seria o oposto do pedido.
   *  - `resume` — retoma explicitamente, pedido pelo menu do nó.
   */
  sessionMode?: 'auto' | 'clean' | 'resume'
  /**
   * Sessão anterior escolhida no diálogo de terminal. Só é honrada quando não há
   * `session.json` utilizável para o nó: uma escolha feita na criação nunca
   * ganha da sessão que o próprio nó já acumulou. Usada, ela é gravada como a
   * sessão do nó e o `bridge` limpa o campo do conteúdo.
   */
  resumeSessionId?: UUID
}

export interface BootInfo {
  serverPort: number
  socketPath: string
  dataDir: string
  /** Pasta pessoal do usuário. O renderer não tem `os`, e '~' não é expandido. */
  homeDir: string
  platform: string
  needsRecovery: boolean
}

// ─── Projetos ─────────────────────────────────────────────────────────────────
// O índice de projetos vive FORA do workspace.json, em ~/.atelier/projects.json,
// com schema próprio (projectIndexSchemaVersion). É global: não pertence a um
// workspace, e por isso não passa pelo codec estilo Codable do canvas.

/**
 * Um projeto de desenvolvimento descoberto no disco.
 *
 * A divisão entre campos derivados e campos preservados é o contrato do merge
 * (ver ProjectStore.mergeScan): tudo que o scanner sabe reproduzir é
 * sobrescrito a cada varredura; tudo que veio do usuário ou de um agente
 * sobrevive.
 */
export interface Project {
  id: UUID
  /** Caminho absoluto e normalizado — é a chave de identidade real. */
  path: string
  name: string
  /** Nome editado à mão: o scan não sobrescreve mais. */
  hasCustomName: boolean

  // Derivados do disco — reescritos a cada scan
  kind: string
  language: string | null
  gitRemote: string | null
  gitBranch: string | null

  // Do usuário — preservados
  isFavorite: boolean
  isArchived: boolean
  /** O caminho sumiu do disco. Marcamos em vez de apagar. */
  isMissing: boolean
  tags: string[]

  // Do nó Scanner, via `atelier projects describe` — preservados
  description: string | null
  stack: string[]
  role: string | null
  enrichedAt: string | null

  lastSeenAt: string
  lastOpenedAt: string | null
  createdAt: string
  lastModifiedAt: string
}

export interface ProjectIndex {
  schemaVersion: number
  type: 'projectIndex'
  projects: Project[]
  lastScanAt: string | null
  scanRoots: string[]
  /**
   * Caminhos que o usuário mandou não oferecer de novo. A varredura do boot os
   * acha e os descarta em silêncio — é o que impede o aviso de reaparecer a
   * cada abertura oferecendo o mesmo projeto recusado.
   */
  excludedPaths: string[]
}

/** O que o scanner devolve: dados de disco, ainda sem identidade nem histórico. */
export interface DiscoveredProject {
  path: string
  name: string
  kind: string
  language: string | null
  gitBranch: string | null
  gitRemote: string | null
  /** Descrição lida de package.json/README — não é a do agente. */
  summary: string | null
  stack: string[]
  lastCommitAt: string | null
}

/** Uma entrada de diretório, para a árvore de arquivos do nó de projeto. */
export interface FsEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
}

// ─── Git ─────────────────────────────────────────────────────────────────────

/**
 * Um arquivo no `git status`. Os dois códigos vêm crus do porcelain v1 — o
 * painel os traduz — porque a combinação é que carrega o sentido: `MM` é
 * "modificado, staged, e modificado de novo depois", coisa que um único campo
 * "estado" não conseguiria dizer.
 */
export interface GitFileChange {
  path: string
  /** Caminho de origem num rename/copy; null no resto. */
  from: string | null
  /** Coluna X do porcelain: o que está no índice (staged). */
  index: string
  /** Coluna Y: o que está na árvore de trabalho. */
  worktree: string
  isStaged: boolean
  isUntracked: boolean
  isConflicted: boolean
}

/** Operação em curso que muda o que os botões podem fazer. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface GitStatus {
  /** Raiz do repositório — não a pasta consultada, que pode ser subpasta. */
  root: string
  /** null quando o HEAD está solto (detached). */
  branch: string | null
  /** Ex.: `origin/main`. null quando o branch nunca foi publicado. */
  upstream: string | null
  ahead: number
  behind: number
  /** URL do remoto `origin`, quando existe. */
  remote: string | null
  operation: GitOperation
  files: GitFileChange[]
}

export interface GitCommitEntry {
  hash: string
  author: string
  relativeDate: string
  subject: string
}

export interface GitLogResult {
  commits: GitCommitEntry[]
}
/**
 * Por que uma operação de arquivo foi recusada.
 *
 * Código, nunca a mensagem do sistema: o texto do `fs` revela a existência e o
 * nome de caminhos fora do escopo permitido. Quem traduz para o usuário é o
 * renderer (ver FILE_OP_TEXT em renderer/file-tree.tsx).
 *
 * Mora aqui, e não em core/projects/file-ops.ts, porque o preload é tipado
 * contra @shared e não pode importar nada do processo principal.
 */
export type FileOpError =
  | 'missing'
  | 'denied'
  | 'too-large'
  | 'binary'
  | 'exists'
  | 'not-a-file'
  | 'error'
