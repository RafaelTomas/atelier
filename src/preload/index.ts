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
  AgentUsage,
  BootInfo,
  FileOpError,
  CanvasNode,
  ClaudeAccount,
  ClaudeAccountInfo,
  ClaudeSessionSummary,
  CodexAccountUsage,
  DiscoveredProject,
  Connection,
  Drawing,
  FsEntry,
  GitCommitEntry,
  GitStatus,
  NodeGroup,
  Point,
  Project,
  Preferences,
  Rect,
  SecretVaultKeyRef,
  StoredAccountUsage,
  Plan,
  PlanBook,
  PlanVersion,
  SystemStats,
  TodoBoard,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'
import type { DataTablePayload } from '@shared/data-table'
import type { RemovedNodeSnapshot } from '@shared/node-undo'

/** O que a UI manda ao gravar uma chave. `value` sobe; nunca desce de volta. */
interface VaultEntryInput {
  key: string
  value: string
  origin?: string | null
  inEnv?: boolean
  note?: string | null
}

/** `error: 'locked'` = cofre ilegível neste sistema (chaveiro ausente). */
type VaultKeysResult = { keys: SecretVaultKeyRef[] } | { error: string }

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

/**
 * Estado de um editor de código, empurrado ao main. Espelha o `EditorState` de
 * core/editor/editor-registry.ts — a forma é duplicada aqui, e não importada,
 * porque o preload não pode alcançar o núcleo do main.
 */
interface EditorPush {
  path: string
  dirty: boolean
  /** Linhas 1-based. null = só cursor. */
  selection: { from: number; to: number } | null
  cursorLine: number
  /** Só enquanto sujo: arquivo limpo o main lê do disco. */
  buffer: string | null
}

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
    /** Desfazer o remove: os nós voltam com o mesmo id. Devolve os que voltaram. */
    restore: (workspaceId: UUID, snapshots: RemovedNodeSnapshot[]): Promise<UUID[]> =>
      ipcRenderer.invoke('node:restore', workspaceId, snapshots),
    setFrame: (workspaceId: UUID, nodeId: UUID, frame: Rect): Promise<void> =>
      ipcRenderer.invoke('node:set-frame', workspaceId, nodeId, frame),
    /** Commit de um arrasto de seleção múltipla: um IPC em vez de N. */
    setFrames: (workspaceId: UUID, entries: { nodeId: UUID; frame: Rect }[]): Promise<void> =>
      ipcRenderer.invoke('node:set-frames', workspaceId, entries),
    bringToFront: (workspaceId: UUID, nodeId: UUID): Promise<void> =>
      ipcRenderer.invoke('node:bring-to-front', workspaceId, nodeId),
    patchContent: (
      workspaceId: UUID,
      nodeId: UUID,
      patch: Record<string, unknown>
    ): Promise<CanvasNode | null> =>
      ipcRenderer.invoke('node:patch-content', workspaceId, nodeId, patch)
  },

  /**
   * Contas do Claude. Uma conta é um CLAUDE_CONFIG_DIR próprio; a lista sempre
   * vem com a padrão (~/.claude) na frente. Nenhuma credencial trafega aqui —
   * quem loga é o `claude` dentro do terminal.
   */
  claudeAccount: {
    list: (): Promise<ClaudeAccountInfo[]> => ipcRenderer.invoke('claude-account:list'),
    /**
     * A última leitura de limite de cada conta, viva ou guardada em disco. Quem
     * decide se ainda vale é a UI (`activeWindows`, em shared/agent-usage).
     */
    usage: (): Promise<StoredAccountUsage[]> => ipcRenderer.invoke('claude-account:usage'),
    /** `warnings` traz o que não deu para herdar do ~/.claude (símlink recusado). */
    create: (
      label: string
    ): Promise<{ account: ClaudeAccount; warnings: string[]; accounts: ClaudeAccountInfo[] }> =>
      ipcRenderer.invoke('claude-account:create', label),
    rename: (id: string, label: string): Promise<ClaudeAccountInfo[]> =>
      ipcRenderer.invoke('claude-account:rename', id, label),
    /** `deleteFiles` leva junto a credencial — o login precisa ser refeito. */
    remove: (id: string, deleteFiles: boolean): Promise<ClaudeAccountInfo[]> =>
      ipcRenderer.invoke('claude-account:remove', id, deleteFiles)
  },

  codex: {
    subscribe: (): Promise<CodexAccountUsage> => ipcRenderer.invoke('codex:subscribe'),
    unsubscribe: (): Promise<void> => ipcRenderer.invoke('codex:unsubscribe'),
    refreshAccount: (): Promise<CodexAccountUsage> => ipcRenderer.invoke('codex:refresh-account'),
    accountUsage: (): Promise<unknown | null> => ipcRenderer.invoke('codex:account-usage'),
    onAccount: (cb: (usage: CodexAccountUsage) => void): Unsubscribe =>
      on('codex:account', cb)
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
    /**
     * Imagem colada dentro do terminal: grava um arquivo temporário e cola o
     * caminho na linha do agente. `path` no sucesso, `error` legível na falha.
     */
    pasteImage: (
      nodeId: UUID,
      bytes: ArrayBuffer,
      mime: string
    ): Promise<{ path: string } | { error: string }> =>
      ipcRenderer.invoke('terminal:paste-image', nodeId, bytes, mime),
    resize: (nodeId: UUID, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', nodeId, cols, rows),
    kill: (nodeId: UUID): Promise<void> => ipcRenderer.invoke('terminal:kill', nodeId),
    buffer: (nodeId: UUID): Promise<string> => ipcRenderer.invoke('terminal:buffer', nodeId),
    onData: (cb: (p: { id: UUID; data: string }) => void): Unsubscribe => on('terminal:data', cb),
    onExit: (cb: (p: { id: UUID; code: number }) => void): Unsubscribe => on('terminal:exit', cb),
    /** Linha de status do agente (tokens, contexto, limites); muda pouco. */
    /**
      * A leitura que o próprio agente publica pela `statusLine`. Canal separado
      * do `onStatus` de propósito: são fontes diferentes, com qualidade
      * diferente, e o painel precisa saber de qual delas veio o número.
      */
    onUsage: (cb: (p: { id: UUID; usage: AgentUsage }) => void): Unsubscribe =>
      on('terminal:usage', cb),
    /**
     * A sessão gravada deste nó, quando o agente sabe retomar. `null` = não há
     * o que retomar, e o menu desabilita a ação em vez de oferecê-la à toa.
     */
    session: (
      workspaceId: UUID,
      nodeId: UUID
    ): Promise<{ sessionId: UUID; startedAt: string } | null> =>
      ipcRenderer.invoke('terminal:session', workspaceId, nodeId),
    /** "Sessão nova": apaga o id antes de o nó remontar. */
    forgetSession: (workspaceId: UUID, nodeId: UUID): Promise<void> =>
      ipcRenderer.invoke('terminal:forget-session', workspaceId, nodeId),
    /**
     * As sessões anteriores do Claude Code num diretório, para o select
     * "Retomar sessão" do diálogo. Lista vazia = não oferecer a opção.
     */
    resumableSessions: (
      cwd: string,
      claudeAccountId: string | null
    ): Promise<ClaudeSessionSummary[]> =>
      ipcRenderer.invoke('claude:sessions', cwd, claudeAccountId),
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

  /**
   * Molduras de grupo. Vivem ao lado dos desenhos no payload, não no array de
   * nós — ver NodeGroup em @shared/types.
   */
  group: {
    create: (
      workspaceId: UUID,
      title: string,
      frame: Rect,
      nodeIds: UUID[]
    ): Promise<NodeGroup | null> =>
      ipcRenderer.invoke('group:create', workspaceId, title, frame, nodeIds),
    /** Patch raso: title, frame, color, isCollapsed — ou nodeIds inteiro. */
    update: (
      workspaceId: UUID,
      groupId: UUID,
      patch: Partial<Pick<NodeGroup, 'title' | 'frame' | 'color' | 'isCollapsed' | 'nodeIds'>>
    ): Promise<NodeGroup | null> =>
      ipcRenderer.invoke('group:update', workspaceId, groupId, patch),
    /** Desagrupa: some a moldura, ficam os nós. */
    remove: (workspaceId: UUID, groupId: UUID): Promise<void> =>
      ipcRenderer.invoke('group:delete', workspaceId, groupId),
    /** Muda o dono de UM nó. null = solta de qualquer grupo. */
    setNode: (workspaceId: UUID, nodeId: UUID, groupId: UUID | null): Promise<void> =>
      ipcRenderer.invoke('group:set-node', workspaceId, nodeId, groupId)
  },

  portal: {
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('portal:open-external', url),
    /** `dom-ready` do webview: diz ao main com qual webContents ele fala. */
    register: (nodeId: UUID, webContentsId: number): Promise<void> =>
      ipcRenderer.invoke('portal:register', nodeId, webContentsId),
    unregister: (nodeId: UUID): Promise<void> => ipcRenderer.invoke('portal:unregister', nodeId),
    /** Botão de controle: abre ou fecha a sessão CDP deste portal. */
    control: (nodeId: UUID, enabled: boolean): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('portal:control', nodeId, enabled),
    /** Trilha de ações do agente — uma linha por verbo, mostrada no nó. */
    onAction: (cb: (p: { nodeId: UUID; line: string }) => void): Unsubscribe =>
      on('portal:action', cb),
    /** O main pede que um portal adormecido (zoom/virtualização) seja montado. */
    onWake: (cb: (p: { nodeId: UUID }) => void): Unsubscribe => on('portal:wake', cb),
    /** Ctrl+roda dentro da página: o gesto é do canvas (core/portal/portal-zoom.ts). */
    onZoomGesture: (
      cb: (p: { nodeId: UUID; direction: 'in' | 'out' }) => void
    ): Unsubscribe => on('portal:zoom-gesture', cb)
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

  /** Nós de imagem. Bytes num arquivo gerenciado; o renderer só lê o data URL. */
  image: {
    read: (
      workspaceId: UUID,
      fileName: string
    ): Promise<{ dataUrl: string } | { error: string }> =>
      ipcRenderer.invoke('image:read', workspaceId, fileName),
    onChanged: (cb: (p: { workspaceId: UUID; nodeId: UUID }) => void): Unsubscribe =>
      on('image:changed', cb)
  },

  /**
   * Nós de cofre. Tudo aqui trafega NOME de chave, nunca valor — a única
   * exceção é `reveal`, que devolve um valor por pedido explícito do usuário e
   * sob limite de frequência no main. Não existe `onChanged`: um evento que
   * carregasse segredo seria um segredo empurrado para o renderer sem ninguém
   * pedir.
   */
  vault: {
    /** false = sem chaveiro do SO; todo cofre está bloqueado neste sistema. */
    available: (): Promise<boolean> => ipcRenderer.invoke('vault:available'),
    listKeys: (workspaceId: UUID, nodeId: UUID): Promise<VaultKeysResult> =>
      ipcRenderer.invoke('vault:list-keys', workspaceId, nodeId),
    set: (workspaceId: UUID, nodeId: UUID, entry: VaultEntryInput): Promise<VaultKeysResult> =>
      ipcRenderer.invoke('vault:set', workspaceId, nodeId, entry),
    remove: (workspaceId: UUID, nodeId: UUID, key: string): Promise<VaultKeysResult> =>
      ipcRenderer.invoke('vault:remove', workspaceId, nodeId, key),
    /** O valor chega UMA vez. Quem o recebe não o guarda — ver o nó de cofre. */
    reveal: (
      workspaceId: UUID,
      nodeId: UUID,
      key: string
    ): Promise<{ value: string } | { error: string }> =>
      ipcRenderer.invoke('vault:reveal', workspaceId, nodeId, key),
    /** Linhas da trilha de auditoria, mais novas primeiro. Nunca trazem valor. */
    accessLog: (workspaceId: UUID, limit?: number): Promise<string[]> =>
      ipcRenderer.invoke('vault:access-log', workspaceId, limit),
    /** O agente gravou uma chave (`atelier vault set`): o nó aberto relê a lista. */
    onChanged: (cb: (p: { workspaceId: UUID; nodeId: UUID }) => void): Unsubscribe =>
      on('vault:changed', cb)
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

  /**
   * O que só o renderer sabe sobre um editor aberto: arquivo, buffer sujo,
   * cursor e seleção. `send`, não `invoke`: é notificação, e o único caminho por
   * onde o main pode responder às perguntas do agente sobre o que o usuário está
   * olhando. `state` nulo apaga a entrada (desmonte do nó).
   */
  editor: {
    push: (nodeId: UUID, state: EditorPush | null): void =>
      ipcRenderer.send('editor:state', nodeId, state)
  },

  /**
   * Quadro de TODO. O quadro vive num arquivo por nó, e não no workspace.json:
   * ele é reescrito a cada cartão movido.
   *
   * `apply` manda uma OPERAÇÃO, e nunca o quadro inteiro — é o que permite o
   * usuário arrastar um cartão enquanto um agente marca outro, sem um desfazer
   * o outro. Ver core/todo/todo-store.ts.
   */
  todo: {
    read: (workspaceId: UUID, file: string): Promise<TodoBoard | null> =>
      ipcRenderer.invoke('todo:read', workspaceId, file),
    apply: (
      workspaceId: UUID,
      file: string,
      op: unknown
    ): Promise<{ board: TodoBoard } | { error: string }> =>
      ipcRenderer.invoke('todo:apply', workspaceId, file, op),
    create: (workspaceId: UUID, file: string, title: string): Promise<TodoBoard> =>
      ipcRenderer.invoke('todo:create', workspaceId, file, title),
    /** O agente mexeu no quadro pelo CLI: releia. */
    onChanged: (cb: (p: { workspaceId: UUID; nodeId: UUID }) => void): Unsubscribe =>
      on('todo:changed', cb)
  },

  /**
   * Planos dos cartões daquele quadro — mesmo `file` do quadro, outro arquivo.
   *
   * A UI não recebe progresso pronto: ele é derivado por `planSnapshot`
   * (`@shared/task-status`) a partir do plano e da versão atual. Persistir o
   * número criaria um segundo lugar onde a verdade mora, e os dois divergiriam
   * no primeiro arquivo editado à mão.
   */
  plans: {
    read: (workspaceId: UUID, file: string): Promise<PlanBook | null> =>
      ipcRenderer.invoke('plans:read', workspaceId, file),
    apply: (
      workspaceId: UUID,
      file: string,
      op: unknown
    ): Promise<{ book: PlanBook; plan?: Plan; version?: PlanVersion } | { error: string }> =>
      ipcRenderer.invoke('plans:apply', workspaceId, file, op)
  },

  /**
   * Monitor de recursos. Assinatura ref-contada do lado do main: cada nó de
   * monitor montado chama `subscribe`, cada desmonte chama `unsubscribe`, e o
   * timer só existe enquanto houver pelo menos um.
   *
   * `send`, não `invoke`: são notificações, e a resposta chega pelo push
   * `onStats`. As amostras NÃO entram na store — ver use-system-stats.ts.
   */
  system: {
    subscribe: (diskPath?: string, intervalMs?: number): void =>
      ipcRenderer.send('system:subscribe', diskPath ?? '', intervalMs),
    /** O mesmo `intervalMs` da assinatura: é ele que diz qual entrada sai. */
    unsubscribe: (intervalMs?: number): void =>
      ipcRenderer.send('system:unsubscribe', intervalMs),
    /** Recarga da janela: os desmontes não chegam, e o timer ficaria órfão. */
    reset: (): void => ipcRenderer.send('system:reset'),
    onStats: (cb: (stats: SystemStats) => void): Unsubscribe => on('system:stats', cb)
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
