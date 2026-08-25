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
  CanvasNode,
  Connection,
  Drawing,
  Point,
  Preferences,
  Rect,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'

type NewNodeKind = 'terminal' | 'note' | 'text' | 'portal' | 'fileTree'
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
    write: (nodeId: UUID, data: string): Promise<void> =>
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
      ipcRenderer.invoke('portal:open-external', url)
  },

  note: {
    read: (workspaceId: UUID, fileName: string): Promise<string> =>
      ipcRenderer.invoke('note:read', workspaceId, fileName),
    write: (workspaceId: UUID, fileName: string, content: string): Promise<void> =>
      ipcRenderer.invoke('note:write', workspaceId, fileName, content),
    onChanged: (cb: (p: { workspaceId: UUID; nodeId: UUID }) => void): Unsubscribe =>
      on('note:changed', cb)
  },

  events: {
    onWorkspaceChanged: (cb: (p: { workspaceId: UUID }) => void): Unsubscribe =>
      on('workspace:changed', cb),
    onConnectionStatus: (cb: (p: { id: UUID; status: string }) => void): Unsubscribe =>
      on('connection:status', cb)
  }
}

export type AtelierAPI = typeof api

contextBridge.exposeInMainWorld('atelier', api)
