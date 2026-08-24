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
  AgentRole,
  CanvasNode,
  Connection,
  Drawing,
  Preferences,
  Rect,
  TerminalDraft,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'
import { applyTheme, isThemeMode, type ThemeMode } from '../theme'

/**
 * Ferramenta ativa do canvas. 'select' é o comportamento de sempre (arrastar
 * nó, marquee, pan); as outras capturam o arrasto para desenhar/apagar.
 *
 * 'draw' é o MODO desenho da dock: não desenha sozinho — o clique no canvas
 * abre o menu que escolhe o que fazer naquele ponto (ver DrawMenu). É esse
 * passo intermediário que separa 'draw' de 'pen'/'highlighter'/'eraser', que
 * já são a ferramenta concreta e agem direto no arrasto.
 */
export type Tool = 'select' | 'draw' | 'pen' | 'highlighter' | 'eraser'

/** Ferramentas que o menu de desenho oferece — subconjunto acionável de Tool. */
export type DrawTool = Extract<Tool, 'pen' | 'highlighter' | 'eraser'>

export interface PenSettings {
  color: string
  lineWidth: number
}

export interface AppSnapshot {
  entries: WorkspaceEntry[]
  activeId: UUID | null
  workspace: WorkspacePayload | null
  selection: UUID[]
  /** Nó de origem enquanto o usuário arrasta uma conexão nova. */
  connectingFrom: UUID | null
  /** Sidebar recolhida — espelha preferences.sidebarCollapsed. */
  sidebarCollapsed: boolean
  /** Tema escolhido — espelha preferences.theme. */
  theme: ThemeMode
  /** Ferramenta ativa (caneta, marca-texto, borracha ou seleção). */
  tool: Tool
  pen: PenSettings
  /** Responsabilidades disponíveis (globais + as deste workspace). */
  roles: AgentRole[]
  /** Diálogo "Novo Terminal" aberto — a dock dispara, o App renderiza. */
  newTerminalOpen: boolean
  /** Espelho de preferences.json — hoje lido para os temas de terminal. */
  prefs: Preferences | null
  loading: boolean
  bootError: string | null
}

const initial: AppSnapshot = {
  entries: [],
  activeId: null,
  workspace: null,
  selection: [],
  connectingFrom: null,
  sidebarCollapsed: false,
  theme: 'system',
  tool: 'select',
  pen: { color: '#e0245e', lineWidth: 3 },
  roles: [],
  newTerminalOpen: false,
  prefs: null,
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
      const [{ entries, activeId }, prefs, roles] = await Promise.all([
        window.atelier.workspace.list(),
        window.atelier.prefs.get(),
        window.atelier.role.list()
      ])
      const id = activeId ?? entries[0]?.id ?? null
      const workspace = id ? await window.atelier.workspace.open(id) : null
      const theme = isThemeMode(prefs.theme) ? prefs.theme : 'system'
      applyTheme(theme)
      this.set({
        entries,
        activeId: id,
        workspace,
        roles,
        prefs,
        sidebarCollapsed: prefs.sidebarCollapsed,
        theme,
        loading: false
      })
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

  async renameWorkspace(id: UUID, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    const entries = await window.atelier.workspace.rename(id, trimmed)
    // O payload aberto também guarda o nome — é ele que alimenta a toolbar.
    const ws = this.state.workspace
    this.set({
      entries,
      workspace: ws && ws.id === id ? { ...ws, name: trimmed } : ws
    })
  }

  // ─── Nós ────────────────────────────────────────────────────────────────────

  get workspaceId(): UUID | null {
    return this.state.workspace?.id ?? null
  }

  private mutateWorkspace(fn: (ws: WorkspacePayload) => void): void {
    const ws = this.state.workspace
    if (!ws) return
    const next = {
      ...ws,
      nodes: [...ws.nodes],
      connections: [...ws.connections],
      drawings: [...ws.drawings]
    }
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

  // ─── Ferramentas e desenhos ─────────────────────────────────────────────────

  setTool(tool: Tool): void {
    // Trocar de ferramenta limpa a seleção: com a caneta ativa a alça de resize
    // e a borda de seleção só atrapalham.
    this.set({ tool, selection: tool === 'select' ? this.state.selection : [] })
  }

  setPen(patch: Partial<PenSettings>): void {
    this.set({ pen: { ...this.state.pen, ...patch } })
  }

  /** Traço concluído: persiste e insere no payload em memória. */
  async addDrawing(points: number[][], color: string, lineWidth: number): Promise<void> {
    const id = this.workspaceId
    if (!id || points.length < 2) return
    const drawing = await window.atelier.drawing.add(id, points, color, lineWidth)
    if (drawing) this.mutateWorkspace((ws) => ws.drawings.push(drawing))
  }

  async removeDrawing(drawingId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.drawing.remove(id, drawingId)
    this.mutateWorkspace((ws) => {
      ws.drawings = ws.drawings.filter((d) => d.id !== drawingId)
    })
  }

  async clearDrawings(): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.drawing.clear(id)
    this.mutateWorkspace((ws) => {
      ws.drawings = []
    })
  }

  /**
   * O diálogo mora no topo da árvore (App), não na dock: `.dock` tem transform
   * e backdrop-filter, e os dois viram bloco contedor de `position: fixed` —
   * o overlay ficaria preso dentro da pill.
   */
  openNewTerminal(): void {
    this.set({ newTerminalOpen: true })
  }

  closeNewTerminal(): void {
    this.set({ newTerminalOpen: false })
  }

  /**
   * Cria o terminal já com tudo que o diálogo coletou. Passa por node.add como
   * qualquer outro nó — o main é que valida a responsabilidade e monta o
   * TerminalContent.
   */
  async createTerminal(draft: TerminalDraft, position: { x: number; y: number }): Promise<CanvasNode | null> {
    return this.addNode('terminal', position, { ...draft })
  }

  // ─── Responsabilidades (agentes) ────────────────────────────────────────────

  async saveRole(patch: Partial<AgentRole> & { name: string }): Promise<AgentRole> {
    const saved = await window.atelier.role.save(patch)
    const roles = await window.atelier.role.list()
    this.set({ roles })
    return saved
  }

  async removeRole(id: UUID): Promise<void> {
    const roles = await window.atelier.role.remove(id)
    this.set({ roles })
    // O main limpou o assignedRoleId dos terminais que apontavam para ela
    await this.reload()
  }

  // ─── Preferências ───────────────────────────────────────────────────────────

  async patchPrefs(patch: Partial<Preferences>): Promise<void> {
    const prefs = await window.atelier.prefs.set(patch)
    this.set({ prefs })
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

  /** Otimista: a UI reage na hora, o preferences.json é gravado em seguida. */
  toggleSidebar(): void {
    const collapsed = !this.state.sidebarCollapsed
    this.set({ sidebarCollapsed: collapsed })
    this.mirrorPrefs({ sidebarCollapsed: collapsed })
    void window.atelier.prefs.set({ sidebarCollapsed: collapsed })
  }

  setTheme(theme: ThemeMode): void {
    applyTheme(theme)
    this.set({ theme })
    this.mirrorPrefs({ theme })
    void window.atelier.prefs.set({ theme })
  }

  /** Espelho local de preferences.json — sem isto `prefs` envelhece na store. */
  private mirrorPrefs(patch: Partial<Preferences>): void {
    const prefs = this.state.prefs
    if (prefs) this.set({ prefs: { ...prefs, ...patch } })
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
