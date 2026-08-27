/**
 * Porte de Sources/Workspace/PersistenceManager.swift.
 *
 * Regra herdada do app nativo: TODA I/O de arquivo do app passa por aqui.
 * `fs` direto fora desta classe é violação de arquitetura.
 *
 * Escrita atômica: grava `.tmp` no mesmo diretório, faz fsync e renomeia.
 * `fs.rename` é atômico no mesmo sistema de arquivos e, no Windows, o Node usa
 * MoveFileEx com MOVEFILE_REPLACE_EXISTING — substitui sem erro.
 */
import { constants } from 'node:fs'
import { access, copyFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentRole,
  AppStateData,
  Preferences,
  ProjectIndex,
  UUID,
  WorkspaceManifest,
  WorkspacePayload
} from '@shared/types'
import { asRecord, num } from '../coding'
import { Constants } from '../constants'
import { log } from '../logger'
import {
  decodeAppStateData,
  decodeManifest,
  decodePreferences,
  makeAppStateData,
  makeManifest,
  makePreferences
} from '../models/app-state'
import {
  decodeProjectIndex,
  encodeProjectIndex,
  makeProjectIndex
} from '../models/project'
import { decodeAgentRole, encodeAgentRole } from '../models/role'
import { decodeWorkspaceDocument, encodeWorkspaceDocument } from '../models/workspace'
import { migrateWorkspaceDocument } from './migrations'
import { paths } from './paths'

const isDev = process.env.NODE_ENV === 'development'

/** O workspace lido e o que o decoder observou no caminho. */
export interface LoadedWorkspace {
  payload: WorkspacePayload
  /** A versão gravada no arquivo, antes da migração. */
  fileSchemaVersion: number
  droppedNodes: number
}

class PersistenceManager {
  // ─── Infra ──────────────────────────────────────────────────────────────────

  private stringify(value: unknown): string {
    // Em dev, pretty + chaves ordenadas, para o diff contra os arquivos do app Swift
    return isDev ? JSON.stringify(value, sortedReplacer, 2) : JSON.stringify(value)
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync() // garante que os bytes chegaram ao disco antes do rename
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, filePath)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  private async readJSON(filePath: string): Promise<unknown | null> {
    try {
      const text = await readFile(filePath, 'utf8')
      return JSON.parse(text)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.error('persistence', `falha lendo ${filePath}`, err)
      return null
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  // ─── Diretórios ─────────────────────────────────────────────────────────────

  async ensureDirectories(): Promise<void> {
    for (const dir of [paths.root(), paths.workspacesDir(), paths.rolesDir(), paths.runDir()]) {
      await mkdir(dir, { recursive: true })
    }
  }

  async ensureWorkspaceDirectories(id: UUID): Promise<void> {
    for (const dir of [
      paths.workspaceDir(id),
      paths.notesDir(id),
      paths.tablesDir(id),
      paths.terminalsDir(id),
      paths.snapshotsDir(id)
    ]) {
      await mkdir(dir, { recursive: true })
    }
  }

  // ─── manifest.json ──────────────────────────────────────────────────────────

  async loadManifest(): Promise<WorkspaceManifest> {
    const raw = await this.readJSON(paths.manifest())
    return raw ? decodeManifest(raw) : makeManifest()
  }

  async saveManifest(manifest: WorkspaceManifest): Promise<void> {
    await this.atomicWrite(paths.manifest(), this.stringify(manifest))
  }

  // ─── app-state.json ─────────────────────────────────────────────────────────

  async loadAppState(): Promise<AppStateData> {
    const raw = await this.readJSON(paths.appState())
    return raw ? decodeAppStateData(raw) : makeAppStateData()
  }

  async saveAppState(state: AppStateData): Promise<void> {
    await this.atomicWrite(paths.appState(), this.stringify(state))
  }

  // ─── preferences.json ───────────────────────────────────────────────────────

  async loadPreferences(): Promise<Preferences> {
    const raw = await this.readJSON(paths.preferences())
    return raw ? decodePreferences(raw) : makePreferences()
  }

  async savePreferences(prefs: Preferences): Promise<void> {
    await this.atomicWrite(paths.preferences(), this.stringify(prefs))
  }

  // ─── workspace.json ─────────────────────────────────────────────────────────

  /**
   * Lê o workspace com o que o decoder tem a dizer sobre ele: a versão que
   * estava no arquivo e quantos nós não sobreviveram à leitura.
   *
   * Quem abre precisa dos dois: a versão decide se cabe um backup no primeiro
   * save, e a contagem decide se o workspace entra em modo seguro em vez de
   * regravar o arquivo sem os nós que não foram entendidos.
   */
  async loadWorkspaceDocument(id: UUID): Promise<LoadedWorkspace | null> {
    const raw = await this.readJSON(paths.workspaceFile(id))
    if (!raw) return null
    const fileSchemaVersion = num(asRecord(raw).schemaVersion, 1)
    const migrated = migrateWorkspaceDocument(raw)
    const { payload, droppedNodes } = decodeWorkspaceDocument(migrated)
    if (droppedNodes > 0) {
      log.warn(
        'persistence',
        `workspace ${id}: ${droppedNodes} nó(s) não reconhecido(s) — gravação bloqueada`
      )
    }
    return { payload, fileSchemaVersion, droppedNodes }
  }

  async loadWorkspace(id: UUID): Promise<WorkspacePayload | null> {
    return (await this.loadWorkspaceDocument(id))?.payload ?? null
  }

  /**
   * `backupFrom` é a versão que está no arquivo em disco. Quando ela é menor
   * que a do app, o original é copiado para `workspace.v{n}.backup.json` ANTES
   * da primeira gravação na versão nova.
   *
   * Custa uma escrita, uma vez na vida do arquivo, e é a única rede para quem
   * precisar voltar ao app nativo ou a um build anterior: uma vez regravado em
   * v3, o arquivo não volta sozinho para v2.
   */
  async saveWorkspace(payload: WorkspacePayload, backupFrom?: number): Promise<void> {
    await this.ensureWorkspaceDirectories(payload.id)
    const file = paths.workspaceFile(payload.id)

    if (typeof backupFrom === 'number' && backupFrom < Constants.schemaVersion) {
      const backup = join(paths.workspaceDir(payload.id), `workspace.v${backupFrom}.backup.json`)
      // Nunca sobrescreve um backup existente: o valor dele é ser o arquivo
      // como estava ANTES da subida, não a última cópia.
      if ((await this.exists(file)) && !(await this.exists(backup))) {
        try {
          await copyFile(file, backup)
          log.info('persistence', `backup v${backupFrom} gravado em ${backup}`)
        } catch (err) {
          log.error('persistence', 'falha gravando backup da versão anterior', err)
        }
      }
    }

    await this.atomicWrite(file, this.stringify(encodeWorkspaceDocument(payload)))
  }

  async deleteWorkspace(id: UUID): Promise<void> {
    await rm(paths.workspaceDir(id), { recursive: true, force: true })
  }

  // ─── Responsabilidades (roles/*.json) ───────────────────────────────────────
  // Um arquivo por responsabilidade: criar, editar ou apagar uma não reescreve
  // as outras, e dá para versionar ou editar à mão fora do app.

  async loadRoles(): Promise<AgentRole[]> {
    let files: string[]
    try {
      files = await readdir(paths.rolesDir())
    } catch {
      return []
    }

    const roles: AgentRole[] = []
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const raw = await this.readJSON(join(paths.rolesDir(), file))
      if (raw) roles.push(decodeAgentRole(raw))
    }
    return roles
  }

  async saveRole(role: AgentRole): Promise<void> {
    await mkdir(paths.rolesDir(), { recursive: true })
    await this.atomicWrite(paths.roleFile(role.id), this.stringify(encodeAgentRole(role)))
  }

  async deleteRole(id: UUID): Promise<void> {
    await rm(paths.roleFile(id), { force: true })
  }

  // ─── Índice de projetos (projects.json) ─────────────────────────────────────
  // Arquivo raiz próprio, com schema próprio: o índice é global, não pertence a
  // nenhum workspace, e não tem contraparte no app Swift — por isso fica fora
  // do workspace.json e das migrações dele.

  async loadProjectIndex(): Promise<ProjectIndex> {
    const raw = await this.readJSON(paths.projects())
    return raw ? decodeProjectIndex(raw) : makeProjectIndex()
  }

  async saveProjectIndex(index: ProjectIndex): Promise<void> {
    await this.atomicWrite(paths.projects(), this.stringify(encodeProjectIndex(index)))
  }

  // ─── Notas (.md) ────────────────────────────────────────────────────────────

  async readNote(workspaceId: UUID, fileName: string): Promise<string> {
    try {
      return await readFile(join(paths.notesDir(workspaceId), fileName), 'utf8')
    } catch {
      return ''
    }
  }

  async writeNote(workspaceId: UUID, fileName: string, content: string): Promise<void> {
    await mkdir(paths.notesDir(workspaceId), { recursive: true })
    await this.atomicWrite(join(paths.notesDir(workspaceId), fileName), content)
  }

  // ─── Tabelas de resultado (.json) ───────────────────────────────────────────
  // Espelham readNote/writeNote: colunas e linhas de um nó dataTable vivem num
  // arquivo gerenciado, e só a identidade fica no workspace.json.

  async readTable(workspaceId: UUID, fileName: string): Promise<unknown | null> {
    return this.readJSON(join(paths.tablesDir(workspaceId), fileName))
  }

  async writeTable(workspaceId: UUID, fileName: string, value: unknown): Promise<void> {
    await mkdir(paths.tablesDir(workspaceId), { recursive: true })
    await this.atomicWrite(join(paths.tablesDir(workspaceId), fileName), this.stringify(value))
  }

  // ─── Scrollback ─────────────────────────────────────────────────────────────
  // Não usa escrita atômica: é append de alta frequência (mesma exceção do app nativo).

  async appendScrollback(workspaceId: UUID, terminalId: UUID, chunk: string): Promise<void> {
    const file = paths.scrollback(workspaceId, terminalId)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, chunk, { flag: 'a', encoding: 'utf8' })
  }

  async readScrollback(workspaceId: UUID, terminalId: UUID): Promise<string> {
    try {
      return await readFile(paths.scrollback(workspaceId, terminalId), 'utf8')
    } catch {
      return ''
    }
  }
}

/** Ordena chaves na saída para diff estável contra os arquivos do app Swift. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (value as Record<string, unknown>)[k]
        return acc
      }, {})
  }
  return value
}

export const persistence = new PersistenceManager()
