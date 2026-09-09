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

/**
 * Quem um comando de LAYOUT pode endereçar por nome: o próprio terminal, o que
 * está cabeado nele, e qualquer nó pelo prefixo do id.
 *
 * Mais largo que `findConnectedNode` de propósito — posicionar contra um
 * vizinho não é ler o conteúdo dele. O nó de texto e o botão pendente só saem
 * pelo id, e é por isso que o fallback varre o canvas inteiro: o nome deles ou
 * é truncado ou não existe.
 *
 * Vivia em handlers/node.ts, e saiu de lá quando `--under` levou a mesma
 * resolução para todo verbo que cria nó.
 */
export function resolveLayoutTarget(
  ws: NonNullable<ReturnType<typeof workspaceForTerminal>>,
  caller: CanvasNode,
  tid: UUID,
  name: string
): CanvasNode | null {
  const needle = name.toLowerCase().trim()
  const reachable = [caller, ...connectedNodes(tid)]

  const exact = reachable.find((n) => nodeDisplayName(n.content).toLowerCase() === needle)
  if (exact) return exact
  const partial = reachable.find((n) => nodeDisplayName(n.content).toLowerCase().includes(needle))
  if (partial) return partial
  return ws.nodes.find((n) => n.id.toLowerCase().startsWith(needle.slice(0, 8))) ?? null
}
