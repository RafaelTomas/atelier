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

export type AgentType = 'claude_code' | 'codex' | 'gemini_cli' | 'open_code' | 'generic_shell'

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

export interface FileTreeContent {
  name: string
  rootPath: string
  viewMode: string
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
 * Equivale ao enum NodeContent do Swift. As 8 variantes serializam como
 * { "<tipo>": { "_0": … } } — ver models/node-content.ts.
 */
export type NodeContent =
  | { type: 'terminal'; value: TerminalContent }
  | { type: 'stickyNote'; value: StickyNoteContent }
  | { type: 'portal'; value: PortalContent }
  | { type: 'fileTree'; value: FileTreeContent }
  | { type: 'text'; value: TextContent }
  | { type: 'shape'; value: ShapeContent }
  | { type: 'stroke'; value: StrokeContent }
  | { type: 'freehand'; value: FreehandContent }

export type NodeContentType = NodeContent['type']

/** Só estes tipos aceitam conexão (espelha NodeContent.isConnectable). */
export const CONNECTABLE_TYPES: NodeContentType[] = ['terminal', 'stickyNote', 'portal']

export function isConnectable(content: NodeContent): boolean {
  return CONNECTABLE_TYPES.includes(content.type)
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

export type ConnectionStatus = 'idle' | 'communicating' | 'error'

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
}

export interface BootInfo {
  serverPort: number
  socketPath: string
  dataDir: string
  platform: string
  needsRecovery: boolean
}
