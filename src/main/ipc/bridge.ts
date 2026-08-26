/**
 * Superfície IPC renderer → main.
 *
 * O renderer NUNCA toca em disco, em PTY ou em socket: tudo passa por aqui,
 * o que preserva a regra do app nativo de que toda I/O é centralizada.
 */
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AgentRole,
  AgentStatus,
  CanvasNode,
  GitStatus,
  NodeContent,
  Point,
  Rect,
  UUID
} from '@shared/types'
import { Constants } from '../core/constants'
import { log } from '../core/logger'
import {
  makeCodeEditorContent,
  makeFileTreeContent,
  makePortalContent,
  makeStickyNoteContent,
  makeTerminalContent,
  makeTextContent
} from '../core/models/node-content'
import { makeCanvasNode, makeDrawing } from '../core/models/workspace'
import { persistence } from '../core/persistence/persistence-manager'
import { ipcSocketPath, dataDir } from '../core/persistence/paths'
import { listDirectory } from '../core/projects/file-tree'
import { duplicateEntry, readTextFile, renameEntry, writeTextFile } from '../core/projects/file-ops'
import { fileWatcher } from '../core/projects/file-watcher'
import { resolveAllowedPath, resolveAllowedTarget } from '../core/projects/fs-access'
import * as gitActions from '../core/git/actions'
import { status as gitStatus, unversioned as gitUnversioned } from '../core/git/git'
import { addProjectFolder } from '../core/projects/add-folder'
import { candidates, clearCandidates, scanController } from '../core/projects/scan-controller'
import { startScannerAgent } from '../core/projects/scanner-agent'
import { appState } from '../core/state/app-state'
import { projectIndex } from '../core/state/project-store'
import { roles } from '../core/state/role-store'
import { ptyUnavailableReason, terminals } from '../core/terminal/terminal-manager'
import { interAgentServer } from '../core/interagent/server'
import { onConnectionCreated, restoreConnections } from '../core/connection/connection-manager'
import { forgetTerminal } from '../core/connection/skill-injector'
import { notifyRenderer } from './notify'

type NewNodeKind = 'terminal' | 'note' | 'text' | 'portal' | 'fileTree' | 'codeEditor'

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
    case 'codeEditor':
      return { type: 'codeEditor', value: makeCodeEditorContent(String(opts.filePath ?? '')) }
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
    case 'codeEditor':
      return { width: 240, height: 160 }
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
    case 'codeEditor':
      return { width: 620, height: 440 }
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

  /**
   * O botão Salvar da barra. `force` porque é ação explícita do usuário: é o
   * único caminho que grava um workspace em modo seguro, e a faixa na tela já
   * disse o que se perde.
   */
  ipcMain.handle('workspace:save-now', async () => appState.saveDirtyWorkspaces(true))

  /**
   * O que a UI precisa para decidir se mostra a faixa de modo seguro. Fica fora
   * do payload do workspace de propósito: não é dado do canvas, é estado da
   * leitura do arquivo.
   */
  ipcMain.handle('workspace:integrity', (_e, id: UUID) => {
    const ws = appState.workspaces.get(id)
    return ws ? ws.integrity() : null
  })

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

  // A varredura do boot deixa os candidatos no main; o renderer pergunta quando
  // monta, para não depender de ter chegado a tempo no evento.
  ipcMain.handle('project:candidates', () => candidates())

  ipcMain.handle('project:accept-candidates', async (_e, paths: string[]) => {
    const chosen = candidates().filter((c) => paths.includes(c.path))
    for (const disc of chosen) await projectIndex.add(disc)
    clearCandidates(paths)
    if (chosen.length > 0) notifyRenderer('project:changed', { ids: [] })
    return projectIndex.all
  })

  ipcMain.handle('project:ignore-candidates', async (_e, paths: string[]) => {
    await projectIndex.ignore(paths)
    clearCandidates(paths)
  })

  ipcMain.handle('project:add-folder', async (_e, path: string) => {
    const result = await addProjectFolder(path)
    if ('project' in result) notifyRenderer('project:changed', { ids: [result.project.id] })
    return result
  })

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

  /**
   * Cria o nó de projeto no canvas. Reusa o nó fileTree, que já existe no codec
   * desde o app nativo: o nó guarda APENAS o rootPath, e todo metadado continua
   * no índice (campos extras em FileTreeContent são gravados mas descartados na
   * releitura, aqui e no app Swift).
   */
  ipcMain.handle('project:add-to-workspace', async (_e, workspaceId: UUID, id: UUID, position: Point) => {
    const ws = appState.workspaces.get(workspaceId)
    const project = projectIndex.get(id)
    if (!ws || !project) return null

    const node = makeCanvasNode(
      { ...position, ...defaultSize('fileTree') },
      { type: 'fileTree', value: makeFileTreeContent(project.name, project.path) }
    )
    ws.addNode(node)
    await projectIndex.touchOpened(id)
    return node
  })

  /**
   * Cria o agente que descreve os projetos. Devolve o nó para a UI selecioná-lo
   * — o terminal em si sobe pelo caminho normal, quando o nó monta.
   */
  ipcMain.handle('project:start-scanner', async (_e, workspaceId: UUID, position: Point, command: string) => {
    const result = await startScannerAgent({
      workspaceId,
      position,
      command,
      homeDir: homedir()
    })
    if ('error' in result) return result
    notifyRenderer('workspace:changed', { workspaceId })
    return { node: result.node }
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

  ipcMain.handle('fs:list-dir', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    // O motivo volta como código, nunca como erro do sistema: a mensagem do fs
    // revela a existência e o nome de caminhos fora do escopo permitido.
    if (!allowed.ok) return { error: allowed.reason }
    try {
      return await listDirectory(allowed.path)
    } catch {
      return { error: 'error' as const }
    }
  })

  /**
   * O caminho como URL `file://`, para o que é renderizado por <webview> — um
   * PDF, por exemplo.
   *
   * A conversão fica no main, e não no renderer, pela mesma razão do
   * `dialog:choose-file`: `pathToFileURL` resolve espaço, acento e letra de
   * unidade do Windows, que uma concatenação de string erraria. E passa pela
   * allowlist como qualquer outro acesso a disco.
   */
  ipcMain.handle('fs:file-url', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: allowed.reason }
    return { url: pathToFileURL(allowed.path).href }
  })

  ipcMain.handle('fs:reveal', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return false
    shell.showItemInFolder(allowed.path)
    return true
  })

  // ─── Arquivos: ler, gravar, renomear, duplicar, lixeira ─────────────────────
  // Cada canal resolve o caminho pela allowlist ANTES de tocar em disco. Foi a
  // ausência de `fs:read-file` que eliminava a classe "leitura arbitrária de
  // ~/.ssh/id_rsa" enquanto a árvore só navegava; agora que ela existe, a
  // allowlist é o que ficou no lugar daquela ausência — não há caminho aqui que
  // não passe por ela.

  ipcMain.handle('fs:read-file', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: allowed.reason }
    return readTextFile(allowed.path)
  })

  ipcMain.handle('fs:write-file', async (_e, path: string, text: string) => {
    if (typeof text !== 'string') return { error: 'error' as const }
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: allowed.reason }
    return writeTextFile(allowed.path, text)
  })

  /**
   * Renomear e mover são o mesmo canal: `to` é o caminho final.
   *
   * A regra que separa os dois usos é a raiz — origem e destino têm de cair sob
   * a MESMA raiz permitida. Sem isso, arrastar um arquivo de um projeto para
   * outro seria uma forma de mover dados entre escopos que o usuário nunca
   * autorizou junto.
   */
  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    const roots = allowedRoots()
    const src = await resolveAllowedPath(from, roots)
    if (!src.ok) return { error: src.reason }
    const dst = await resolveAllowedTarget(to, roots)
    if (!dst.ok) return { error: dst.reason }
    if (dst.root !== src.root) return { error: 'denied' as const }
    // Pasta para dentro de si mesma: o rename "funcionaria" e sumiria com a
    // subárvore inteira.
    if (dst.path === src.path || dst.path.startsWith(src.path + sep)) {
      return { error: 'denied' as const }
    }
    return renameEntry(src.path, dst.path)
  })

  ipcMain.handle('fs:duplicate', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: allowed.reason }
    return duplicateEntry(allowed.path)
  })

  /**
   * Vigia um arquivo aberto no editor. Um caminho exato por assinatura, nunca
   * uma árvore — ver core/projects/file-watcher.ts.
   */
  ipcMain.handle('fs:watch', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return false
    fileWatcher.watch(allowed.path)
    return true
  })

  ipcMain.handle('fs:unwatch', async (_e, path: string) => {
    // Sem allowlist aqui de propósito: parar de vigiar não lê nada, e o
    // arquivo pode já ter sido apagado — resolver o caminho falharia e
    // deixaria o watcher vivo para sempre.
    fileWatcher.unwatch(path)
  })

  fileWatcher.on('changed', (path: string) => notifyRenderer('fs:file-changed', { path }))
  fileWatcher.on('removed', (path: string) => notifyRenderer('fs:file-removed', { path }))

  /**
   * Lixeira do sistema, nunca `unlink`: apagar aqui é reversível pelo Finder,
   * pelo Explorer ou pelo gerenciador de arquivos do Linux. É por isso que este
   * canal usa `shell` e mora no bridge, não em core/projects/.
   */
  ipcMain.handle('fs:trash', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: allowed.reason }
    try {
      await shell.trashItem(allowed.path)
      return { ok: true as const }
    } catch (err) {
      log.error('fs', `falha mandando ${allowed.path} para a lixeira`, err)
      return { error: 'error' as const }
    }
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

  ipcMain.handle('terminal:write', (_e, nodeId: UUID, data: string) =>
    terminals.write(nodeId, data)
  )

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

  // ─── Git ────────────────────────────────────────────────────────────────────

  /**
   * Toda ação de git passa por aqui primeiro.
   *
   * O renderer manda um caminho; quem decide se ele vale é a mesma allowlist da
   * árvore de arquivos. Sem isto, `git:*` seria "rode git em qualquer diretório
   * da máquina" para qualquer código que executasse no renderer — que hospeda
   * `<webview>` com páginas arbitrárias nos nós Portal.
   *
   * Devolve a RAIZ do repositório, não o caminho pedido: as ações valem para o
   * repositório inteiro, e a pasta consultada pode ser uma subpasta dele.
   */
  async function gitRoot(path: string): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { ok: false, error: 'denied' }
    const st = await gitStatus(allowed.path)
    if ('error' in st) return { ok: false, error: st.error }
    return { ok: true, root: st.root }
  }

  /**
   * Caminhos de arquivo vindos do renderer.
   *
   * Chegam relativos à raiz (é como o porcelain os devolve) e é assim que vão
   * para o git. Rejeitamos `..` e caminho absoluto: um `../../.ssh/id_rsa` num
   * `git add` sairia do repositório, e o allowlist da raiz não veria isso.
   */
  function safeRelPaths(paths: unknown): string[] {
    if (!Array.isArray(paths)) return []
    return paths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .filter((p) => !p.startsWith('/') && !p.startsWith('\\') && !/(^|[\\/])\.\.([\\/]|$)/.test(p))
      .slice(0, 2000)
  }

  ipcMain.handle('git:status', async (_e, path: string): Promise<GitStatus | { error: string }> => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: 'denied' }
    return gitStatus(allowed.path)
  })

  /** O que a árvore de arquivos esmaece: não rastreado e ignorado. */
  ipcMain.handle('git:unversioned', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: 'denied' }
    return gitUnversioned(allowed.path)
  })

  ipcMain.handle('git:stage', async (_e, path: string, paths: string[]) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.stage(r.root, safeRelPaths(paths))
  })

  ipcMain.handle('git:stage-all', async (_e, path: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.stageAll(r.root)
  })

  ipcMain.handle('git:unstage', async (_e, path: string, paths: string[]) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.unstage(r.root, safeRelPaths(paths))
  })

  ipcMain.handle('git:unstage-all', async (_e, path: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.unstageAll(r.root)
  })

  ipcMain.handle('git:discard', async (_e, path: string, tracked: string[], untracked: string[]) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.discard(r.root, safeRelPaths(tracked), safeRelPaths(untracked))
  })

  ipcMain.handle('git:commit', async (_e, path: string, message: string, amend?: boolean) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.commit(r.root, String(message ?? ''), amend === true)
  })

  ipcMain.handle('git:pull', async (_e, path: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.pull(r.root)
  })

  ipcMain.handle('git:fetch', async (_e, path: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.fetch(r.root)
  })

  ipcMain.handle('git:push', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { ok: false, message: 'denied' }
    // O push precisa saber se há upstream: sem ele, publica o branch em vez de
    // falhar. Um status fresco é a única fonte confiável disso.
    const st = await gitStatus(allowed.path)
    if ('error' in st) return { ok: false, message: st.error }
    return gitActions.push(st.root, st.branch, st.upstream !== null)
  })

  ipcMain.handle('git:log', async (_e, path: string, limit?: number) => {
    const r = await gitRoot(path)
    if (!r.ok) return { error: r.error }
    return gitActions.log(r.root, typeof limit === 'number' ? limit : 30)
  })

  ipcMain.handle('git:diff', async (_e, path: string, file: string, staged: boolean) => {
    const r = await gitRoot(path)
    if (!r.ok) return { error: r.error }
    const [safe] = safeRelPaths([file])
    if (!safe) return { error: 'denied' }
    return gitActions.diff(r.root, safe, staged === true)
  })

  ipcMain.handle('git:branches', async (_e, path: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { error: r.error }
    return gitActions.branches(r.root)
  })

  ipcMain.handle('git:switch', async (_e, path: string, name: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.switchBranch(r.root, String(name ?? ''))
  })

  ipcMain.handle('git:create-branch', async (_e, path: string, name: string) => {
    const r = await gitRoot(path)
    if (!r.ok) return { ok: false, message: r.error }
    return gitActions.createBranch(r.root, String(name ?? ''))
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
