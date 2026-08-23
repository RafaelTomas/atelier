/**
 * Porte de Sources/Connection/ConnectionManager.swift.
 *
 * Duas responsabilidades que o app nativo mantém separadas e aqui continuam
 * separadas: o *modelo* das conexões vive no WorkspaceManager (é persistido);
 * este módulo cuida do estado visual efêmero e dos efeitos colaterais
 * (injeção de skill ao conectar).
 */
import type { ConnectionStatus, UUID } from '@shared/types'
import { log } from '../logger'
import { appState } from '../state/app-state'
import { terminals } from '../terminal/terminal-manager'
import { notifyRenderer } from '../../ipc/notify'
import { injectSkillInto } from './skill-injector'

/** Status é runtime puro — não vai para o disco. */
const statuses = new Map<UUID, ConnectionStatus>()

export function connectionStatus(id: UUID): ConnectionStatus {
  return statuses.get(id) ?? 'idle'
}

export function setConnectionStatus(id: UUID, status: ConnectionStatus): void {
  statuses.set(id, status)
  notifyRenderer('connection:status', { id, status })
}

/**
 * Chamado ao criar uma conexão. Injeta o `atelier` nos terminais das duas
 * pontas, como o SkillInjector do app nativo.
 */
export function onConnectionCreated(nodeIdA: UUID, nodeIdB: UUID): void {
  for (const id of [nodeIdA, nodeIdB]) {
    if (terminals.get(id)) injectSkillInto(id)
  }
  log.debug('connection', `conexão ${nodeIdA.slice(0, 8)} ↔ ${nodeIdB.slice(0, 8)}`)
}

/**
 * Ao restaurar um workspace, reinjeta SEM regerar UUIDs — é isso que mantém as
 * respostas do `atelier list` estáveis entre sessões.
 */
export function restoreConnections(workspaceId: UUID): void {
  const ws = appState.workspaces.get(workspaceId)
  if (!ws) return
  for (const conn of ws.connections) {
    statuses.set(conn.id, 'idle')
    for (const id of [conn.nodeIdA, conn.nodeIdB]) {
      if (terminals.get(id)) injectSkillInto(id)
    }
  }
  log.debug('connection', `${ws.connections.length} conexão(ões) restaurada(s)`)
}
