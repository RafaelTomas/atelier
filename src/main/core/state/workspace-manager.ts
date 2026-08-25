/**
 * Porte de Sources/Workspace/WorkspaceManager.swift.
 *
 * Um por workspace. Guarda o payload em memória e a flag `isDirty` — só workspace
 * sujo é gravado no ciclo de autosave, exatamente como no app nativo.
 */
import type {
  CanvasNode,
  Connection,
  ConnectionKind,
  Drawing,
  Rect,
  UUID,
  WorkspacePayload
} from '@shared/types'
import { connectionKindForTypes } from '@shared/types'
import { nowISO } from '../coding'
import { makeConnection } from '../models/workspace'

export class WorkspaceManager {
  payload: WorkspacePayload
  isDirty = false

  constructor(payload: WorkspacePayload) {
    this.payload = payload
  }

  get id(): UUID {
    return this.payload.id
  }

  get nodes(): CanvasNode[] {
    return this.payload.nodes
  }

  get connections(): Connection[] {
    return this.payload.connections
  }

  setName(name: string): void {
    this.payload.name = name
    this.markDirty()
  }

  markDirty(): void {
    this.isDirty = true
    this.payload.lastModifiedAt = nowISO()
  }

  /**
   * Cópia imutável para I/O fora da thread de UI.
   * Equivale ao snapshotPayload() do Swift — o mesmo padrão snapshot→I/O.
   */
  snapshot(): WorkspacePayload {
    return structuredClone(this.payload)
  }

  // ─── Nós ────────────────────────────────────────────────────────────────────

  node(id: UUID): CanvasNode | undefined {
    return this.payload.nodes.find((n) => n.id === id)
  }

  addNode(node: CanvasNode): void {
    const maxZ = this.payload.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0)
    node.zIndex = maxZ + 1
    this.payload.nodes.push(node)
    this.markDirty()
  }

  removeNode(id: UUID): void {
    this.payload.nodes = this.payload.nodes.filter((n) => n.id !== id)
    this.payload.connections = this.payload.connections.filter(
      (c) => c.nodeIdA !== id && c.nodeIdB !== id
    )
    this.markDirty()
  }

  updateFrame(id: UUID, frame: Rect): void {
    const node = this.node(id)
    if (!node) return
    node.frame = frame
    node.lastModifiedAt = nowISO()
    this.markDirty()
  }

  updateContent(id: UUID, mutate: (node: CanvasNode) => void): void {
    const node = this.node(id)
    if (!node) return
    mutate(node)
    node.lastModifiedAt = nowISO()
    this.markDirty()
  }

  bringToFront(id: UUID): void {
    const node = this.node(id)
    if (!node) return
    const maxZ = this.payload.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0)
    if (node.zIndex === maxZ) return
    node.zIndex = maxZ + 1
    this.markDirty()
  }

  // ─── Conexões ───────────────────────────────────────────────────────────────

  /** Deduz o `kind` a partir dos tipos dos dois nós. null = par não conectável. */
  connectionKindFor(idA: UUID, idB: UUID): ConnectionKind | null {
    const a = this.node(idA)?.content.type
    const b = this.node(idB)?.content.type
    if (!a || !b) return null
    return connectionKindForTypes(a, b)
  }

  addConnection(idA: UUID, idB: UUID): Connection | null {
    if (idA === idB) return null
    const kind = this.connectionKindFor(idA, idB)
    if (!kind) return null
    const exists = this.payload.connections.some(
      (c) =>
        (c.nodeIdA === idA && c.nodeIdB === idB) || (c.nodeIdA === idB && c.nodeIdB === idA)
    )
    if (exists) return null

    // Ordem canônica: para os kinds assimétricos, o terminal é sempre o lado A
    let a = idA
    let b = idB
    if ((kind === 'note' || kind === 'portal') && this.node(idB)?.content.type === 'terminal') {
      a = idB
      b = idA
    }

    const conn = makeConnection(kind, a, b)
    this.payload.connections.push(conn)
    this.markDirty()
    return conn
  }

  removeConnection(id: UUID): void {
    this.payload.connections = this.payload.connections.filter((c) => c.id !== id)
    this.markDirty()
  }

  connectionsFor(nodeId: UUID): Connection[] {
    return this.payload.connections.filter((c) => c.nodeIdA === nodeId || c.nodeIdB === nodeId)
  }

  connectedNodeIds(nodeId: UUID): UUID[] {
    return this.connectionsFor(nodeId).map((c) => (c.nodeIdA === nodeId ? c.nodeIdB : c.nodeIdA))
  }

  // ─── Desenhos ───────────────────────────────────────────────────────────────
  // Traço livre solto no canvas (não é nó): vive em payload.drawings, que o
  // codec já lia e regravava desde o início.

  get drawings(): Drawing[] {
    return this.payload.drawings
  }

  addDrawing(drawing: Drawing): void {
    this.payload.drawings.push(drawing)
    this.markDirty()
  }

  removeDrawing(id: UUID): void {
    const before = this.payload.drawings.length
    this.payload.drawings = this.payload.drawings.filter((d) => d.id !== id)
    if (this.payload.drawings.length !== before) this.markDirty()
  }

  clearDrawings(): void {
    if (this.payload.drawings.length === 0) return
    this.payload.drawings = []
    this.markDirty()
  }

  // ─── Viewport ───────────────────────────────────────────────────────────────
  // Não marca dirty: canvasOrigin/zoom são estado de runtime no app nativo.

  setViewport(origin: { x: number; y: number }, zoom: number): void {
    this.payload.canvasOrigin = origin
    this.payload.canvasZoom = zoom
  }
}
