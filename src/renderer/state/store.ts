/**
 * Store mínima com useSyncExternalStore.
 *
 * Guarda só o que muda POR EVENTO (nós, conexões, seleção). Pan, zoom e a
 * posição durante o arrasto NÃO passam por aqui — ver canvas/viewport.ts.
 * Essa separação é a regra 5 de docs/migracao-electron.md: se o estado de
 * pan/zoom entrar no React, a árvore re-renderiza a cada mousemove e os
 * terminais entram em tempestade de refresh.
 */
import { useSyncExternalStore } from 'react'
import type {
  CanvasNode,
  Connection,
  Rect,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'

export interface AppSnapshot {
  entries: WorkspaceEntry[]
  activeId: UUID | null
  workspace: WorkspacePayload | null
  selection: UUID[]
  /** Nó de origem enquanto o usuário arrasta uma conexão nova. */
  connectingFrom: UUID | null
  loading: boolean
  bootError: string | null
}

const initial: AppSnapshot = {
  entries: [],
  activeId: null,
  workspace: null,
  selection: [],
  connectingFrom: null,
  loading: true,
  bootError: null
}

class Store {
  private state: AppSnapshot = initial
  private listeners = new Set<() => void>()

  getSnapshot = (): AppSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<AppSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const { entries, activeId } = await window.atelier.workspace.list()
      const id = activeId ?? entries[0]?.id ?? null
      const workspace = id ? await window.atelier.workspace.open(id) : null
      this.set({ entries, activeId: id, workspace, loading: false })
    } catch (err) {
      this.set({ loading: false, bootError: (err as Error).message })
    }
  }

  async openWorkspace(id: UUID): Promise<void> {
    const workspace = await window.atelier.workspace.open(id)
    this.set({ workspace, activeId: id, selection: [] })
  }

  async createWorkspace(name: string): Promise<void> {
    const { entries, workspace } = await window.atelier.workspace.create(name, '')
    this.set({ entries, workspace, activeId: workspace.id, selection: [] })
  }

  // ─── Nós ────────────────────────────────────────────────────────────────────

  get workspaceId(): UUID | null {
    return this.state.workspace?.id ?? null
  }

  private mutateWorkspace(fn: (ws: WorkspacePayload) => void): void {
    const ws = this.state.workspace
    if (!ws) return
    const next = { ...ws, nodes: [...ws.nodes], connections: [...ws.connections] }
    fn(next)
    this.set({ workspace: next })
  }

  async addNode(
    kind: 'terminal' | 'note' | 'text' | 'portal' | 'fileTree',
    position: { x: number; y: number },
    opts: Record<string, unknown> = {}
  ): Promise<CanvasNode | null> {
    const id = this.workspaceId
    if (!id) return null
    const node = await window.atelier.node.add(id, kind, position, opts)
    if (node) {
      this.mutateWorkspace((ws) => ws.nodes.push(node))
      this.set({ selection: [node.id] })
    }
    return node
  }

  async removeNode(nodeId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.node.remove(id, nodeId)
    this.mutateWorkspace((ws) => {
      ws.nodes = ws.nodes.filter((n) => n.id !== nodeId)
      ws.connections = ws.connections.filter((c) => c.nodeIdA !== nodeId && c.nodeIdB !== nodeId)
    })
    this.set({ selection: this.state.selection.filter((s) => s !== nodeId) })
  }

  /** Commit do frame ao SOLTAR o nó — durante o arrasto escrevemos direto no DOM. */
  async commitFrame(nodeId: UUID, frame: Rect): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    this.mutateWorkspace((ws) => {
      ws.nodes = ws.nodes.map((n) => (n.id === nodeId ? { ...n, frame } : n))
    })
    await window.atelier.node.setFrame(id, nodeId, frame)
  }

  async patchContent(nodeId: UUID, patch: Record<string, unknown>): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    const updated = await window.atelier.node.patchContent(id, nodeId, patch)
    if (!updated) return
    this.mutateWorkspace((ws) => {
      ws.nodes = ws.nodes.map((n) => (n.id === nodeId ? updated : n))
    })
  }

  async bringToFront(nodeId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.node.bringToFront(id, nodeId)
    this.mutateWorkspace((ws) => {
      const maxZ = ws.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0)
      ws.nodes = ws.nodes.map((n) => (n.id === nodeId ? { ...n, zIndex: maxZ + 1 } : n))
    })
  }

  // ─── Conexões ───────────────────────────────────────────────────────────────

  async addConnection(idA: UUID, idB: UUID): Promise<Connection | null> {
    const id = this.workspaceId
    if (!id) return null
    const conn = await window.atelier.connection.add(id, idA, idB)
    if (conn) this.mutateWorkspace((ws) => ws.connections.push(conn))
    return conn
  }

  async removeConnection(connectionId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.connection.remove(id, connectionId)
    this.mutateWorkspace((ws) => {
      ws.connections = ws.connections.filter((c) => c.id !== connectionId)
    })
  }

  setConnectionStatus(connectionId: UUID, status: Connection['status']): void {
    this.mutateWorkspace((ws) => {
      ws.connections = ws.connections.map((c) => (c.id === connectionId ? { ...c, status } : c))
    })
  }

  // ─── Seleção e interação ────────────────────────────────────────────────────

  select(ids: UUID[]): void {
    this.set({ selection: ids })
  }

  toggleSelect(id: UUID): void {
    const sel = this.state.selection
    this.set({ selection: sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id] })
  }

  startConnecting(from: UUID | null): void {
    this.set({ connectingFrom: from })
  }

  /** Recarrega do main — usado quando o CLI muda o canvas por fora. */
  async reload(): Promise<void> {
    const id = this.state.activeId
    if (!id) return
    const workspace = await window.atelier.workspace.open(id)
    this.set({ workspace })
  }
}

export const store = new Store()

export function useStore(): AppSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
