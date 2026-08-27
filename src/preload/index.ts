/**
 * Ponte tipada renderer ⇄ main.
 *
 * contextIsolation está ligado: o renderer não tem `require`, não tem `fs` e
 * não fala com o PTY. Só existe o que está exposto aqui.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentRole,
  AgentStatus,
  BootInfo,
  FileOpError,
  CanvasNode,
  DiscoveredProject,
  Connection,
  Drawing,
  FsEntry,
  GitCommitEntry,
  GitStatus,
  Point,
  Project,
  Preferences,
  Rect,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'
import type { DataTablePayload } from '@shared/data-table'

type NewNodeKind = 'terminal' | 'note' | 'text' | 'portal' | 'fileTree' | 'codeEditor' | 'dataTable'

/** `ok` diz se a ação passou; `message` é o que o git respondeu, resumido. */
interface GitActionResult {
  ok: boolean
  message: string
}
type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  bootInfo: (): Promise<BootInfo> => ipcRenderer.invoke('app:boot-info'),

  prefs: {
    get: (): Promise<Preferences> => ipcRenderer.invoke('prefs:get'),
    set: (patch: Partial<Preferences>): Promise<Preferences> => ipcRenderer.invoke('prefs:set', patch)
  },

  workspace: {
    list: (): Promise<{ entries: WorkspaceEntry[]; activeId: UUID | null }> =>
      ipcRenderer.invoke('workspace:list'),
    open: (id: UUID): Promise<WorkspacePayload | null> => ipcRenderer.invoke('workspace:open', id),
    create: (name: string, dir: string): Promise<{ entries: WorkspaceEntry[]; workspace: WorkspacePayload }> =>
      ipcRenderer.invoke('workspace:create', name, dir),
    rename: (id: UUID, name: string): Promise<WorkspaceEntry[]> =>
      ipcRenderer.invoke('workspace:rename', id, name),
    remove: (id: UUID): Promise<WorkspaceEntry[]> => ipcRenderer.invoke('workspace:delete', id),
    saveNow: (): Promise<number> => ipcRenderer.invoke('workspace:save-now'),
    /** Modo seguro: o arquivo tem nós que este binário não entende. */
    integrity: (
      id: UUID
    ): Promise<{ safeMode: boolean; droppedNodes: number; fileSchemaVersion: number } | null> =>
      ipcRenderer.invoke('workspace:integrity', id),
    setViewport: (id: UUID, origin: Point, zoom: number): Promise<void> =>
      ipcRenderer.invoke('viewport:set', id, origin, zoom)
  },

  node: {
    add: (
      workspaceId: UUID,
      kind: NewNodeKind,
      position: Point,
      opts?: Record<string, unknown>,
      size?: { width: number; height: number }
    ): Promise<CanvasNode | null> =>
      ipcRenderer.invoke('node:add', workspaceId, kind, position, opts ?? {}, size),
    remove: (workspaceId: UUID, nodeId: UUID): Promise<void> =>
      ipcRenderer.invoke('node:remove', workspaceId, nodeId),
    setFrame: (workspaceId: UUID, nodeId: UUID, frame: Rect): Promise<void> =>
      ipcRenderer.invoke('node:set-frame', workspaceId, nodeId, frame),
    bringToFront: (workspaceId: UUID, nodeId: UUID): Promise<void> =>
      ipcRenderer.invoke('node:bring-to-front', workspaceId, nodeId),
    patchContent: (
      workspaceId: UUID,
      nodeId: UUID,
      patch: Record<string, unknown>
    ): Promise<CanvasNode | null> =>
      ipcRenderer.invoke('node:patch-content', workspaceId, nodeId, patch)
  },

  role: {
    list: (): Promise<AgentRole[]> => ipcRenderer.invoke('role:list'),
    /** Cria quando `patch.id` é ausente, atualiza quando existe. */
    save: (patch: Partial<AgentRole> & { name: string }): Promise<AgentRole> =>
      ipcRenderer.invoke('role:save', patch),
    remove: (id: UUID): Promise<AgentRole[]> => ipcRenderer.invoke('role:delete', id)
  },

  dialog: {
    chooseDirectory: (current?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:choose-directory', current),
    /** Arquivo + a URL `file://` pronta para o <webview>. null = cancelou. */
    chooseFile: (
      filters?: { name: string; extensions: string[] }[]
    ): Promise<{ path: string; url: string } | null> =>
      ipcRenderer.invoke('dialog:choose-file', filters)
  },

  connection: {
    add: (workspaceId: UUID, idA: UUID, idB: UUID): Promise<Connection | null> =>
      ipcRenderer.invoke('connection:add', workspaceId, idA, idB),
    remove: (workspaceId: UUID, connectionId: UUID): Promise<void> =>
      ipcRenderer.invoke('connection:remove', workspaceId, connectionId)
  },

  terminal: {
    spawn: (
      workspaceId: UUID,
      nodeId: UUID,
      cols: number,
      rows: number
    ): Promise<{ buffer?: string; status?: AgentStatus; error?: string }> =>
      ipcRenderer.invoke('terminal:spawn', workspaceId, nodeId, cols, rows),
    /** false = não havia PTY vivo para receber o texto. */
    write: (nodeId: UUID, data: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:write', nodeId, data),
    resize: (nodeId: UUID, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', nodeId, cols, rows),
    kill: (nodeId: UUID): Promise<void> => ipcRenderer.invoke('terminal:kill', nodeId),
    buffer: (nodeId: UUID): Promise<string> => ipcRenderer.invoke('terminal:buffer', nodeId),
    onData: (cb: (p: { id: UUID; data: string }) => void): Unsubscribe => on('terminal:data', cb),
    onExit: (cb: (p: { id: UUID; code: number }) => void): Unsubscribe => on('terminal:exit', cb),
    /** Linha de status do agente (tokens, contexto, limites); muda pouco. */
    onStatus: (cb: (p: { id: UUID; status: AgentStatus }) => void): Unsubscribe =>
      on('terminal:status', cb)
  },

  drawing: {
    add: (
      workspaceId: UUID,
      points: number[][],
      color: string,
      lineWidth: number
    ): Promise<Drawing | null> =>
      ipcRenderer.invoke('drawing:add', workspaceId, points, color, lineWidth),
    remove: (workspaceId: UUID, drawingId: UUID): Promise<void> =>
      ipcRenderer.invoke('drawing:remove', workspaceId, drawingId),
    clear: (workspaceId: UUID): Promise<void> => ipcRenderer.invoke('drawing:clear', workspaceId)
  },

  portal: {
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('portal:open-external', url),
    /** `dom-ready` do webview: diz ao main com qual webContents ele fala. */
    register: (nodeId: UUID, webContentsId: number): Promise<void> =>
      ipcRenderer.invoke('portal:register', nodeId, webContentsId),
    unregister: (nodeId: UUID): Promise<void> => ipcRenderer.invoke('portal:unregister', nodeId),
    /** O main pede que um portal adormecido (zoom/virtualização) seja montado. */
    onWake: (cb: (p: { nodeId: UUID }) => void): Unsubscribe => on('portal:wake', cb)
  },

  note: {
    read: (workspaceId: UUID, fileName: string): Promise<string> =>
      ipcRenderer.invoke('note:read', workspaceId, fileName),
    write: (workspaceId: UUID, fileName: string, content: string): Promise<void> =>
      ipcRenderer.invoke('note:write', workspaceId, fileName, content),
    onChanged: (cb: (p: { workspaceId: UUID; nodeId: UUID }) => void): Unsubscribe =>
      on('note:changed', cb)
  },

  /** Tabelas de resultado (`atelier table`). Colunas e linhas num JSON gerenciado. */
  table: {
    read: (workspaceId: UUID, fileName: string): Promise<DataTablePayload | null> =>
      ipcRenderer.invoke('table:read', workspaceId, fileName),
    write: (workspaceId: UUID, fileName: string, value: DataTablePayload): Promise<void> =>
      ipcRenderer.invoke('table:write', workspaceId, fileName, value),
    onChanged: (cb: (p: { workspaceId: UUID; nodeId: UUID }) => void): Unsubscribe =>
      on('table:changed', cb)
  },

  project: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('project:list'),
    addFolder: (path: string): Promise<{ project: Project } | { error: string }> =>
      ipcRenderer.invoke('project:add-folder', path),
    candidates: (): Promise<DiscoveredProject[]> => ipcRenderer.invoke('project:candidates'),
    acceptCandidates: (paths: string[]): Promise<Project[]> =>
      ipcRenderer.invoke('project:accept-candidates', paths),
    ignoreCandidates: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke('project:ignore-candidates', paths),
    scanStart: (input: { mode: 'folder' | 'home'; path?: string; maxDepth?: number }): Promise<{ scanId: UUID } | { error: string }> =>
      ipcRenderer.invoke('project:scan-start', input),
    scanCancel: (scanId?: UUID): Promise<void> => ipcRenderer.invoke('project:scan-cancel', scanId),
    scanStatus: (): Promise<{ scanId: UUID; mode: string; roots: string[] } | null> =>
      ipcRenderer.invoke('project:scan-status'),
    patch: (id: UUID, patch: Partial<Project>): Promise<Project | null> =>
      ipcRenderer.invoke('project:patch', id, patch),
    remove: (id: UUID): Promise<Project[]> => ipcRenderer.invoke('project:remove', id),
    addToWorkspace: (workspaceId: UUID, id: UUID, position: Point): Promise<CanvasNode | null> =>
      ipcRenderer.invoke('project:add-to-workspace', workspaceId, id, position),
    startScanner: (
      workspaceId: UUID,
      position: Point,
      command: string
    ): Promise<{ node: CanvasNode } | { error: string }> =>
      ipcRenderer.invoke('project:start-scanner', workspaceId, position, command)
  },

  /**
   * Git. Todo método recebe um caminho dentro do repositório — o processo
   * principal resolve a raiz e confere a allowlist; o renderer não escolhe
   * comando nem monta linha de comando.
   */
  git: {
    status: (path: string): Promise<GitStatus | { error: string }> =>
      ipcRenderer.invoke('git:status', path),
    /** O que a árvore de arquivos marca: não versionado e modificado. */
    treeStatus: (
      path: string
    ): Promise<
      { root: string; unversioned: string[]; changed: string[] } | { error: string }
    > => ipcRenderer.invoke('git:tree-status', path),
    stage: (path: string, paths: string[]): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:stage', path, paths),
    stageAll: (path: string): Promise<GitActionResult> => ipcRenderer.invoke('git:stage-all', path),
    unstage: (path: string, paths: string[]): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:unstage', path, paths),
    unstageAll: (path: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:unstage-all', path),
    /** Destrutivo: rastreados voltam ao HEAD, não-rastreados são apagados. */
    discard: (path: string, tracked: string[], untracked: string[]): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:discard', path, tracked, untracked),
    commit: (path: string, message: string, amend?: boolean): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:commit', path, message, amend === true),
    pull: (path: string): Promise<GitActionResult> => ipcRenderer.invoke('git:pull', path),
    fetch: (path: string): Promise<GitActionResult> => ipcRenderer.invoke('git:fetch', path),
    push: (path: string): Promise<GitActionResult> => ipcRenderer.invoke('git:push', path),
    log: (path: string, limit?: number): Promise<{ commits: GitCommitEntry[] } | { error: string }> =>
      ipcRenderer.invoke('git:log', path, limit),
    diff: (path: string, file: string, staged: boolean): Promise<{ patch: string } | { error: string }> =>
      ipcRenderer.invoke('git:diff', path, file, staged),
    branches: (path: string): Promise<{ names: string[]; current: string | null } | { error: string }> =>
      ipcRenderer.invoke('git:branches', path),
    switchTo: (path: string, name: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:switch', path, name),
    createBranch: (path: string, name: string): Promise<GitActionResult> =>
      ipcRenderer.invoke('git:create-branch', path, name)
  },

  fs: {
    listDir: (
      path: string
    ): Promise<{ entries: FsEntry[]; truncated: number } | { error: string }> =>
      ipcRenderer.invoke('fs:list-dir', path),
    reveal: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:reveal', path),
    /** URL `file://` do caminho — o que o <webview> de um PDF precisa. */
    fileUrl: (path: string): Promise<{ url: string } | { error: FileOpError }> =>
      ipcRenderer.invoke('fs:file-url', path),
    /** Texto do arquivo, ou o motivo da recusa (grande demais, binário, …). */
    readFile: (path: string): Promise<{ text: string; bytes: number } | { error: FileOpError }> =>
      ipcRenderer.invoke('fs:read-file', path),
    writeFile: (path: string, text: string): Promise<{ ok: true } | { error: FileOpError }> =>
      ipcRenderer.invoke('fs:write-file', path, text),
    /** Renomear e mover são a mesma coisa: `to` é o caminho final. */
    rename: (from: string, to: string): Promise<{ ok: true; path: string } | { error: FileOpError }> =>
      ipcRenderer.invoke('fs:rename', from, to),
    duplicate: (path: string): Promise<{ ok: true; path: string } | { error: FileOpError }> =>
      ipcRenderer.invoke('fs:duplicate', path),
    /** Lixeira do sistema — reversível. Nunca apaga de verdade. */
    trash: (path: string): Promise<{ ok: true } | { error: FileOpError }> =>
      ipcRenderer.invoke('fs:trash', path),
    /** Vigia UM arquivo (o aberto no editor). Nunca uma árvore. */
    watch: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:watch', path),
    unwatch: (path: string): Promise<void> => ipcRenderer.invoke('fs:unwatch', path),
    onFileChanged: (cb: (p: { path: string }) => void): Unsubscribe => on('fs:file-changed', cb),
    onFileRemoved: (cb: (p: { path: string }) => void): Unsubscribe => on('fs:file-removed', cb)
  },

  events: {
    onWorkspaceChanged: (cb: (p: { workspaceId: UUID }) => void): Unsubscribe =>
      on('workspace:changed', cb),
    onConnectionStatus: (cb: (p: { id: UUID; status: string }) => void): Unsubscribe =>
      on('connection:status', cb),
    onScanProgress: (
      cb: (p: { scanId: UUID; scannedDirs: number; found: number; currentPath: string; elapsedMs: number }) => void
    ): Unsubscribe => on('project:scan-progress', cb),
    onScanDone: (
      cb: (p: { scanId: UUID; added: number; updated: number; archived: number; stopped: string }) => void
    ): Unsubscribe => on('project:scan-done', cb),
    onProjectsChanged: (cb: (p: { ids: UUID[] }) => void): Unsubscribe => on('project:changed', cb),
    onProjectCandidates: (cb: (p: { candidates: DiscoveredProject[] }) => void): Unsubscribe =>
      on('project:candidates', cb)
  }
}

export type AtelierAPI = typeof api

contextBridge.exposeInMainWorld('atelier', api)
