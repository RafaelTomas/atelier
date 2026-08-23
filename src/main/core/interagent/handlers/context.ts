/** Utilidades compartilhadas pelos handlers do CLI. */
import type { CanvasNode, UUID } from '@shared/types'
import { appState } from '../../state/app-state'
import type { WorkspaceManager } from '../../state/workspace-manager'
import { nodeDisplayName } from '../../models/node-content'

/** Workspace que contém o terminal chamador (não necessariamente o ativo). */
export function workspaceForTerminal(terminalId: UUID | null): WorkspaceManager | null {
  if (!terminalId) return appState.activeWorkspace
  for (const ws of appState.workspaces.values()) {
    if (ws.node(terminalId)) return ws
  }
  return appState.activeWorkspace
}

/** Nós conectados ao chamador — o escopo de permissão de todo comando. */
export function connectedNodes(terminalId: UUID): CanvasNode[] {
  const ws = workspaceForTerminal(terminalId)
  if (!ws) return []
  return ws
    .connectedNodeIds(terminalId)
    .map((id) => ws.node(id))
    .filter((n): n is CanvasNode => n !== undefined)
}

/**
 * Busca fuzzy por nome, igual ao AskHandler do Swift: nome exato, depois
 * substring, depois prefixo do UUID.
 */
export function findConnectedNode(
  terminalId: UUID,
  name: string,
  type?: CanvasNode['content']['type']
): CanvasNode | null {
  const candidates = connectedNodes(terminalId).filter((n) => !type || n.content.type === type)
  const needle = name.toLowerCase().trim()

  const exact = candidates.find((n) => nodeDisplayName(n.content).toLowerCase() === needle)
  if (exact) return exact

  const partial = candidates.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle))
  if (partial) return partial

  const byId = candidates.find((n) => n.id.toLowerCase().startsWith(needle.slice(0, 8)))
  return byId ?? null
}

export function requireTerminalId(terminalId: UUID | null): UUID | null {
  return terminalId && terminalId.length > 0 ? terminalId : null
}
