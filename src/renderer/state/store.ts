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
  AgentStatus,
  CanvasNode,
  Connection,
  DiscoveredProject,
  Drawing,
  Preferences,
  Project,
  Rect,
  TerminalDraft,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'
import { DESCRIBE_PROJECTS_ENABLED } from '../feature-flags'
import { applyTheme, isThemeMode, type ThemeMode } from '../theme'

/**
 * Ferramenta ativa do canvas. 'select' é o comportamento de sempre (arrastar
 * nó, marquee, pan); as outras capturam o arrasto para desenhar/apagar.
 *
 * 'pan' é a mão travada: o mesmo que segurar espaço, mas sem segurar nada. O
 * botão da dock alterna entre ele e 'select', e o arrasto em área vazia move o
 * quadro em vez de abrir o marquee.
 *
 * 'draw' é o MODO desenho da dock: não desenha sozinho — o clique no canvas
 * abre o menu que escolhe o que fazer naquele ponto (ver DrawMenu). É esse
 * passo intermediário que separa 'draw' de 'pen'/'highlighter'/'eraser', que
 * já são a ferramenta concreta e agem direto no arrasto.
 */
export type Tool = 'select' | 'pan' | 'draw' | 'pen' | 'highlighter' | 'eraser'

/**
 * Aba aberta no painel lateral. Mora na store, e não no componente, porque
 * outras partes precisam mandar a aba mudar — o menu de contexto de um projeto
 * abre a árvore dele, e o vazio da aba Arquivos manda de volta para Projetos.
 */
export type SidebarTab = 'workspaces' | 'projetos' | 'arquivos' | 'git'

/** Ferramentas que o menu de desenho oferece — subconjunto acionável de Tool. */
export type DrawTool = Extract<Tool, 'pen' | 'highlighter' | 'eraser'>

export interface PenSettings {
  color: string
  lineWidth: number
}

/**
 * Intenção de criar um componente, pendurada até o usuário desenhar a área.
 *
 * O `finish` vem de quem pediu (a dock): assim o canvas só cuida do gesto, e
 * cada item continua dono da própria receita de criação — inclusive as que
 * abrem diálogo depois da área, como Terminal e Documento PDF.
 */
export interface Placement {
  /** Aparece na dica: "arraste para definir a área do terminal". */
  label: string
  /** Tamanho usado quando o gesto é um clique, sem arrasto. */
  defaultSize: [number, number]
  /** Piso do tipo: área menor que isto é elevada antes de virar nó. */
  minSize: [number, number]
  finish: (frame: Rect) => void
}

export interface AppSnapshot {
  entries: WorkspaceEntry[]
  activeId: UUID | null
  workspace: WorkspacePayload | null
  selection: UUID[]
  /** Nó de origem enquanto o usuário arrasta uma conexão nova. */
  connectingFrom: UUID | null
  /** Componente esperando o usuário desenhar a área onde vai nascer. */
  placing: Placement | null
  /** Sidebar recolhida — espelha preferences.sidebarCollapsed. */
  sidebarCollapsed: boolean
  sidebarTab: SidebarTab
  /** Tema escolhido — espelha preferences.theme. */
  theme: ThemeMode
  /** Ferramenta ativa (caneta, marca-texto, borracha ou seleção). */
  tool: Tool
  pen: PenSettings
  /** Responsabilidades disponíveis (globais + as deste workspace). */
  roles: AgentRole[]
  /** Diálogo "Novo Terminal" aberto — a dock dispara, o App renderiza. */
  newTerminalOpen: boolean
  /** Área desenhada antes do diálogo abrir — o terminal nasce nela. */
  newTerminalFrame: Rect | null
  /** Terminal aberto no diálogo em modo edição. null = ninguém editando. */
  editTerminalId: UUID | null
  /**
   * Geração de cada terminal. Recarregar incrementa: o TerminalNode tem isso
   * nas deps do efeito, então o xterm é derrubado e o PTY sobe de novo.
   */
  terminalEpoch: Record<UUID, number>
  /** Linha de status lida da tela de cada agente — o que o rodapé do nó mostra. */
  terminalStatus: Record<UUID, AgentStatus>
  /**
   * Diretório com que o próximo "Novo Terminal" nasce. É assim que um projeto
   * passa o cwd para o agente: no momento da criação, não por cabo — o formato
   * em disco não tem array de conexão para o par projeto↔terminal.
   */
  newTerminalCwd: string | null
  /** Índice de projetos (global, não pertence ao workspace). */
  projects: Project[]
  projectQuery: string
  /**
   * Projeto escolhido no painel — é dele que a aba Arquivos mostra a árvore.
   * Guarda o id, não o objeto: assim um re-scan que atualize o projeto não
   * deixa a aba olhando para uma cópia velha.
   */
  selectedProjectId: UUID | null
  /**
   * Há varredura em andamento. O PROGRESSO não entra aqui: a ~7Hz ele
   * re-renderizaria o canvas inteiro a cada evento. O painel assina
   * onScanProgress localmente.
   */
  scanning: boolean
  scanDialogOpen: boolean
  /** Projetos que a varredura do boot achou e que aguardam resposta do usuário. */
  candidates: DiscoveredProject[]
  /**
   * Ao fim da varredura, sobe o agente que descreve os projetos. Hoje sempre
   * false — ver DESCRIBE_PROJECTS_ENABLED em renderer/feature-flags.ts.
   */
  autoDescribe: boolean
  /** Espelho de preferences.json — hoje lido para os temas de terminal. */
  prefs: Preferences | null
  /** Aviso passageiro na barra — some sozinho. */
  notice: string | null
  /**
   * Integridade do arquivo do workspace aberto. `safeMode` significa que o
   * decoder descartou nós que não entendeu: o autosave está desligado e salvar
   * apagaria esses nós. null = ainda não consultado.
   */
  integrity: { safeMode: boolean; droppedNodes: number; fileSchemaVersion: number } | null
  loading: boolean
  bootError: string | null
}

const initial: AppSnapshot = {
  entries: [],
  activeId: null,
  workspace: null,
  selection: [],
  connectingFrom: null,
  placing: null,
  sidebarCollapsed: false,
  sidebarTab: 'workspaces',
  theme: 'system',
  tool: 'select',
  pen: { color: '#e0245e', lineWidth: 3 },
  roles: [],
  newTerminalOpen: false,
  newTerminalFrame: null,
  editTerminalId: null,
  terminalEpoch: {},
  terminalStatus: {},
  newTerminalCwd: null,
  projects: [],
  projectQuery: '',
  selectedProjectId: null,
  scanning: false,
  scanDialogOpen: false,
  candidates: [],
  autoDescribe: DESCRIBE_PROJECTS_ENABLED,
  prefs: null,
  notice: null,
  integrity: null,
  loading: true,
  bootError: null
}

class Store {
  private state: AppSnapshot = initial
  private listeners = new Set<() => void>()
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  /** Esta varredura pediu descrição automática? Ver startScan/finishScan. */
  private armedAutoDescribe = false

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
      const integrity = id ? await window.atelier.workspace.integrity(id) : null
      const theme = isThemeMode(prefs.theme) ? prefs.theme : 'system'
      applyTheme(theme)
      this.set({
        entries,
        activeId: id,
        workspace,
        integrity,
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
    const integrity = await window.atelier.workspace.integrity(id)
    this.set({ workspace, integrity, activeId: id, selection: [] })
  }

  /**
   * O botão Salvar da barra. É a ÚNICA porta que grava um workspace em modo
   * seguro — por isso ele reconsulta a integridade depois: uma vez gravado, o
   * arquivo já não tem o que não era entendido, e a faixa some.
   */
  async saveNow(): Promise<void> {
    await window.atelier.workspace.saveNow()
    const id = this.state.activeId
    if (id) this.set({ integrity: await window.atelier.workspace.integrity(id) })
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
    opts: Record<string, unknown> = {},
    size?: { width: number; height: number }
  ): Promise<CanvasNode | null> {
    const id = this.workspaceId
    if (!id) return null
    const created = await window.atelier.node.add(id, kind, position, opts, size)
    if (!created) return null

    // O renderer é quem manda no tamanho: ele já aplicou o piso do tipo antes
    // de pedir. Se o nó voltou com outra medida, a ponte não entendeu o pedido
    // (é o que acontece com um preload velho, em dev sem reiniciar) — corrige
    // em vez de deixar o usuário com um nó do tamanho errado.
    let node = created
    if (size && (created.frame.width !== size.width || created.frame.height !== size.height)) {
      const frame = { ...created.frame, width: size.width, height: size.height }
      await window.atelier.node.setFrame(id, created.id, frame)
      node = { ...created, frame }
    }

    this.mutateWorkspace((ws) => ws.nodes.push(node))
    this.set({ selection: [node.id] })
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
    // e a borda de seleção só atrapalham. 'pan' é exceção — mover o quadro não
    // é motivo para largar o que estava selecionado.
    const keeps = tool === 'select' || tool === 'pan'
    this.set({ tool, selection: keeps ? this.state.selection : [] })
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
  openNewTerminal(frame: Rect | null = null, workingDirectory: string | null = null): void {
    this.set({ newTerminalOpen: true, newTerminalFrame: frame, newTerminalCwd: workingDirectory })
  }

  closeNewTerminal(): void {
    this.set({ newTerminalOpen: false, newTerminalFrame: null, newTerminalCwd: null })
  }

  // ─── Projetos ───────────────────────────────────────────────────────────────

  async loadProjects(): Promise<void> {
    this.set({ projects: await window.atelier.project.list() })
  }

  setProjectQuery(projectQuery: string): void {
    this.set({ projectQuery })
  }

  selectProject(selectedProjectId: UUID | null): void {
    this.set({ selectedProjectId })
  }

  setSidebarTab(sidebarTab: SidebarTab): void {
    this.set({ sidebarTab })
  }

  /** Seleciona e abre a árvore dele — o par que o menu de contexto usa. */
  showProjectFiles(id: UUID): void {
    this.set({ selectedProjectId: id, sidebarTab: 'arquivos' })
  }

  /** Abre o Git já apontado para este projeto — o menu de contexto usa isto. */
  showProjectGit(id: UUID): void {
    this.set({ selectedProjectId: id, sidebarTab: 'git' })
  }

  /**
   * O caminho comum: apontar UMA pasta. Abre o seletor nativo e indexa o que
   * voltar. Devolve a mensagem de erro, ou null quando deu certo — e também
   * quando o usuário cancelou, que não é erro.
   */
  async addProjectFolder(): Promise<{ error?: string; added?: Project }> {
    const chosen = await window.atelier.dialog.chooseDirectory()
    if (!chosen) return {}
    const result = await window.atelier.project.addFolder(chosen)
    if ('error' in result) return { error: result.error }
    await this.loadProjects()
    return { added: result.project }
  }

  // ─── Projetos novos achados no boot ────────────────────────────────────────

  setCandidates(candidates: DiscoveredProject[]): void {
    this.set({ candidates })
  }

  async loadCandidates(): Promise<void> {
    this.set({ candidates: await window.atelier.project.candidates() })
  }

  async acceptCandidates(paths: string[]): Promise<void> {
    const projects = await window.atelier.project.acceptCandidates(paths)
    // O card fecha inteiro: quem desmarcou um item já respondeu sobre ele. O
    // desmarcado não é ignorado — volta a ser oferecido na próxima abertura.
    this.set({ projects, candidates: [] })
  }

  async ignoreCandidates(): Promise<void> {
    await window.atelier.project.ignoreCandidates(this.state.candidates.map((c) => c.path))
    this.set({ candidates: [] })
  }

  /** Fecha sem responder: a próxima abertura pergunta de novo. */
  dismissCandidates(): void {
    this.set({ candidates: [] })
  }

  async setAutoScanOnLaunch(autoScanOnLaunch: boolean): Promise<void> {
    const prefs = await window.atelier.prefs.set({ autoScanOnLaunch })
    this.set({ prefs })
  }

  /** O botão do aviso: desliga e fecha, com o caminho de volta na mensagem. */
  async disableAutoScan(): Promise<void> {
    await this.setAutoScanOnLaunch(false)
    this.set({ candidates: [] })
    this.showNotice('varredura automática desligada — religa no menu ⋮ da aba Projetos')
  }

  openScanDialog(): void {
    this.set({ scanDialogOpen: true })
  }

  closeScanDialog(): void {
    this.set({ scanDialogOpen: false })
  }

  setAutoDescribe(autoDescribe: boolean): void {
    this.set({ autoDescribe })
  }

  async startScan(input: { mode: 'folder' | 'home'; path?: string; maxDepth?: number }): Promise<string | null> {
    const result = await window.atelier.project.scanStart(input)
    if ('error' in result) return result.error
    // Armado no início e consumido no fim: um toggle no diálogo enquanto a
    // varredura roda não muda o que ESTA varredura combinou de fazer.
    this.armedAutoDescribe = this.state.autoDescribe
    this.set({ scanning: true, scanDialogOpen: false })
    return null
  }

  cancelScan(): void {
    this.armedAutoDescribe = false
    void window.atelier.project.scanCancel()
  }

  /**
   * Chamado pelo evento scan-done: recarrega o índice e desarma o estado.
   * Devolve `true` quando o painel deve subir o agente que descreve — só faz
   * sentido se sobrou fila e há workspace aberto para receber o nó.
   */
  async finishScan(): Promise<boolean> {
    const armed = this.armedAutoDescribe
    this.armedAutoDescribe = false
    this.set({ scanning: false })
    await this.loadProjects()
    const pending = this.state.projects.some((p) => !p.isArchived && !p.enrichedAt)
    return armed && pending && this.workspaceId !== null
  }

  async patchProject(id: UUID, patch: Partial<Project>): Promise<void> {
    await window.atelier.project.patch(id, patch)
    await this.loadProjects()
  }

  async removeProject(id: UUID): Promise<void> {
    const projects = await window.atelier.project.remove(id)
    this.set({
      projects,
      selectedProjectId: this.state.selectedProjectId === id ? null : this.state.selectedProjectId
    })
  }

  /**
   * Cria o agente que descreve os projetos. O comando vem do preset escolhido
   * pelo usuário, não é fixo: nem todo mundo usa o mesmo agente.
   */
  async startScannerAgent(position: { x: number; y: number }, command: string): Promise<string | null> {
    const workspaceId = this.workspaceId
    if (!workspaceId) return 'nenhum workspace aberto'
    const result = await window.atelier.project.startScanner(workspaceId, position, command)
    if ('error' in result) return result.error
    await this.reload()
    this.set({ selection: [result.node.id] })
    return null
  }

  async addProjectToWorkspace(id: UUID, position: { x: number; y: number }): Promise<CanvasNode | null> {
    const workspaceId = this.workspaceId
    if (!workspaceId) return null
    const node = await window.atelier.project.addToWorkspace(workspaceId, id, position)
    if (node) {
      this.mutateWorkspace((ws) => ws.nodes.push(node))
      this.set({ selection: [node.id] })
    }
    await this.loadProjects()
    return node
  }

  /**
   * Cria o terminal já com tudo que o diálogo coletou. Passa por node.add como
   * qualquer outro nó — o main é que valida a responsabilidade e monta o
   * TerminalContent.
   */
  async createTerminal(
    draft: TerminalDraft,
    position: { x: number; y: number },
    size?: { width: number; height: number }
  ): Promise<CanvasNode | null> {
    return this.addNode('terminal', position, { ...draft }, size)
  }

  openEditTerminal(nodeId: UUID): void {
    this.set({ editTerminalId: nodeId })
  }

  closeEditTerminal(): void {
    this.set({ editTerminalId: null })
  }

  /**
   * Grava o rascunho por cima do terminal existente. Os campos do TerminalDraft
   * são os mesmos do TerminalContent, então o patch raso dá conta.
   *
   * Comando, diretório e shell só valem no próximo boot do PTY: mexer neles não
   * mata o processo em andamento — quem decide isso é o botão de recarregar.
   */
  async saveTerminal(nodeId: UUID, draft: TerminalDraft): Promise<void> {
    await this.patchContent(nodeId, { ...draft })
    this.set({ editTerminalId: null })
  }

  /** Mata o PTY e sobe outro no lugar, com o conteúdo atual do nó. */
  async restartTerminal(nodeId: UUID): Promise<void> {
    await window.atelier.terminal.kill(nodeId)
    const epoch = this.state.terminalEpoch
    // Sessão nova, contadores zerados: os do processo velho não valem mais.
    const status = { ...this.state.terminalStatus }
    delete status[nodeId]
    this.set({ terminalEpoch: { ...epoch, [nodeId]: (epoch[nodeId] ?? 0) + 1 }, terminalStatus: status })
  }

  /**
   * Mostra um aviso na barra por alguns segundos.
   *
   * Existe porque falha de IPC no renderer não tem para onde ir: sem isto, uma
   * chamada que rejeita vira `void` engolido e o usuário fica achando que o
   * clique não fez nada.
   */
  showNotice(text: string): void {
    this.set({ notice: text })
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), 7000)
  }

  dismissNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.set({ notice: null })
  }

  setTerminalStatus(nodeId: UUID, status: AgentStatus): void {
    this.set({ terminalStatus: { ...this.state.terminalStatus, [nodeId]: status } })
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
  /**
   * Largura do painel. Chamada UMA vez, no fim do arrasto — durante o gesto
   * quem manda na largura é o CSS var, escrito direto no documento.
   */
  async setSidebarWidth(sidebarWidth: number): Promise<void> {
    const prefs = await window.atelier.prefs.set({ sidebarWidth })
    this.set({ prefs })
  }

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
    // Os dois modos disputam o mesmo clique no canvas: entrar num cancela o outro.
    this.set({ connectingFrom: from, placing: from ? null : this.state.placing })
  }

  /** Liga o modo "desenhe a área": o próximo arrasto no canvas cria o nó. */
  startPlacing(placing: Placement): void {
    this.set({ placing, connectingFrom: null, selection: [] })
  }

  cancelPlacing(): void {
    if (this.state.placing) this.set({ placing: null })
  }

  /** Chamado pelo canvas quando a área ficou pronta. */
  completePlacing(frame: Rect): void {
    const placing = this.state.placing
    if (!placing) return
    this.set({ placing: null })
    placing.finish(frame)
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
