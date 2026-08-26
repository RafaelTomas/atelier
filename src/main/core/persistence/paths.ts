/**
 * Caminhos em disco. Mantém o layout de ~/.atelier/ do app nativo, com
 * `ATELIER_HOME` como escape para desenvolvimento (npm run dev aponta para
 * ~/.atelier-dev, para nunca tocar nos dados reais do usuário).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { Constants } from '../constants'

export function dataDir(): string {
  const override = process.env.ATELIER_HOME
  if (override && override.trim().length > 0) {
    return override.replace(/^~(?=$|\/|\\)/, homedir())
  }
  return join(homedir(), Constants.appDataDirectoryName)
}

export const paths = {
  root: dataDir,
  appState: () => join(dataDir(), 'app-state.json'),
  preferences: () => join(dataDir(), 'preferences.json'),
  manifest: () => join(dataDir(), 'manifest.json'),
  routines: () => join(dataDir(), 'routines.json'),
  projects: () => join(dataDir(), 'projects.json'),
  workspacesDir: () => join(dataDir(), 'workspaces'),
  rolesDir: () => join(dataDir(), 'roles'),
  roleFile: (id: UUID) => join(dataDir(), 'roles', `${id}.json`),
  runDir: () => join(dataDir(), 'run'),
  workspaceDir: (id: UUID) => join(dataDir(), 'workspaces', id),
  workspaceFile: (id: UUID) => join(dataDir(), 'workspaces', id, 'workspace.json'),
  notesDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'notes'),
  terminalsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'terminals'),
  snapshotsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'snapshots'),
  /** Capturas de portal pedidas pelo agente (`atelier portal shot`). */
  shotsDir: (id: UUID) => join(dataDir(), 'workspaces', id, 'shots'),
  scrollback: (workspaceId: UUID, terminalId: UUID) =>
    join(dataDir(), 'workspaces', workspaceId, 'terminals', `${terminalId}.scrollback`)
}

/**
 * Endereço do servidor IPC.
 * Unix socket no macOS/Linux, named pipe no Windows — a API do `net` é a mesma.
 */
export function ipcSocketPath(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\atelier'
  return join(dataDir(), 'run', 'agent.sock')
}

/** ~/.claude/skills/ — destino da skill injetada (igual nos três sistemas). */
export function claudeSkillsDir(): string {
  return join(homedir(), '.claude', 'skills')
}
