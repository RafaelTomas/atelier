/**
 * Superfície IPC renderer → main.
 *
 * O renderer NUNCA toca em disco, em PTY ou em socket: tudo passa por aqui,
 * o que preserva a regra do app nativo de que toda I/O é centralizada.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { extForImageMime, isSupportedImageName, mimeForImageName, pngDimensions } from '@shared/image'
import { quoteForShell } from '@shared/shell'
import type { VaultEntry, VaultFile } from '@shared/vault'
import { isValidKeyName, originOf } from '@shared/vault'
import type {
  AgentRole,
  AgentStatus,
  CanvasNode,
  GitStatus,
  NodeContent,
  Point,
  Rect,
  SecretVaultContent,
  UUID
} from '@shared/types'
import { Constants } from '../core/constants'
import { log } from '../core/logger'
import {
  makeCodeEditorContent,
  makeDataTableContent,
  makeFileTreeContent,
  makeImageContent,
  makePortalContent,
  makeSecretVaultContent,
  makeStickyNoteContent,
  makeTerminalContent,
  makeTextContent,
  makeWidgetContent
} from '../core/models/node-content'
import { makeCanvasNode, makeDrawing } from '../core/models/workspace'
import type { WorkspaceManager } from '../core/state/workspace-manager'
import { persistence } from '../core/persistence/persistence-manager'
import { ipcSocketPath, dataDir } from '../core/persistence/paths'
import { listDirectory } from '../core/projects/file-tree'
import { duplicateEntry, readTextFile, renameEntry, writeTextFile } from '../core/projects/file-ops'
import { fileWatcher } from '../core/projects/file-watcher'
import { resolveAllowedPath, resolveAllowedTarget } from '../core/projects/fs-access'
import * as gitActions from '../core/git/actions'
import { status as gitStatus, treeStatus as gitTreeStatus } from '../core/git/git'
import { addProjectFolder } from '../core/projects/add-folder'
import { candidates, clearCandidates, scanController } from '../core/projects/scan-controller'
import { startScannerAgent } from '../core/projects/scanner-agent'
import { appState } from '../core/state/app-state'
import { takenNoteFiles } from '../core/state/note-files'
import { projectIndex } from '../core/state/project-store'
import { roles } from '../core/state/role-store'
import { ptyUnavailableReason, terminals } from '../core/terminal/terminal-manager'
// `keyRefs`/`syncVaultKeys` moram no vault-manager: o `.vault` tem dois
// escritores (esta UI e o `atelier vault set`), e o espelho dos nomes no nó
// precisa ser exatamente o mesmo código nos dois caminhos.
import {
  envForTerminal,
  keyRefs,
  resolveTemplate,
  syncVaultKeys
} from '../core/vault/vault-manager'
import { interAgentServer } from '../core/interagent/server'
import { onConnectionCreated, restoreConnections } from '../core/connection/connection-manager'
import { forgetTerminal } from '../core/connection/skill-injector'
import { registerGuest, unregisterGuest } from '../core/portal/portal-registry'
import { closeSession, openSession } from '../core/portal/portal-cdp'
import { notifyRenderer } from './notify'

type NewNodeKind =
  | 'terminal'
  | 'note'
  | 'text'
  | 'portal'
  | 'fileTree'
  | 'codeEditor'
  | 'dataTable'
  | 'image'
  | 'widget'
  | 'secretVault'

function contentFor(
  kind: NewNodeKind,
  opts: Record<string, unknown>,
  // Arquivos .md já ocupados no workspace — a nota nova não pode cair em cima
  // de um deles.
  takenNotes: Iterable<string> = []
): NodeContent {
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
      return {
        type: 'stickyNote',
        value: makeStickyNoteContent(String(opts.name ?? 'Note'), takenNotes)
      }
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
    case 'dataTable':
      return { type: 'dataTable', value: makeDataTableContent(String(opts.title ?? 'Resultado')) }
    case 'secretVault':
      return {
        type: 'secretVault',
        value: makeSecretVaultContent(String(opts.name ?? 'Cofre'))
      }
    case 'image':
      return {
        type: 'image',
        value: makeImageContent(String(opts.title ?? 'Imagem'), {
          mimeType: typeof opts.mimeType === 'string' ? opts.mimeType : 'image/png',
          naturalWidth: typeof opts.naturalWidth === 'number' ? opts.naturalWidth : 0,
          naturalHeight: typeof opts.naturalHeight === 'number' ? opts.naturalHeight : 0,
          alt: typeof opts.alt === 'string' ? opts.alt : ''
        })
      }
    case 'widget':
      return {
        type: 'widget',
        value: makeWidgetContent(
          String(opts.kind ?? 'projects'),
          // Sem `projectId` o widget segue a seleção global; com ele, nasce
          // fixado — é o que o "fixar no canvas" da cascata manda.
          typeof opts.projectId === 'string' ? (opts.projectId as UUID) : null
        )
      }
  }
}

/** Bytes de imagem vindos do renderer chegam como ArrayBuffer/TypedArray. */
function toBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength)
  }
  return null
}

/** Nome de arquivo seguro dentro de um diretório gerenciado — sem `..`, sem separador. */
function safeFileName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return name
}

type AllowedResolver = (
  path: string
) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>

/** Frame do nó de imagem: o retângulo desenhado quando existe, senão a proporção real. */
function imageNodeFrame(
  w: number,
  h: number,
  requested?: { width: number; height: number }
): { width: number; height: number } {
  if (requested) {
    return {
      width: Math.max(requested.width, Constants.imageMinWidth),
      height: Math.max(requested.height, Constants.imageMinHeight)
    }
  }
  if (w > 0 && h > 0) {
    const MAX = 520
    const BAR = 24
    const scale = Math.min(1, MAX / Math.max(w, h))
    return {
      width: Math.max(Constants.imageMinWidth, Math.round(w * scale)),
      height: Math.max(Constants.imageMinHeight, Math.round(h * scale) + BAR)
    }
  }
  return { width: Constants.imageDefaultWidth, height: Constants.imageDefaultHeight }
}

/**
 * Cria o nó de imagem. `opts.filePath` (arrastado da árvore) tem os bytes no
 * disco, sob a allowlist; `opts.bytes` (colado) já traz o conteúdo. Sem um dos
 * dois — ou com arquivo grande/inválido demais — não cria nada.
 */
async function addImageNode(
  ws: WorkspaceManager,
  position: Point,
  opts: Record<string, unknown>,
  requested: { width: number; height: number } | undefined,
  resolve: AllowedResolver
): Promise<CanvasNode | null> {
  let bytes: Buffer | null = null
  let name = typeof opts.title === 'string' && opts.title ? opts.title : 'Imagem'
  let mime = typeof opts.mimeType === 'string' ? opts.mimeType : 'image/png'

  if (typeof opts.filePath === 'string' && opts.filePath) {
    if (!isSupportedImageName(opts.filePath)) return null
    const allowed = await resolve(opts.filePath)
    if (!allowed.ok) return null
    try {
      bytes = await readFile(allowed.path)
    } catch {
      return null
    }
    mime = mimeForImageName(allowed.path)
    name = basename(allowed.path).replace(/\.[^.]+$/, '') || 'Imagem'
  } else {
    bytes = toBuffer(opts.bytes)
  }

  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > Constants.imageMaxBytes) return null

  const png = pngDimensions(bytes)
  const naturalWidth =
    png?.width ?? (typeof opts.naturalWidth === 'number' ? opts.naturalWidth : 0)
  const naturalHeight =
    png?.height ?? (typeof opts.naturalHeight === 'number' ? opts.naturalHeight : 0)

  const content = makeImageContent(name, {
    mimeType: mime,
    naturalWidth,
    naturalHeight,
    alt: typeof opts.alt === 'string' ? opts.alt : ''
  })

  const size = imageNodeFrame(naturalWidth, naturalHeight, requested)
  const node = makeCanvasNode(
    { x: position.x, y: position.y, ...size },
    { type: 'image', value: content }
  )
  ws.addNode(node)
  if (content.fileName) await persistence.writeImage(ws.id, content.fileName, bytes)
  return node
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
    case 'dataTable':
      return { width: Constants.tableMinWidth, height: Constants.tableMinHeight }
    case 'image':
      return { width: Constants.imageMinWidth, height: Constants.imageMinHeight }
    case 'widget':
      return { width: Constants.widgetMinWidth, height: Constants.widgetMinHeight }
    case 'secretVault':
      return { width: Constants.vaultMinWidth, height: Constants.vaultMinHeight }
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
    case 'dataTable':
      return { width: Constants.tableDefaultWidth, height: Constants.tableDefaultHeight }
    case 'image':
      return { width: Constants.imageDefaultWidth, height: Constants.imageDefaultHeight }
    case 'widget':
      return { width: Constants.widgetDefaultWidth, height: Constants.widgetDefaultHeight }
    case 'secretVault':
      return { width: Constants.vaultDefaultWidth, height: Constants.vaultDefaultHeight }
  }
}

/**
 * O nó de cofre e o conteúdo dele, ou null se o id não é (mais) um cofre. Todo
 * canal `vault:*` começa por aqui: um nodeId vindo do renderer é entrada não
 * confiável, e sem esta checagem `vault:reveal` leria o arquivo de um cofre
 * qualquer a partir de um id qualquer.
 */
function vaultNode(
  workspaceId: UUID,
  nodeId: UUID
): { content: SecretVaultContent } | null {
  const node = appState.workspaces.get(workspaceId)?.node(nodeId)
  if (!node || node.content.type !== 'secretVault') return null
  return { content: node.content.value }
}

/** Janela deslizante de um minuto por cofre — ver `vault:reveal`. */
const revealHits = new Map<UUID, number[]>()

function allowReveal(vaultId: UUID): boolean {
  const now = Date.now()
  const hits = (revealHits.get(vaultId) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= Constants.vaultRevealPerMinute) {
    revealHits.set(vaultId, hits)
    return false
  }
  hits.push(now)
  revealHits.set(vaultId, hits)
  return true
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
    // Os PTYs vão junto. `node:remove` mata o terminal de um nó apagado; aqui
    // todos os nós somem de uma vez, e sem isto os processos ficariam rodando
    // órfãos até o app fechar — presos a um diretório de trabalho que o `rm`
    // acabou de levar, e sem nó nenhum na tela para reatá-los.
    for (const node of appState.workspaces.get(id)?.nodes ?? []) {
      if (node.content.type !== 'terminal') continue
      terminals.kill(node.id)
      forgetTerminal(node.id)
    }
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

      // Imagem tem caminho próprio: os bytes (colados) ou um arquivo do disco
      // (arrastado da árvore) precisam existir ANTES de criar o nó, e o tamanho
      // sai da proporção real da imagem, não do retângulo desenhado.
      if (kind === 'image') {
        return addImageNode(ws, position, opts, requested, (p) =>
          resolveAllowedPath(p, allowedRoots())
        )
      }

      const floor = minSize(kind)
      const size = requested
        ? {
            width: Math.max(requested.width, floor.width),
            height: Math.max(requested.height, floor.height)
          }
        : defaultSize(kind)
      const content = contentFor(kind, opts, kind === 'note' ? await takenNoteFiles(ws) : [])
      const node = makeCanvasNode({ x: position.x, y: position.y, ...size }, content)
      ws.addNode(node)

      // Nota nasce com arquivo .md em disco, como no app nativo
      if (content.type === 'stickyNote' && content.value.fileName) {
        await persistence.writeNote(ws.id, content.value.fileName, String(opts.content ?? ''))
      }
      // Tabela criada manualmente nasce vazia; o `atelier table` é quem popula.
      if (content.type === 'dataTable' && content.value.fileName) {
        await persistence.writeTable(ws.id, content.value.fileName, {
          columns: [],
          rows: [],
          truncated: false
        })
      }
      return node
    }
  )

  ipcMain.handle('node:remove', (_e, workspaceId: UUID, nodeId: UUID) => {
    const ws = appState.workspaces.get(workspaceId)
    if (!ws) return
    terminals.kill(nodeId)
    forgetTerminal(nodeId)
    // Imagem carrega um arquivo de bytes (pode ser grande): apaga junto, ao
    // contrário da nota/tabela, cujos arquivos-texto são leves e ficam.
    const node = ws.node(nodeId)
    if (node?.content.type === 'image' && node.content.value.fileName) {
      void persistence.deleteImage(ws.id, node.content.value.fileName).catch(() => undefined)
    }
    ws.removeNode(nodeId)
  })

  ipcMain.handle('node:set-frame', (_e, workspaceId: UUID, nodeId: UUID, frame: Rect) => {
    appState.workspaces.get(workspaceId)?.updateFrame(nodeId, frame)
  })

  /**
   * Commit de um arrasto de SELEÇÃO MÚLTIPLA: um IPC para N nós.
   *
   * O caminho de um nó só continua existindo — `node:set-frame` é o que a
   * esmagadora maioria dos gestos usa. Este é o que impede que mover um grupo
   * de vinte nós vire vinte travessias do processo principal.
   */
  ipcMain.handle(
    'node:set-frames',
    (_e, workspaceId: UUID, entries: { nodeId: UUID; frame: Rect }[]) => {
      appState.workspaces.get(workspaceId)?.updateFrames(entries ?? [])
    }
  )

  ipcMain.handle('node:bring-to-front', (_e, workspaceId: UUID, nodeId: UUID) => {
    appState.workspaces.get(workspaceId)?.bringToFront(nodeId)
  })

  /** Patch raso no `value` do conteúdo — cobre renomear, mudar texto, cor etc. */
  ipcMain.handle(
    'node:patch-content',
    (_e, workspaceId: UUID, nodeId: UUID, patch: Record<string, unknown>) => {
      const ws = appState.workspaces.get(workspaceId)
      if (!ws) return null

      // Num cofre, o patch genérico só pode mexer no NOME. `keys` e `locked`
      // são a projeção do arquivo cifrado, e quem os escreve é `vault:set` /
      // `vault:remove` depois de gravar o `.vault` — deixar o patch tocá-los
      // faria a lista do canvas divergir do que existe em disco. Um `value`
      // vindo por aqui seria pior ainda: segredo em claro no workspace.json.
      if (ws.node(nodeId)?.content.type === 'secretVault') {
        const allowed: Record<string, unknown> = {}
        if (typeof patch.name === 'string') allowed.name = patch.name
        patch = allowed
      }

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

      // Os cofres ligados, antes de abrir o PTY. Colisão de chave entre dois
      // cofres RECUSA o spawn: escolher um valor em silêncio faria o agente
      // rodar contra o banco errado sem ninguém perceber.
      const vaultEnv = await envForTerminal(nodeId)
      if (vaultEnv.error) return { error: vaultEnv.error }

      // `${vault:Cofre/CHAVE}` no comando é expandido AQUI, no que é escrito no
      // PTY — nunca no que está gravado. O workspace.json continua com o
      // template; o shell recebe o valor.
      const resolved = await resolveTemplate(nodeId, tc.command ?? '')
      if ('error' in resolved) return { error: resolved.error }

      const session = await terminals.spawn({
        nodeId,
        workspaceId,
        shellPath: tc.shellPath,
        command: resolved.command,
        extraEnv: vaultEnv.env,
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

  /**
   * Imagem colada dentro de um terminal. O `xterm` só trata texto, e o Claude
   * Code lê imagem por CAMINHO de arquivo — então grava os bytes num arquivo
   * temporário e "digita" o caminho na linha do agente, o mesmo gesto de um
   * arquivo arrastado para dentro do terminal (ver store.pasteIntoTerminal).
   * Sem `\r`: o usuário confirma.
   */
  ipcMain.handle(
    'terminal:paste-image',
    async (_e, nodeId: UUID, bytes: ArrayBuffer, mime: string) => {
      const buf = toBuffer(bytes)
      if (!buf || buf.byteLength === 0) return { error: 'área de transferência sem imagem' }
      if (buf.byteLength > Constants.imageMaxBytes) return { error: 'imagem grande demais' }
      const ext = extForImageMime(typeof mime === 'string' ? mime : 'image/png')
      let path: string
      try {
        path = await persistence.writeTempImage(`paste-${Date.now()}.${ext}`, buf)
      } catch (err) {
        log.error('terminal', 'falha gravando imagem colada', err)
        return { error: 'não foi possível gravar a imagem' }
      }
      const ok = terminals.write(nodeId, `${quoteForShell(path, process.platform)} `)
      return ok ? { path } : { error: 'este terminal não está rodando' }
    }
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

  // ─── Grupos ─────────────────────────────────────────────────────────────────
  // Moldura com título em volta de um conjunto de nós. Devolvem o grupo já
  // resolvido pelo manager (com a lista de membros filtrada) em vez de confiar
  // no que o renderer mandou: é lá que a regra de um dono por nó é aplicada.

  ipcMain.handle(
    'group:create',
    (_e, workspaceId: UUID, title: string, frame: Rect, nodeIds: UUID[]) => {
      const ws = appState.workspaces.get(workspaceId)
      if (!ws) return null
      return ws.createGroup(title || 'Grupo', frame, Array.isArray(nodeIds) ? nodeIds : [])
    }
  )

  ipcMain.handle(
    'group:update',
    (_e, workspaceId: UUID, groupId: UUID, patch: Record<string, unknown>) => {
      const ws = appState.workspaces.get(workspaceId)
      if (!ws) return null
      // `nodeIds` não é campo de patch raso: mexer na lista de membros passa
      // pelo filtro de dono único, que os outros campos não precisam.
      if (Array.isArray(patch.nodeIds)) {
        return ws.setGroupNodes(groupId, patch.nodeIds as UUID[])
      }
      return ws.updateGroup(groupId, {
        title: typeof patch.title === 'string' ? patch.title : undefined,
        frame: (patch.frame as Rect | undefined) ?? undefined,
        color: typeof patch.color === 'string' ? patch.color : undefined,
        isCollapsed: typeof patch.isCollapsed === 'boolean' ? patch.isCollapsed : undefined
      })
    }
  )

  ipcMain.handle('group:delete', (_e, workspaceId: UUID, groupId: UUID) => {
    appState.workspaces.get(workspaceId)?.removeGroup(groupId)
  })

  /** O nó muda de dono (ou fica sem nenhum) — o gesto de entrar/sair da moldura. */
  ipcMain.handle(
    'group:set-node',
    (_e, workspaceId: UUID, nodeId: UUID, groupId: UUID | null) => {
      appState.workspaces.get(workspaceId)?.setNodeGroup(nodeId, groupId)
    }
  )

  // ─── Portais ────────────────────────────────────────────────────────────────

  /**
   * Abre a URL no navegador do sistema. Só http(s): sem isso um `file://` ou
   * um esquema custom vindo da página embutida viraria execução arbitrária.
   */
  /**
   * O renderer avisa qual webContents pertence a qual nó, no `dom-ready` do
   * webview. É o que permite ao main falar com a página embutida — ver
   * core/portal/portal-registry.ts.
   */
  ipcMain.handle('portal:register', (_e, nodeId: UUID, webContentsId: number) => {
    registerGuest(nodeId, webContentsId)
  })

  ipcMain.handle('portal:unregister', (_e, nodeId: UUID) => {
    unregisterGuest(nodeId)
  })

  /**
   * O botão de controle do cabeçalho do portal.
   *
   * A sessão CDP nasce ao LIGAR e morre ao desligar (Decisão D do
   * PLANO-controle-de-portal.md): `attach`/`detach` por comando custa handshake
   * a cada clique e perde os observadores de navegação que invalidam as
   * referências do mapa. O conteúdo do nó continua sendo escrito pelo renderer
   * — aqui só se abre e fecha o canal.
   */
  ipcMain.handle('portal:control', async (_e, nodeId: UUID, enabled: boolean) => {
    if (!enabled) {
      closeSession(nodeId)
      return { ok: true, message: 'controle desligado' }
    }
    try {
      await openSession(nodeId)
      return { ok: true, message: 'controle ligado' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

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

  /** O que a árvore marca: não versionado (esmaece) e modificado (ponto). */
  ipcMain.handle('git:tree-status', async (_e, path: string) => {
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return { error: 'denied' }
    return gitTreeStatus(allowed.path)
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

  // ─── Tabelas de resultado ───────────────────────────────────────────────────

  ipcMain.handle('table:read', (_e, workspaceId: UUID, fileName: string) =>
    persistence.readTable(workspaceId, fileName)
  )

  ipcMain.handle('table:write', async (_e, workspaceId: UUID, fileName: string, value: unknown) => {
    await persistence.writeTable(workspaceId, fileName, value)
    appState.workspaces.get(workspaceId)?.markDirty()
  })

  // ─── Imagens ────────────────────────────────────────────────────────────────
  // Não passa pela allowlist de `allowedRoots`: serve SÓ arquivos sob
  // `images/` do workspace, e o nome é sanitizado antes de tocar no disco.

  ipcMain.handle('image:read', async (_e, workspaceId: UUID, fileName: string) => {
    const safe = safeFileName(fileName)
    if (!safe) return { error: 'nome de arquivo inválido' as const }
    const buf = await persistence.readImage(workspaceId, safe)
    if (!buf) return { error: 'missing' as const }
    return { dataUrl: `data:${mimeForImageName(safe)};base64,${buf.toString('base64')}` }
  })

  // ─── Cofres ─────────────────────────────────────────────────────────────────
  // O renderer NUNCA recebe valor de segredo, com uma exceção explícita e
  // pedida pelo usuário: `vault:reveal`, que devolve UM valor, UMA vez, sob
  // limite de frequência. Todo o resto trafega só nomes de chave.
  //
  // Cada escrita faz duas coisas na ordem certa: grava o `.vault` cifrado e só
  // depois espelha os NOMES no conteúdo do nó. Se a cifra falhar, o
  // workspace.json não passa a anunciar uma chave que não existe em disco.

  ipcMain.handle('vault:available', () => persistence.vaultAvailable())

  ipcMain.handle('vault:list-keys', async (_e, workspaceId: UUID, nodeId: UUID) => {
    const found = vaultNode(workspaceId, nodeId)
    if (!found) return { error: 'este nó não é um cofre' as const }
    const file = await persistence.readVault(workspaceId, found.content.id)
    if (!file) {
      syncVaultKeys(workspaceId, nodeId, null)
      return { error: 'locked' as const }
    }
    syncVaultKeys(workspaceId, nodeId, file)
    return { keys: keyRefs(file) }
  })

  ipcMain.handle(
    'vault:set',
    async (_e, workspaceId: UUID, nodeId: UUID, input: Record<string, unknown>) => {
      const found = vaultNode(workspaceId, nodeId)
      if (!found) return { error: 'este nó não é um cofre' as const }

      const key = String(input.key ?? '').trim()
      if (!isValidKeyName(key)) {
        return {
          error: 'nome de chave inválido — use letras, números e _, começando por letra ou _'
        }
      }
      const value = String(input.value ?? '')
      if (!value) return { error: 'segredo vazio não é segredo' }

      // Origem é opcional, mas se vier tem de ser uma origem de verdade: uma
      // string torta aqui viraria uma comparação que nunca casa no
      // `portal login`, e o erro apareceria a quilômetros daqui.
      let origin: string | null = null
      if (typeof input.origin === 'string' && input.origin.trim()) {
        origin = originOf(input.origin.trim())
        if (!origin) return { error: 'origem inválida — use algo como https://github.com' }
      }

      const file = await persistence.readVault(workspaceId, found.content.id)
      if (!file) {
        syncVaultKeys(workspaceId, nodeId, null)
        return { error: 'locked' as const }
      }

      const entry: VaultEntry = {
        key,
        value,
        origin,
        inEnv: input.inEnv === true,
        note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null,
        updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        source: 'user'
      }
      const entries = file.entries.filter((e) => e.key !== key)
      entries.push(entry)
      entries.sort((a, b) => a.key.localeCompare(b.key))

      const next: VaultFile = { ...file, entries }
      if (!(await persistence.writeVault(workspaceId, found.content.id, next))) {
        syncVaultKeys(workspaceId, nodeId, null)
        return { error: 'locked' as const }
      }
      syncVaultKeys(workspaceId, nodeId, next)
      log.info('vault', `chave ${key} gravada no cofre "${found.content.name}"`)
      return { keys: keyRefs(next) }
    }
  )

  ipcMain.handle('vault:remove', async (_e, workspaceId: UUID, nodeId: UUID, key: string) => {
    const found = vaultNode(workspaceId, nodeId)
    if (!found) return { error: 'este nó não é um cofre' as const }
    const file = await persistence.readVault(workspaceId, found.content.id)
    if (!file) {
      syncVaultKeys(workspaceId, nodeId, null)
      return { error: 'locked' as const }
    }
    const next: VaultFile = { ...file, entries: file.entries.filter((e) => e.key !== key) }
    if (!(await persistence.writeVault(workspaceId, found.content.id, next))) {
      return { error: 'locked' as const }
    }
    syncVaultKeys(workspaceId, nodeId, next)
    return { keys: keyRefs(next) }
  })

  /**
   * O ÚNICO canal que devolve valor ao renderer, e por pedido explícito do
   * usuário no nó. Limite de frequência por cofre: um renderer comprometido (ou
   * um bug em loop) não drena o cofre inteiro num piscar. O renderer não guarda
   * o que recebe — ver secret-vault-node.tsx.
   */
  ipcMain.handle('vault:reveal', async (_e, workspaceId: UUID, nodeId: UUID, key: string) => {
    const found = vaultNode(workspaceId, nodeId)
    if (!found) return { error: 'este nó não é um cofre' as const }
    if (!allowReveal(found.content.id)) {
      return { error: 'muitas revelações seguidas — espere um instante' }
    }
    const file = await persistence.readVault(workspaceId, found.content.id)
    if (!file) return { error: 'locked' as const }
    const entry = file.entries.find((e) => e.key === key)
    if (!entry) return { error: 'esta chave não existe neste cofre' }
    void persistence
      .appendVaultAccess(
        workspaceId,
        `${new Date().toISOString()}\tui\t${found.content.id}\treveal ${key}\n`
      )
      .catch(() => undefined)
    return { value: entry.value }
  })

  /**
   * A trilha de acessos, para o nó mostrar "últimos acessos".
   *
   * O arquivo é em claro de propósito — ele precisa ser legível num sistema em
   * que o cofre não abre, que é justamente quando alguém quer saber quem leu o
   * quê. Por isso nada aqui carrega valor: só quando, qual terminal, qual chave.
   */
  ipcMain.handle('vault:access-log', async (_e, workspaceId: UUID, limit?: number) =>
    persistence.readVaultAccess(workspaceId, typeof limit === 'number' ? limit : 20)
  )

  // ─── Streams do PTY para a UI ───────────────────────────────────────────────

  terminals.on('data', (id: UUID, data: string) => notifyRenderer('terminal:data', { id, data }))
  terminals.on('exit', (id: UUID, code: number) => notifyRenderer('terminal:exit', { id, code }))
  terminals.on('status', (id: UUID, status: AgentStatus) =>
    notifyRenderer('terminal:status', { id, status })
  )

  log.debug('ipc', 'handlers registrados')
}
