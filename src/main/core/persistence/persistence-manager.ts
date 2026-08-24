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
import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentRole,
  AppStateData,
  Preferences,
  UUID,
  WorkspaceManifest,
  WorkspacePayload
} from '@shared/types'
import { log } from '../logger'
import {
  decodeAppStateData,
  decodeManifest,
  decodePreferences,
  makeAppStateData,
  makeManifest,
  makePreferences
} from '../models/app-state'
import { decodeAgentRole, encodeAgentRole } from '../models/role'
import { decodeWorkspaceDocument, encodeWorkspaceDocument } from '../models/workspace'
import { migrateWorkspaceDocument } from './migrations'
import { paths } from './paths'

const isDev = process.env.NODE_ENV === 'development'

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

  async loadWorkspace(id: UUID): Promise<WorkspacePayload | null> {
    const raw = await this.readJSON(paths.workspaceFile(id))
    if (!raw) return null
    const migrated = migrateWorkspaceDocument(raw)
    const { payload } = decodeWorkspaceDocument(migrated)
    return payload
  }

  async saveWorkspace(payload: WorkspacePayload): Promise<void> {
    await this.ensureWorkspaceDirectories(payload.id)
    await this.atomicWrite(
      paths.workspaceFile(payload.id),
      this.stringify(encodeWorkspaceDocument(payload))
    )
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
