/**
 * Codec de workspace.json (schemaVersion 3, formato Maestri).
 *
 * Em disco as conexões vivem em SEIS arrays separados, cada um com nomes de
 * campo próprios. Em memória normalizamos tudo num único Connection[] com um
 * discriminante `kind` — a separação é refeita na escrita.
 */
import type {
  CanvasNode,
  Connection,
  ConnectionKind,
  Drawing,
  FloorEntry,
  NodeGroup,
  Point,
  Rect,
  UUID,
  WorkspacePayload
} from '@shared/types'
import {
  asRecord,
  bool,
  decodeDate,
  decodeOptionalDate,
  decodePoint,
  decodeRect,
  encodePoint,
  encodeRect,
  nowISO,
  normalizeUUID,
  num,
  str,
  uuid
} from '../coding'
import { Constants } from '../constants'
import { decodeNodeContent, encodeNodeContent } from './node-content'

// ─── CanvasNode ───────────────────────────────────────────────────────────────

export function decodeCanvasNode(value: unknown): CanvasNode | null {
  const raw = asRecord(value)
  const frame = decodeRect(raw.frame)
  if (!frame) return null // frame inválido = nó descartado (igual ao Swift, que lança)
  const content = decodeNodeContent(raw.content)
  if (!content) return null
  return {
    id: normalizeUUID(raw.id),
    frame,
    content,
    zIndex: num(raw.zIndex, 0),
    isLocked: bool(raw.isLocked),
    createdAt: decodeDate(raw.createdAt),
    lastModifiedAt: decodeDate(raw.lastModifiedAt)
  }
}

export function encodeCanvasNode(node: CanvasNode): unknown {
  return {
    id: node.id,
    frame: encodeRect(node.frame),
    content: encodeNodeContent(node.content),
    zIndex: node.zIndex,
    isLocked: node.isLocked,
    createdAt: node.createdAt,
    lastModifiedAt: node.lastModifiedAt
  }
}

export function makeCanvasNode(
  frame: Rect,
  content: CanvasNode['content'],
  zIndex = 0
): CanvasNode {
  const ts = nowISO()
  return {
    id: uuid(),
    frame,
    content,
    zIndex,
    isLocked: false,
    createdAt: ts,
    lastModifiedAt: ts
  }
}

// ─── Conexões: mapa disco ⇄ memória ───────────────────────────────────────────

interface ConnectionSchema {
  arrayKey: string
  kind: ConnectionKind
  fieldA: string
  fieldB: string
}

const CONNECTION_SCHEMAS: ConnectionSchema[] = [
  { arrayKey: 'connections', kind: 'terminal', fieldA: 'terminalIdA', fieldB: 'terminalIdB' },
  { arrayKey: 'noteConnections', kind: 'note', fieldA: 'terminalId', fieldB: 'noteNodeId' },
  { arrayKey: 'portalConnections', kind: 'portal', fieldA: 'terminalId', fieldB: 'portalNodeId' },
  { arrayKey: 'dataConnections', kind: 'data', fieldA: 'terminalId', fieldB: 'dataNodeId' },
  {
    arrayKey: 'portalToPortalConnections',
    kind: 'portalToPortal',
    fieldA: 'portalIdA',
    fieldB: 'portalIdB'
  },
  {
    arrayKey: 'noteToNoteConnections',
    kind: 'noteToNote',
    fieldA: 'noteNodeIdA',
    fieldB: 'noteNodeIdB'
  },
  { arrayKey: 'crossFloorConnections', kind: 'crossFloor', fieldA: 'nodeIdA', fieldB: 'nodeIdB' },
  // Campos NEUTROS de propósito: o mesmo kind cobre terminal↔cofre e
  // portal↔cofre, e mais tarde dataTable↔cofre — como o crossFloor já faz.
  // Uma lista por par de tipos obrigaria uma migração a cada par novo.
  { arrayKey: 'secretConnections', kind: 'secret', fieldA: 'nodeIdA', fieldB: 'nodeIdB' }
]

function decodeConnections(raw: Record<string, unknown>): Connection[] {
  const out: Connection[] = []
  for (const schema of CONNECTION_SCHEMAS) {
    const list = raw[schema.arrayKey]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const o = asRecord(item)
      const a = o[schema.fieldA]
      const b = o[schema.fieldB]
      if (typeof a !== 'string' || typeof b !== 'string') continue
      const conn: Connection = {
        id: normalizeUUID(o.id),
        kind: schema.kind,
        nodeIdA: a.toUpperCase(),
        nodeIdB: b.toUpperCase(),
        ropePoints: decodeRopePoints(o.ropePoints),
        createdAt: decodeDate(o.createdAt),
        status: 'idle'
      }
      if (schema.kind === 'crossFloor') {
        conn.floorIdA = o.floorIdA ? normalizeUUID(o.floorIdA) : null
        conn.floorIdB = o.floorIdB ? normalizeUUID(o.floorIdB) : null
      }
      out.push(conn)
    }
  }
  return out
}

function encodeConnections(connections: Connection[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const schema of CONNECTION_SCHEMAS) {
    out[schema.arrayKey] = connections
      .filter((c) => c.kind === schema.kind)
      .map((c) => {
        const base: Record<string, unknown> = {
          id: c.id,
          createdAt: c.createdAt,
          [schema.fieldA]: c.nodeIdA,
          [schema.fieldB]: c.nodeIdB,
          ropePoints: c.ropePoints
        }
        if (schema.kind === 'crossFloor') {
          base.floorIdA = c.floorIdA ?? null
          base.floorIdB = c.floorIdB ?? null
        }
        return base
      })
  }
  return out
}

function decodeRopePoints(value: unknown): number[][] {
  if (!Array.isArray(value)) return []
  return value
    .filter((p): p is number[] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'))
    .map((p) => [p[0], p[1]])
}

export function makeConnection(kind: ConnectionKind, nodeIdA: UUID, nodeIdB: UUID): Connection {
  return {
    id: uuid(),
    kind,
    nodeIdA,
    nodeIdB,
    ropePoints: [],
    createdAt: nowISO(),
    status: 'idle'
  }
}

/** Traço livre. `points` são pares [x,y] em coordenadas de canvas. */
export function makeDrawing(points: number[][], color: string, lineWidth: number): Drawing {
  return {
    id: uuid(),
    points: points.map((p) => [p[0], p[1]]),
    color,
    lineWidth,
    createdAt: nowISO()
  }
}

// ─── Floors e drawings ────────────────────────────────────────────────────────

function decodeFloors(value: unknown): FloorEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const o = asRecord(item)
    return {
      id: normalizeUUID(o.id),
      name: str(o.name),
      branchName: str(o.branchName),
      worktreePath: str(o.worktreePath),
      hooks: o.hooks ?? {},
      createdAt: decodeDate(o.createdAt)
    }
  })
}

function decodeDrawings(value: unknown): Drawing[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const o = asRecord(item)
    return {
      id: normalizeUUID(o.id),
      points: decodeRopePoints(o.points),
      color: str(o.color, '#000000'),
      lineWidth: num(o.lineWidth, 2),
      createdAt: decodeDate(o.createdAt)
    }
  })
}

// ─── Grupos ───────────────────────────────────────────────────────────────────

/** Cor padrão da moldura — o azul do sistema, o mesmo accent do resto da UI. */
export const GROUP_DEFAULT_COLOR = '#007AFF'

/**
 * Molduras de grupo. Ao lado de `drawings`, e não dentro dos nós: ver NodeGroup.
 *
 * `known` é o conjunto de ids que SOBREVIVERAM à decodificação dos nós. Um id
 * que não está lá é lixo (o nó foi apagado por fora, ou o decoder o descartou),
 * e um grupo apontando para o nada mostraria "5 nós" com três na tela. Como a
 * lista é filtrada aqui, um grupo pode acabar vazio — e vazio ele continua
 * sendo uma moldura legítima, só à espera de conteúdo.
 *
 * `claimed` faz valer a regra de um dono por nó: um arquivo editado à mão pode
 * ter o mesmo id em dois grupos, e resolver isso na LEITURA (fica no primeiro)
 * é mais barato do que carregar a ambiguidade por todo o resto do código.
 */
function decodeGroups(value: unknown, known: Set<UUID>): NodeGroup[] {
  if (!Array.isArray(value)) return []
  const claimed = new Set<UUID>()
  const out: NodeGroup[] = []
  for (const item of value) {
    const o = asRecord(item)
    const frame = decodeRect(o.frame)
    if (!frame) continue // sem geometria não há moldura para desenhar
    const nodeIds: UUID[] = []
    if (Array.isArray(o.nodeIds)) {
      for (const raw of o.nodeIds) {
        if (typeof raw !== 'string') continue
        const id = raw.toUpperCase()
        if (!known.has(id) || claimed.has(id)) continue
        claimed.add(id)
        nodeIds.push(id)
      }
    }
    out.push({
      id: normalizeUUID(o.id),
      title: str(o.title, 'Grupo'),
      frame,
      nodeIds,
      color: str(o.color, GROUP_DEFAULT_COLOR),
      isCollapsed: bool(o.isCollapsed),
      createdAt: decodeDate(o.createdAt),
      lastModifiedAt: decodeDate(o.lastModifiedAt)
    })
  }
  return out
}

function encodeGroups(groups: NodeGroup[]): unknown[] {
  return groups.map((g) => ({
    id: g.id,
    title: g.title,
    frame: encodeRect(g.frame),
    nodeIds: g.nodeIds,
    color: g.color,
    isCollapsed: g.isCollapsed,
    createdAt: g.createdAt,
    lastModifiedAt: g.lastModifiedAt
  }))
}

export function makeNodeGroup(title: string, frame: Rect, nodeIds: UUID[] = []): NodeGroup {
  const ts = nowISO()
  return {
    id: uuid(),
    title,
    frame,
    nodeIds: [...nodeIds],
    color: GROUP_DEFAULT_COLOR,
    isCollapsed: false,
    createdAt: ts,
    lastModifiedAt: ts
  }
}

// ─── WorkspacePayload ─────────────────────────────────────────────────────────

/**
 * Contagem do que o decoder DESCARTOU — a rede contra a perda silenciosa.
 *
 * Um nó cuja variante este binário não conhece (porque veio de uma versão mais
 * nova, ou de um arquivo editado à mão) é filtrado aqui e sumiria de vez no
 * primeiro autosave. Contar é o que permite ao app perceber isso e travar a
 * escrita antes de destruir o arquivo — ver o modo seguro em app-state.ts.
 */
export interface DecodeDiagnostics {
  /** Nós lidos do arquivo que não sobreviveram à decodificação. */
  droppedNodes: number
}
// Grupo descartado NÃO entra aqui, de propósito: a moldura não é conteúdo. Um
// grupo perdido custa um retângulo que se redesenha em segundos; travar o
// autosave por causa dele seria cobrar o preço do modo seguro por nada.

export function decodeWorkspacePayload(
  value: unknown,
  diagnostics?: DecodeDiagnostics
): WorkspacePayload {
  const raw = asRecord(value)
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const nodes = rawNodes.map(decodeCanvasNode).filter((n): n is CanvasNode => n !== null)
  if (diagnostics) diagnostics.droppedNodes += rawNodes.length - nodes.length

  return {
    id: normalizeUUID(raw.id),
    name: str(raw.name, 'Workspace'),
    icon: str(raw.icon, 'folder'),
    isPinned: bool(raw.isPinned),
    locationType: str(raw.locationType, 'local'),
    workingDirectory: str(raw.workingDirectory),
    preferredIDE: str(raw.preferredIDE, 'cursor'),
    syncConfigFiles: bool(raw.syncConfigFiles),
    canvasOrigin: decodePoint(raw.canvasOrigin, { ...Constants.canvasInitialOrigin }),
    canvasZoom: num(raw.canvasZoom, 1),
    nodes,
    connections: decodeConnections(raw),
    floors: decodeFloors(raw.floors),
    drawings: decodeDrawings(raw.drawings),
    groups: decodeGroups(raw.groups, new Set(nodes.map((n) => n.id))),
    createdAt: decodeDate(raw.createdAt),
    lastOpenedAt: decodeOptionalDate(raw.lastOpenedAt),
    lastModifiedAt: decodeDate(raw.lastModifiedAt)
  }
}

export function encodeWorkspacePayload(payload: WorkspacePayload): Record<string, unknown> {
  return {
    id: payload.id,
    name: payload.name,
    icon: payload.icon,
    isPinned: payload.isPinned,
    locationType: payload.locationType,
    workingDirectory: payload.workingDirectory,
    preferredIDE: payload.preferredIDE,
    syncConfigFiles: payload.syncConfigFiles,
    canvasOrigin: encodePoint(payload.canvasOrigin),
    canvasZoom: payload.canvasZoom,
    nodes: payload.nodes.map(encodeCanvasNode),
    ...encodeConnections(payload.connections),
    floors: payload.floors.map((f) => ({ ...f })),
    drawings: payload.drawings.map((d) => ({ ...d })),
    groups: encodeGroups(payload.groups),
    createdAt: payload.createdAt,
    lastOpenedAt: payload.lastOpenedAt,
    lastModifiedAt: payload.lastModifiedAt
  }
}

export function makeWorkspacePayload(name: string, workingDirectory: string): WorkspacePayload {
  const ts = nowISO()
  return {
    id: uuid(),
    name,
    icon: 'folder',
    isPinned: false,
    locationType: 'local',
    workingDirectory,
    preferredIDE: 'cursor',
    syncConfigFiles: false,
    canvasOrigin: { ...Constants.canvasInitialOrigin } as Point,
    canvasZoom: 1,
    nodes: [],
    connections: [],
    floors: [],
    drawings: [],
    groups: [],
    createdAt: ts,
    lastOpenedAt: null,
    lastModifiedAt: ts
  }
}

// ─── WorkspaceDocument (raiz do arquivo) ──────────────────────────────────────

export function decodeWorkspaceDocument(value: unknown): {
  payload: WorkspacePayload
  /** A versão que ESTAVA no arquivo, antes de qualquer migração. */
  schemaVersion: number
  droppedNodes: number
} {
  const raw = asRecord(value)
  const diagnostics: DecodeDiagnostics = { droppedNodes: 0 }
  const payload = decodeWorkspacePayload(raw.payload, diagnostics)
  return {
    payload,
    schemaVersion: num(raw.schemaVersion, 1),
    droppedNodes: diagnostics.droppedNodes
  }
}

export function encodeWorkspaceDocument(payload: WorkspacePayload): unknown {
  return {
    payload: encodeWorkspacePayload(payload),
    schemaVersion: Constants.schemaVersion,
    type: 'workspace'
  }
}
