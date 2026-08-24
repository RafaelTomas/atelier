/**
 * Superfície IPC renderer → main.
 *
 * O renderer NUNCA toca em disco, em PTY ou em socket: tudo passa por aqui,
 * o que preserva a regra do app nativo de que toda I/O é centralizada.
 */
import { ipcMain, shell } from 'electron'
import type { CanvasNode, NodeContent, Point, Rect, UUID } from '@shared/types'
import { Constants } from '../core/constants'
import { log } from '../core/logger'
import {
  makeFileTreeContent,
  makePortalContent,
  makeStickyNoteContent,
  makeTerminalContent,
  makeTextContent
} from '../core/models/node-content'
import { makeCanvasNode, makeDrawing } from '../core/models/workspace'
import { persistence } from '../core/persistence/persistence-manager'
import { ipcSocketPath, dataDir } from '../core/persistence/paths'
import { appState } from '../core/state/app-state'
import { ptyUnavailableReason, terminals } from '../core/terminal/terminal-manager'
import { interAgentServer } from '../core/interagent/server'
import { onConnectionCreated, restoreConnections } from '../core/connection/connection-manager'
import { forgetTerminal } from '../core/connection/skill-injector'
import { notifyRenderer } from './notify'

type NewNodeKind = 'terminal' | 'note' | 'text' | 'portal' | 'fileTree'

function contentFor(kind: NewNodeKind, opts: Record<string, unknown>): NodeContent {
  switch (kind) {
    case 'terminal':
      return {
        type: 'terminal',
        value: makeTerminalContent(String(opts.name ?? 'Terminal'), {
          agentType: String(opts.agentType ?? 'generic_shell'),
          command: String(opts.command ?? ''),
          workingDirectory: String(opts.workingDirectory ?? '')
        })
      }
    case 'note':
      return { type: 'stickyNote', value: makeStickyNoteContent(String(opts.name ?? 'Note')) }
    case 'text':
      return { type: 'text', value: makeTextContent(String(opts.text ?? '')) }
    case 'portal':
      return {
        type: 'portal',
        value: makePortalContent(String(opts.name ?? 'Portal'), String(opts.url ?? ''))
      }
    case 'fileTree':
      return {
        type: 'fileTree',
        value: makeFileTreeContent(String(opts.name ?? 'Files'), String(opts.rootPath ?? ''))
      }
  }
}

function defaultSize(kind: NewNodeKind): { width: number; height: number } {
  switch (kind) {
    case 'terminal':
      return { width: 560, height: 360 }
    case 'note':
      return { width: Constants.noteDefaultWidth, height: Constants.noteDefaultHeight }
    case 'text':
      return { width: 240, height: 48 }
    case 'portal':
      return { width: 640, height: 440 }
    case 'fileTree':
      return { width: 300, height: 420 }
  }
}

export function registerIPC(): void {
  // ─── App ────────────────────────────────────────────────────────────────────

  ipcMain.handle('app:boot-info', () => ({
    serverPort: interAgentServer.port,
    socketPath: ipcSocketPath(),
    dataDir: dataDir(),
    platform: process.platform,
    needsRecovery: appState.needsRecovery
  }))

  ipcMain.handle('prefs:get', () => appState.preferences)

  ipcMain.handle('prefs:set', async (_e, patch: Record<string, unknown>) => {
    appState.preferences = { ...appState.preferences, ...patch }
    await persistence.savePreferences(appState.preferences)
    return appState.preferences
  })

  // ─── Workspaces ─────────────────────────────────────────────────────────────

  ipcMain.handle('workspace:list', () => ({
    entries: appState.manifest.workspaces,
    activeId: appState.data.activeWorkspaceId
  }))

  ipcMain.handle('workspace:open', async (_e, id: UUID) => {
    const ws = await appState.openWorkspace(id)
    if (!ws) return null
    restoreConnections(ws.id)
    return ws.snapshot()
  })

  ipcMain.handle('workspace:create', async (_e, name: string, workingDirectory: string) => {
    const ws = await appState.createWorkspace(name, workingDirectory)
    return { entries: appState.manifest.workspaces, workspace: ws.snapshot() }
  })

  ipcMain.handle('workspace:rename', async (_e, id: UUID, name: string) => {
    await appState.renameWorkspace(id, name)
    return appState.manifest.workspaces
  })

  ipcMain.handle('workspace:delete', async (_e, id: UUID) => {
    await appState.deleteWorkspace(id)
    return appState.manifest.workspaces
  })

  ipcMain.handle('workspace:save-now', async () => appState.saveDirtyWorkspaces())

  ipcMain.handle('viewport:set', (_e, id: UUID, origin: Point, zoom: number) => {
    appState.workspaces.get(id)?.setViewport(origin, zoom)
  })

  // ─── Nós ────────────────────────────────────────────────────────────────────

  ipcMain.handle(
    'node:add',
    async (
      _e,
      workspaceId: UUID,
      kind: NewNodeKind,
      position: Point,
      opts: Record<string, unknown> = {}
    ): Promise<CanvasNode | null> => {
      const ws = appState.workspaces.get(workspaceId)
      if (!ws) return null

      const size = defaultSize(kind)
      const content = contentFor(kind, opts)
      const node = makeCanvasNode({ x: position.x, y: position.y, ...size }, content)
      ws.addNode(node)

      // Nota nasce com arquivo .md em disco, como no app nativo
      if (content.type === 'stickyNote' && content.value.fileName) {
        await persistence.writeNote(ws.id, content.value.fileName, String(opts.content ?? ''))
      }
      return node
    }
  )

  ipcMain.handle('node:remove', (_e, workspaceId: UUID, nodeId: UUID) => {
    const ws = appState.workspaces.get(workspaceId)
    if (!ws) return
    terminals.kill(nodeId)
    forgetTerminal(nodeId)
    ws.removeNode(nodeId)
  })

  ipcMain.handle('node:set-frame', (_e, workspaceId: UUID, nodeId: UUID, frame: Rect) => {
    appState.workspaces.get(workspaceId)?.updateFrame(nodeId, frame)
  })

  ipcMain.handle('node:bring-to-front', (_e, workspaceId: UUID, nodeId: UUID) => {
    appState.workspaces.get(workspaceId)?.bringToFront(nodeId)
  })

  /** Patch raso no `value` do conteúdo — cobre renomear, mudar texto, cor etc. */
  ipcMain.handle(
    'node:patch-content',
    (_e, workspaceId: UUID, nodeId: UUID, patch: Record<string, unknown>) => {
      const ws = appState.workspaces.get(workspaceId)
      if (!ws) return null
      ws.updateContent(nodeId, (node) => {
        // Patch raso preservando a variante: o `type` nunca muda, só o payload.
        node.content = {
          type: node.content.type,
          value: { ...node.content.value, ...patch }
        } as NodeContent
      })
      return ws.node(nodeId) ?? null
    }
  )

  // ─── Conexões ───────────────────────────────────────────────────────────────

  ipcMain.handle('connection:add', (_e, workspaceId: UUID, idA: UUID, idB: UUID) => {
    const ws = appState.workspaces.get(workspaceId)
    if (!ws) return null
    const conn = ws.addConnection(idA, idB)
    if (conn) onConnectionCreated(conn.nodeIdA, conn.nodeIdB)
    return conn
  })

  ipcMain.handle('connection:remove', (_e, workspaceId: UUID, connectionId: UUID) => {
    appState.workspaces.get(workspaceId)?.removeConnection(connectionId)
  })

  // ─── Terminais ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    'terminal:spawn',
    async (_e, workspaceId: UUID, nodeId: UUID, cols: number, rows: number) => {
      const ws = appState.workspaces.get(workspaceId)
      const node = ws?.node(nodeId)
      if (!ws || !node || node.content.type !== 'terminal') {
        return { error: 'nó de terminal não encontrado' }
      }

      const tc = node.content.value
      const session = await terminals.spawn({
        nodeId,
        workspaceId,
        shellPath: tc.shellPath,
        command: tc.command,
        workingDirectory: tc.workingDirectory || ws.payload.workingDirectory,
        cols,
        rows
      })
      if (!session) return { error: ptyUnavailableReason() ?? 'não foi possível abrir o PTY' }

      terminals.setAgentInfo(nodeId, { agentType: tc.agentType, agentName: tc.name })
      return { buffer: session.buffer }
    }
  )

  ipcMain.handle('terminal:write', (_e, nodeId: UUID, data: string) => {
    terminals.write(nodeId, data)
  })

  ipcMain.handle('terminal:resize', (_e, nodeId: UUID, cols: number, rows: number) => {
    terminals.resize(nodeId, cols, rows)
  })

  ipcMain.handle('terminal:kill', (_e, nodeId: UUID) => {
    terminals.kill(nodeId)
    forgetTerminal(nodeId)
  })

  ipcMain.handle('terminal:buffer', (_e, nodeId: UUID) => terminals.get(nodeId)?.buffer ?? '')

  // ─── Desenhos ───────────────────────────────────────────────────────────────

  ipcMain.handle(
    'drawing:add',
    (_e, workspaceId: UUID, points: number[][], color: string, lineWidth: number) => {
      const ws = appState.workspaces.get(workspaceId)
      // Um ponto só não é traço — evita sujar o arquivo com cliques acidentais.
      if (!ws || !Array.isArray(points) || points.length < 2) return null
      const drawing = makeDrawing(points, color, lineWidth)
      ws.addDrawing(drawing)
      return drawing
    }
  )

  ipcMain.handle('drawing:remove', (_e, workspaceId: UUID, drawingId: UUID) => {
    appState.workspaces.get(workspaceId)?.removeDrawing(drawingId)
  })

  ipcMain.handle('drawing:clear', (_e, workspaceId: UUID) => {
    appState.workspaces.get(workspaceId)?.clearDrawings()
  })

  // ─── Portais ────────────────────────────────────────────────────────────────

  /**
   * Abre a URL no navegador do sistema. Só http(s): sem isso um `file://` ou
   * um esquema custom vindo da página embutida viraria execução arbitrária.
   */
  ipcMain.handle('portal:open-external', async (_e, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      await shell.openExternal(parsed.toString())
      return true
    } catch {
      return false
    }
  })

  // ─── Notas ──────────────────────────────────────────────────────────────────

  ipcMain.handle('note:read', (_e, workspaceId: UUID, fileName: string) =>
    persistence.readNote(workspaceId, fileName)
  )

  ipcMain.handle('note:write', async (_e, workspaceId: UUID, fileName: string, content: string) => {
    await persistence.writeNote(workspaceId, fileName, content)
    appState.workspaces.get(workspaceId)?.markDirty()
  })

  // ─── Streams do PTY para a UI ───────────────────────────────────────────────

  terminals.on('data', (id: UUID, data: string) => notifyRenderer('terminal:data', { id, data }))
  terminals.on('exit', (id: UUID, code: number) => notifyRenderer('terminal:exit', { id, code }))

  log.debug('ipc', 'handlers registrados')
}
