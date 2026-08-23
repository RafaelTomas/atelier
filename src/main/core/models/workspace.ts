/**
 * Codec de workspace.json (schemaVersion 2, formato Maestri).
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
  { arrayKey: 'crossFloorConnections', kind: 'crossFloor', fieldA: 'nodeIdA', fieldB: 'nodeIdB' }
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

// ─── WorkspacePayload ─────────────────────────────────────────────────────────

export function decodeWorkspacePayload(value: unknown): WorkspacePayload {
  const raw = asRecord(value)
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(decodeCanvasNode).filter((n): n is CanvasNode => n !== null)
    : []

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
    createdAt: ts,
    lastOpenedAt: null,
    lastModifiedAt: ts
  }
}

// ─── WorkspaceDocument (raiz do arquivo) ──────────────────────────────────────

export function decodeWorkspaceDocument(value: unknown): {
  payload: WorkspacePayload
  schemaVersion: number
} {
  const raw = asRecord(value)
  return {
    payload: decodeWorkspacePayload(raw.payload),
    schemaVersion: num(raw.schemaVersion, 1)
  }
}

export function encodeWorkspaceDocument(payload: WorkspacePayload): unknown {
  return {
    payload: encodeWorkspacePayload(payload),
    schemaVersion: Constants.schemaVersion,
    type: 'workspace'
  }
}
