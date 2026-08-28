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
  NodeGroup,
  Rect,
  UUID,
  WorkspacePayload
} from '@shared/types'
import { connectionKindForTypes } from '@shared/types'
import { nowISO } from '../coding'
import { Constants } from '../constants'
import { makeConnection, makeNodeGroup } from '../models/workspace'

export class WorkspaceManager {
  payload: WorkspacePayload
  isDirty = false
  /**
   * Versão que estava no arquivo em disco. Enquanto for menor que a do app, o
   * próximo save grava antes um backup — ver PersistenceManager.saveWorkspace.
   */
  fileSchemaVersion: number
  /** Nós que o decoder não entendeu e descartou ao abrir. */
  droppedNodes: number

  constructor(payload: WorkspacePayload, integrity?: { fileSchemaVersion?: number; droppedNodes?: number }) {
    this.payload = payload
    this.fileSchemaVersion = integrity?.fileSchemaVersion ?? Constants.schemaVersion
    this.droppedNodes = integrity?.droppedNodes ?? 0
  }

  /**
   * Modo seguro: o arquivo em disco tem conteúdo que este binário não entende,
   * e gravar por cima o apagaria. Autosave e shutdown pulam este workspace; só
   * um save pedido pelo usuário passa por cima, e a faixa na UI diz o custo.
   */
  get isSafeMode(): boolean {
    return this.droppedNodes > 0 || this.fileSchemaVersion > Constants.schemaVersion
  }

  /** O que a UI mostra na faixa de aviso. */
  integrity(): { safeMode: boolean; droppedNodes: number; fileSchemaVersion: number } {
    return {
      safeMode: this.isSafeMode,
      droppedNodes: this.droppedNodes,
      fileSchemaVersion: this.fileSchemaVersion
    }
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
    // A moldura fica; só perde o membro. Um grupo vazio continua sendo um
    // grupo — apagá-lo junto tiraria da tela um rótulo que o usuário escreveu
    // por causa de um nó que ele apagou.
    for (const group of this.payload.groups) {
      const i = group.nodeIds.indexOf(id)
      if (i >= 0) group.nodeIds.splice(i, 1)
    }
    this.markDirty()
  }

  updateFrame(id: UUID, frame: Rect): void {
    const node = this.node(id)
    if (!node) return
    node.frame = frame
    node.lastModifiedAt = nowISO()
    this.markDirty()
  }

  /**
   * Vários frames de uma vez — o commit de um arrasto de seleção múltipla.
   *
   * Existe para NÃO haver um IPC por nó: arrastar um grupo de dez nós fazia dez
   * chamadas e dez marcações de dirty. Aqui é uma travessia e uma marcação só.
   */
  updateFrames(entries: { nodeId: UUID; frame: Rect }[]): void {
    if (entries.length === 0) return
    const ts = nowISO()
    let touched = false
    for (const { nodeId, frame } of entries) {
      const node = this.node(nodeId)
      if (!node) continue
      node.frame = frame
      node.lastModifiedAt = ts
      touched = true
    }
    if (touched) this.markDirty()
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
    if (
      (kind === 'note' || kind === 'portal' || kind === 'data') &&
      this.node(idB)?.content.type === 'terminal'
    ) {
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

  // ─── Grupos ─────────────────────────────────────────────────────────────────
  // Moldura com título em volta de um conjunto de nós. Vive em payload.groups,
  // fora do array de nós e fora do enum de conteúdo — ver NodeGroup.

  get groups(): NodeGroup[] {
    return this.payload.groups
  }

  group(id: UUID): NodeGroup | undefined {
    return this.payload.groups.find((g) => g.id === id)
  }

  /**
   * Cria a moldura já com os membros. `nodeIds` passa pelo mesmo filtro do
   * decoder: só nós que existem, sem repetição, e cada um sai do grupo anterior
   * — um nó pertence a no máximo um grupo.
   */
  createGroup(title: string, frame: Rect, nodeIds: UUID[]): NodeGroup {
    const group = makeNodeGroup(title, frame, [])
    this.payload.groups.push(group)
    this.assignNodes(group, nodeIds)
    this.markDirty()
    return group
  }

  /** Patch raso do que a UI edita: título, frame, cor, colapso. */
  updateGroup(
    id: UUID,
    patch: Partial<Pick<NodeGroup, 'title' | 'frame' | 'color' | 'isCollapsed'>>
  ): NodeGroup | null {
    const group = this.group(id)
    if (!group) return null
    if (patch.title !== undefined) group.title = patch.title
    if (patch.frame !== undefined) group.frame = patch.frame
    if (patch.color !== undefined) group.color = patch.color
    if (patch.isCollapsed !== undefined) group.isCollapsed = patch.isCollapsed
    group.lastModifiedAt = nowISO()
    this.markDirty()
    return group
  }

  /**
   * Desagrupar. Os NÓS não são tocados: quem quer apagá-los junto passa por
   * `node:remove`, um a um, e essa decisão é de quem confirmou o diálogo.
   */
  removeGroup(id: UUID): void {
    const before = this.payload.groups.length
    this.payload.groups = this.payload.groups.filter((g) => g.id !== id)
    if (this.payload.groups.length !== before) this.markDirty()
  }

  /** Membros de um grupo, na íntegra — é o que "mover junto" precisa saber. */
  setGroupNodes(id: UUID, nodeIds: UUID[]): NodeGroup | null {
    const group = this.group(id)
    if (!group) return null
    group.nodeIds = []
    this.assignNodes(group, nodeIds)
    this.markDirty()
    return group
  }

  /**
   * O nó passa a pertencer a `groupId` — e deixa de pertencer a qualquer outro.
   * `null` só solta. É por aqui que passa o gesto de entrar/sair pela geometria.
   */
  setNodeGroup(nodeId: UUID, groupId: UUID | null): void {
    if (!this.node(nodeId)) return
    for (const g of this.payload.groups) {
      const i = g.nodeIds.indexOf(nodeId)
      if (i >= 0 && g.id !== groupId) g.nodeIds.splice(i, 1)
    }
    if (groupId) {
      const target = this.group(groupId)
      if (target && !target.nodeIds.includes(nodeId)) target.nodeIds.push(nodeId)
    }
    this.markDirty()
  }

  /** O filtro comum de createGroup/setGroupNodes: existe, não repete, dono único. */
  private assignNodes(group: NodeGroup, nodeIds: UUID[]): void {
    for (const id of nodeIds) {
      if (!this.node(id)) continue
      if (group.nodeIds.includes(id)) continue
      for (const other of this.payload.groups) {
        if (other.id === group.id) continue
        const i = other.nodeIds.indexOf(id)
        if (i >= 0) other.nodeIds.splice(i, 1)
      }
      group.nodeIds.push(id)
    }
    group.lastModifiedAt = nowISO()
  }

  // ─── Viewport ───────────────────────────────────────────────────────────────
  // Não marca dirty: canvasOrigin/zoom são estado de runtime no app nativo.

  setViewport(origin: { x: number; y: number }, zoom: number): void {
    this.payload.canvasOrigin = origin
    this.payload.canvasZoom = zoom
  }
}
