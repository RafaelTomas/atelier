/**
 * Porte de Sources/App/AppState.swift.
 *
 * Raiz do estado no processo main. Mantém manifest, preferências, os
 * WorkspaceManagers carregados e o ciclo de autosave (30 s, só os sujos).
 */
import type { AppStateData, Preferences, UUID, WorkspaceManifest } from '@shared/types'
import { claudeAccounts } from '../claude/accounts'
import { nowISO } from '../coding'
import { Constants } from '../constants'
import { log } from '../logger'
import { makeAppStateData, makeWorkspaceEntry } from '../models/app-state'
import { makeWorkspacePayload } from '../models/workspace'
import { importLegacyDataIfNeeded, type ImportResult } from '../persistence/import-legacy'
import { persistence } from '../persistence/persistence-manager'
import { paths } from '../persistence/paths'
import { repairSharedNoteFiles } from './note-files'
import { projectIndex } from './project-store'
import { roles } from './role-store'
import { WorkspaceManager } from './workspace-manager'

class AppState {
  manifest!: WorkspaceManifest
  preferences!: Preferences
  data: AppStateData = makeAppStateData()
  workspaces = new Map<UUID, WorkspaceManager>()
  needsRecovery = false
  legacyImport: ImportResult = { imported: false }

  /**
   * Workspaces excluídos nesta sessão. Existe por causa de UMA corrida, e ela
   * perde dado de forma invisível: `saveDirtyWorkspaces` tira o retrato de
   * todos os sujos de uma vez e SÓ DEPOIS grava um a um, com await entre eles.
   * Uma exclusão no meio dessa fila encontraria o `rm` já feito e a gravação
   * seguinte RECRIARIA o diretório inteiro — com o arquivo do workspace que o
   * usuário acabou de mandar apagar.
   *
   * Tirar do Map não basta: o retrato já tinha sido tirado. Por isso o
   * conjunto é consultado imediatamente antes de cada gravação, e não na
   * filtragem lá de cima. Nunca é esvaziado: um id de workspace não volta.
   */
  private deleted = new Set<UUID>()

  private autosaveTimer: NodeJS.Timeout | null = null

  /**
   * Cold start. Os três JSON raiz são lidos em paralelo, como o `async let` do Swift.
   */
  async loadOnLaunch(): Promise<void> {
    // Antes de qualquer criação de diretório: se este é o primeiro boot e existe
    // instalação do app nativo, herda os workspaces em vez de abrir vazio.
    this.legacyImport = await importLegacyDataIfNeeded()

    await persistence.ensureDirectories()

    const [manifest, preferences, data] = await Promise.all([
      persistence.loadManifest(),
      persistence.loadPreferences(),
      persistence.loadAppState(),
      roles.load(), // responsabilidades: mapa em memória antes de qualquer terminal
      projectIndex.load(), // índice de projetos: global, independe do workspace ativo
      claudeAccounts.load() // contas do Claude: lidas antes do primeiro spawn de PTY
    ])

    this.manifest = manifest
    this.preferences = preferences
    this.data = data

    // Recuperação de crash: cleanShutdown false significa que o app morreu sem gravar
    this.needsRecovery = data.cleanShutdown === false
    if (this.needsRecovery) log.warn('appstate', 'shutdown sujo detectado na sessão anterior')

    // Marca a sessão como em andamento
    this.data.cleanShutdown = false
    this.data.lastOpenedAt = nowISO()
    await persistence.saveAppState(this.data)

    // Primeiro boot: materializa preferences.json com os padrões, para que o
    // arquivo exista e seja editável antes de o usuário mudar qualquer coisa
    if (!(await persistence.exists(paths.preferences()))) {
      await persistence.savePreferences(this.preferences)
    }

    // Primeira execução: cria um workspace vazio
    if (this.manifest.workspaces.length === 0) {
      const ws = await this.createWorkspace('Workspace', process.env.HOME ?? '')
      this.data.activeWorkspaceId = ws.id
    }

    const activeId = this.data.activeWorkspaceId ?? this.manifest.workspaces[0]?.id ?? null
    if (activeId) await this.openWorkspace(activeId)
    this.data.activeWorkspaceId = activeId

    // Regrava agora que o workspace ativo é conhecido: sem isto, um crash antes
    // do primeiro autosave deixaria activeWorkspaceId nulo no disco.
    await persistence.saveAppState(this.data)
  }

  get activeWorkspace(): WorkspaceManager | null {
    const id = this.data.activeWorkspaceId
    return id ? this.workspaces.get(id) ?? null : null
  }

  // ─── Workspaces ─────────────────────────────────────────────────────────────

  async createWorkspace(name: string, workingDirectory: string): Promise<WorkspaceManager> {
    const payload = makeWorkspacePayload(name, workingDirectory)
    const entry = makeWorkspaceEntry(name, workingDirectory, payload.id)

    await persistence.ensureWorkspaceDirectories(payload.id)
    await persistence.saveWorkspace(payload)

    this.manifest.workspaces.push(entry)
    await persistence.saveManifest(this.manifest)

    const manager = new WorkspaceManager(payload)
    this.workspaces.set(payload.id, manager)
    return manager
  }

  async openWorkspace(id: UUID): Promise<WorkspaceManager | null> {
    const cached = this.workspaces.get(id)
    if (cached) {
      this.data.activeWorkspaceId = id
      return cached
    }

    const loaded = await persistence.loadWorkspaceDocument(id)
    if (!loaded) {
      log.error('appstate', `workspace ${id} não encontrado em disco`)
      return null
    }

    const manager = new WorkspaceManager(loaded.payload, loaded)
    if (manager.isSafeMode) {
      log.warn(
        'appstate',
        `workspace ${id} aberto em modo seguro: ${loaded.droppedNodes} nó(s) não reconhecido(s), arquivo v${loaded.fileSchemaVersion}`
      )
    }
    // Notas de workspaces antigos podiam dividir o mesmo .md — separa antes de
    // o renderer ler os arquivos. Modo seguro não regrava nada.
    if (!manager.isSafeMode) await repairSharedNoteFiles(manager)

    this.workspaces.set(id, manager)
    this.data.activeWorkspaceId = id

    const entry = this.manifest.workspaces.find((w) => w.id === id)
    if (entry) {
      entry.lastOpenedAt = nowISO()
      void persistence.saveManifest(this.manifest)
    }
    return manager
  }

  /** Renomeia em memória, no manifest e no payload — os dois guardam o nome. */
  async renameWorkspace(id: UUID, name: string): Promise<boolean> {
    const trimmed = name.trim()
    if (!trimmed) return false

    const entry = this.manifest.workspaces.find((w) => w.id === id)
    if (!entry) return false
    entry.name = trimmed
    await persistence.saveManifest(this.manifest)

    const manager = this.workspaces.get(id)
    if (manager) {
      manager.setName(trimmed)
      return true
    }

    // Workspace não carregado: grava direto no arquivo para o nome não divergir.
    const payload = await persistence.loadWorkspace(id)
    if (payload) {
      payload.name = trimmed
      payload.lastModifiedAt = nowISO()
      await persistence.saveWorkspace(payload)
    }
    return true
  }

  /**
   * Destrutiva de verdade: apaga o diretório inteiro do workspace, notas `.md`
   * e anexos junto. Não há lixeira nem desfazer — quem chama tem de ter
   * confirmado com o usuário antes.
   */
  async deleteWorkspace(id: UUID): Promise<void> {
    // Antes do rm, e antes de qualquer await: é o que impede um autosave já em
    // voo de recriar o diretório logo depois de ele sumir.
    this.deleted.add(id)
    this.workspaces.delete(id)
    this.manifest.workspaces = this.manifest.workspaces.filter((w) => w.id !== id)
    await persistence.saveManifest(this.manifest)
    await persistence.deleteWorkspace(id)
    if (this.data.activeWorkspaceId === id) {
      this.data.activeWorkspaceId = this.manifest.workspaces[0]?.id ?? null
    }
  }

  // ─── Autosave ───────────────────────────────────────────────────────────────

  startAutosave(): void {
    if (this.autosaveTimer) return
    this.autosaveTimer = setInterval(() => {
      void this.saveDirtyWorkspaces()
    }, Constants.autosaveIntervalMs)
    log.debug('appstate', `autosave ligado (${Constants.autosaveIntervalMs}ms)`)
  }

  stopAutosave(): void {
    if (!this.autosaveTimer) return
    clearInterval(this.autosaveTimer)
    this.autosaveTimer = null
  }

  /**
   * Snapshot na hora, I/O depois — o padrão do app nativo.
   *
   * Workspace em modo seguro é PULADO: gravar por cima apagaria os nós que o
   * decoder não entendeu. `force` é a saída, e só chega aqui pelo botão Salvar
   * da barra — uma ação explícita do usuário, com o aviso na tela.
   */
  async saveDirtyWorkspaces(force = false): Promise<number> {
    const dirty = [...this.workspaces.values()].filter(
      (w) => w.isDirty && (force || !w.isSafeMode)
    )
    if (dirty.length === 0) return 0

    const snapshots = dirty.map((w) => ({ manager: w, payload: w.snapshot() }))
    let saved = 0
    for (const { manager, payload } of snapshots) {
      // Excluído entre o retrato e a vez dele na fila: gravar agora recriaria
      // o diretório que o `rm` acabou de levar.
      if (this.deleted.has(payload.id)) continue
      try {
        await persistence.saveWorkspace(payload, manager.fileSchemaVersion)
        manager.isDirty = false
        manager.fileSchemaVersion = Constants.schemaVersion
        // Depois de um save forçado o arquivo já não tem o que não era
        // entendido: o aviso perdeu o objeto e sai da tela.
        manager.droppedNodes = 0
        saved++
      } catch (err) {
        log.error('appstate', `falha salvando workspace ${payload.id}`, err)
      }
    }
    log.debug('appstate', `autosave gravou ${saved} workspace(s)`)
    return saved
  }

  /** Shutdown gracioso: grava tudo e marca cleanShutdown. */
  async shutdown(): Promise<void> {
    this.stopAutosave()
    for (const manager of this.workspaces.values()) {
      if (this.deleted.has(manager.id)) continue
      // Fechar o app não é permissão para gravar por cima do que não foi
      // entendido: em modo seguro o arquivo fica como está.
      if (manager.isSafeMode) {
        log.warn('appstate', `workspace ${manager.id} não gravado: modo seguro`)
        continue
      }
      try {
        await persistence.saveWorkspace(manager.snapshot(), manager.fileSchemaVersion)
        manager.isDirty = false
        manager.fileSchemaVersion = Constants.schemaVersion
      } catch (err) {
        log.error('appstate', `falha no shutdown do workspace ${manager.id}`, err)
      }
    }
    try {
      await persistence.saveManifest(this.manifest)
      this.data.cleanShutdown = true
      await persistence.saveAppState(this.data)
    } catch (err) {
      log.error('appstate', 'falha gravando estado no shutdown', err)
    }
    log.info('appstate', 'shutdown concluído')
  }
}

export const appState = new AppState()
