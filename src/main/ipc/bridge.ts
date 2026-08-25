/**
 * Superfície IPC renderer → main.
 *
 * O renderer NUNCA toca em disco, em PTY ou em socket: tudo passa por aqui,
 * o que preserva a regra do app nativo de que toda I/O é centralizada.
 */
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AgentRole,
  AgentStatus,
  CanvasNode,
  NodeContent,
  Point,
  Rect,
  UUID
} from '@shared/types'
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
import { resolveAllowedPath } from '../core/projects/fs-access'
import { scanController } from '../core/projects/scan-controller'
import { appState } from '../core/state/app-state'
import { projectIndex } from '../core/state/project-store'
import { roles } from '../core/state/role-store'
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
          workingDirectory: String(opts.workingDirectory ?? ''),
          icon: String(opts.icon ?? 'terminal'),
          color: String(opts.color ?? '#007AFF'),
          isManager: opts.isManager === true,
          monitorWithOmbro: opts.monitorWithOmbro === true,
          themeId: typeof opts.themeId === 'string' ? opts.themeId : null,
          fontFamily: typeof opts.fontFamily === 'string' ? opts.fontFamily : null,
          fontSize: typeof opts.fontSize === 'number' ? opts.fontSize : null,
          // Só aceita responsabilidade que existe de fato — um id órfão vindo
          // do renderer deixaria o terminal apontando para o nada
          assignedRoleId:
            typeof opts.assignedRoleId === 'string' && roles.has(opts.assignedRoleId as UUID)
              ? (opts.assignedRoleId as UUID)
              : null
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

/**
 * Piso por tipo. A área é desenhada pelo usuário, e um retângulo de 20px
 * criaria um terminal onde nem o cabeçalho cabe.
 */
function minSize(kind: NewNodeKind): { width: number; height: number } {
  switch (kind) {
    case 'terminal':
      return { width: Constants.terminalMinWidth, height: Constants.terminalMinHeight }
    case 'note':
      return { width: Constants.noteMinWidth, height: Constants.noteMinHeight }
    case 'portal':
      return { width: 240, height: 180 }
    case 'fileTree':
      return { width: 180, height: 140 }
    case 'text':
      return { width: 80, height: 32 }
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
    homeDir: homedir(),
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
      opts: Record<string, unknown> = {},
      // Área desenhada pelo usuário antes de criar o nó; sem ela vale o padrão.
      requested?: { width: number; height: number }
    ): Promise<CanvasNode | null> => {
      const ws = appState.workspaces.get(workspaceId)
      if (!ws) return null

      const floor = minSize(kind)
      const size = requested
        ? {
            width: Math.max(requested.width, floor.width),
            height: Math.max(requested.height, floor.height)
          }
        : defaultSize(kind)
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

  // ─── Responsabilidades (agentes) ────────────────────────────────────────────

  ipcMain.handle('role:list', () => roles.all)

  ipcMain.handle('role:save', async (_e, patch: Partial<AgentRole> & { name: string }) => {
    const role = await roles.save(patch)
    log.debug('roles', `responsabilidade "${role.name}" gravada`)
    return role
  })

  ipcMain.handle('role:delete', async (_e, id: UUID) => {
    await roles.remove(id)

    // Terminais que apontavam para ela ficariam com um id órfão: limpa em todos
    // os workspaces carregados para o canvas não mostrar um agente fantasma.
    for (const ws of appState.workspaces.values()) {
      for (const node of ws.nodes) {
        if (node.content.type === 'terminal' && node.content.value.assignedRoleId === id) {
          ws.updateContent(node.id, (n) => {
            if (n.content.type === 'terminal') n.content.value.assignedRoleId = null
          })
        }
      }
    }
    return roles.all
  })

  // ─── Projetos ───────────────────────────────────────────────────────────────
  // O índice é GLOBAL: não pertence a workspace nenhum, e por isso estes canais
  // não recebem workspaceId (exceto o que cria nó no canvas).

  ipcMain.handle('project:list', () => projectIndex.all)

  ipcMain.handle('project:scan-start', (_e, input: { mode: 'folder' | 'home'; path?: string; maxDepth?: number }) =>
    scanController.start(input)
  )

  ipcMain.handle('project:scan-cancel', (_e, scanId?: UUID) => {
    scanController.cancel(scanId)
  })

  ipcMain.handle('project:scan-status', () => scanController.active)

  ipcMain.handle('project:patch', async (_e, id: UUID, patch: Record<string, unknown>) => {
    const updated = await projectIndex.patch(id, patch)
    if (updated) notifyRenderer('project:changed', { ids: [id] })
    return updated
  })

  ipcMain.handle('project:remove', async (_e, id: UUID) => {
    await projectIndex.remove(id)
    notifyRenderer('project:changed', { ids: [id] })
    return projectIndex.all
  })

  // ─── Sistema de arquivos (árvore do nó de projeto) ──────────────────────────

  /**
   * Raízes que o renderer pode ler: os projetos do índice, o diretório do
   * workspace ativo e o rootPath de cada nó de árvore aberto. Recalculado a
   * cada chamada de propósito — ver fs-access.ts.
   */
  function allowedRoots(): { roots: string[] } {
    const roots = projectIndex.all.map((p) => p.path)
    const ws = appState.activeWorkspace
    if (ws) {
      if (ws.payload.workingDirectory) roots.push(ws.payload.workingDirectory)
      for (const node of ws.nodes) {
        if (node.content.type === 'fileTree' && node.content.value.rootPath) {
          roots.push(node.content.value.rootPath)
        }
      }
    }
    return { roots }
  }

  ipcMain.handle('fs:reveal', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return false
    shell.showItemInFolder(allowed.path)
    return true
  })

  // ─── Diálogos nativos ───────────────────────────────────────────────────────

  ipcMain.handle('dialog:choose-directory', async (e, current?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current && current.length > 0 ? current : undefined
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  /**
   * Escolhe um arquivo e devolve também a URL `file://` dele — a conversão fica
   * aqui porque `pathToFileURL` resolve espaço, acento e letra de unidade do
   * Windows, que uma concatenação no renderer erraria.
   */
  ipcMain.handle('dialog:choose-file', async (e, filters?: Electron.FileFilter[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : result.filePaths[0] ?? null
    return path ? { path, url: pathToFileURL(path).href } : null
  })

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
      const role = roles.get(tc.assignedRoleId)
      const session = await terminals.spawn({
        nodeId,
        workspaceId,
        shellPath: tc.shellPath,
        command: tc.command,
        workingDirectory: tc.workingDirectory || ws.payload.workingDirectory,
        cols,
        rows,
        role: role ? { id: role.id, name: role.name } : null
      })
      if (!session) return { error: ptyUnavailableReason() ?? 'não foi possível abrir o PTY' }

      terminals.setAgentInfo(nodeId, { agentType: tc.agentType, agentName: tc.name })
      // O status volta junto para a UI reabrir já com os números certos — o
      // evento só chega no próximo chunk de saída do agente.
      return { buffer: session.buffer, status: session.status }
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
  terminals.on('status', (id: UUID, status: AgentStatus) =>
    notifyRenderer('terminal:status', { id, status })
  )

  log.debug('ipc', 'handlers registrados')
}
