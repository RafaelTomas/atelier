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
 * Ver a Decisão B do PLANO-portal.md.
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
 * schemaVersion subir para 3. `dataTable` (v4) e `image` (v5) seguem a mesma
 * lógica: um caso a mais no enum, nenhum dado transformado. Um leitor mais
 * velho não as conhece — o que a subida de versão faz a respeito disso está em
 * persistence/migrations.ts.
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

export type NodeContentType = NodeContent['type']

/** Só estes tipos aceitam conexão (espelha NodeContent.isConnectable). */
export const CONNECTABLE_TYPES: NodeContentType[] = [
  'terminal',
  'stickyNote',
  'portal',
  'dataTable',
  'image'
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
  limits: { window: string; pct: number }[]
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
  sidebarCollapsed: boolean
  /** Largura do painel lateral em px. Ver SIDEBAR_WIDTH em renderer/sidebar.tsx. */
  sidebarWidth: number
  /** Varrer atrás de projetos novos a cada boot. O aviso sempre oferece desligar. */
  autoScanOnLaunch: boolean
  /** Temas de terminal criados pelo usuário (os embutidos não ficam aqui). */
  terminalThemes: TerminalTheme[]
  /** O que fazer com um popup aberto de dentro de um portal. */
  portalPopups: PortalPopupMode
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
