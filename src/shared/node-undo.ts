/**
 * Desfazer a remoção de um nó: o que guardar antes de apagar e como recolocar.
 *
 * Funções PURAS, em `shared/` e não num dos dois lados, porque a poda de um nó
 * acontece DUAS vezes no mesmo gesto — no `WorkspaceManager` (que é quem grava)
 * e no espelho do renderer (que é quem desenha). Um undo que reconstruísse o
 * grafo de dois jeitos diferentes daria a divergência mais cara possível: a
 * tela mostrando um cabo que o arquivo não tem. Aqui a regra é uma só, e
 * `scripts/test-undo-delete.mjs` fixa cada caso de canto.
 *
 * O que um nó apagado leva junto — e portanto o que o snapshot precisa ter:
 * ele mesmo, os cabos que o tocavam (as duas pontas somem quando uma some) e o
 * grupo de que era membro. Sem os três, "voltar" devolveria um nó solto, sem
 * cabos e fora da moldura, que é quase pior do que não voltar.
 */
import type { CanvasNode, Connection, NodeGroup, UUID } from './types'

/**
 * Janela em que um delete ainda pode ser desfeito, em ms.
 *
 * 60s é o tempo de perceber o erro e reagir — o aviso na barra vive 7s, mas o
 * ⌘Z continua valendo depois que ele some, e é o atalho, não o aviso, que a
 * pessoa alcança quando entende o que apagou. Do outro lado, é o tempo que os
 * bytes de uma imagem apagada ficam ocupando disco à toa: mais que isso e o
 * undo passa a ser um lixo acumulado, não uma rede de segurança.
 */
export const UNDO_WINDOW_MS = 60_000

/**
 * Tudo o que morreu junto com um nó. Serializável: atravessa o IPC como está.
 */
export interface RemovedNodeSnapshot {
  node: CanvasNode
  /** Os cabos que tocavam o nó, na íntegra — id incluído. */
  connections: Connection[]
  /** De que moldura era membro. null = estava solto. */
  groupId: UUID | null
}

/** A parte do workspace que um delete mexe. */
export interface NodeGraph {
  nodes: CanvasNode[]
  connections: Connection[]
  groups: NodeGroup[]
}

/**
 * O retrato de N nós ANTES de removê-los. Chamar com o grafo ainda intacto.
 *
 * Clona: o snapshot precisa sobreviver à mutação que vem logo depois, e no
 * renderer o nó é o mesmo objeto que o array de estado carrega.
 */
export function captureRemoval(graph: NodeGraph, nodeIds: UUID[]): RemovedNodeSnapshot[] {
  const wanted = new Set(nodeIds)
  return graph.nodes
    .filter((n) => wanted.has(n.id))
    .map((node) => ({
      node: structuredClone(node),
      connections: graph.connections
        .filter((c) => c.nodeIdA === node.id || c.nodeIdB === node.id)
        .map((c) => structuredClone(c)),
      groupId: graph.groups.find((g) => g.nodeIds.includes(node.id))?.id ?? null
    }))
}

/**
 * Recoloca o que `captureRemoval` guardou. Devolve arrays NOVOS; não muta.
 *
 * É tolerante de propósito, porque o mundo andou entre o delete e o ⌘Z: a
 * moldura pode ter sido desfeita, o outro lado de um cabo pode ter sido apagado
 * também, e o mesmo snapshot pode chegar duas vezes (⌘Z repetido, ou o main
 * aplicando o que o renderer já aplicou). Nada disso é erro — cada peça que não
 * cabe mais é simplesmente deixada de fora, e o resto volta.
 *
 * O `zIndex` do snapshot é preservado em vez de ir para o topo: o nó volta para
 * a mesma camada em que estava, senão desfazer reordenaria a pilha.
 */
export function restoreRemoval(graph: NodeGraph, snapshots: RemovedNodeSnapshot[]): NodeGraph {
  const nodes = [...graph.nodes]
  const present = new Set(nodes.map((n) => n.id))

  // Os nós TODOS primeiro: um cabo entre dois nós apagados no mesmo gesto só
  // é válido depois que os dois voltaram.
  for (const snap of snapshots) {
    if (present.has(snap.node.id)) continue
    nodes.push(structuredClone(snap.node))
    present.add(snap.node.id)
  }

  const connections = [...graph.connections]
  const byId = new Set(connections.map((c) => c.id))
  const pairs = new Set(connections.map((c) => pairKey(c.nodeIdA, c.nodeIdB)))
  for (const snap of snapshots) {
    for (const conn of snap.connections) {
      if (!present.has(conn.nodeIdA) || !present.has(conn.nodeIdB)) continue
      const pair = pairKey(conn.nodeIdA, conn.nodeIdB)
      if (byId.has(conn.id) || pairs.has(pair)) continue
      connections.push(structuredClone(conn))
      byId.add(conn.id)
      pairs.add(pair)
    }
  }

  // A moldura só recebe de volta quem ela perdeu por causa do delete. Um nó
  // pertence a no máximo um grupo — a mesma regra do WorkspaceManager.
  const backTo = new Map<UUID, UUID>()
  for (const snap of snapshots) {
    if (snap.groupId && present.has(snap.node.id)) backTo.set(snap.node.id, snap.groupId)
  }
  const groups = graph.groups.map((g) => {
    const returning = [...backTo].filter(
      ([nodeId, groupId]) => groupId === g.id && !g.nodeIds.includes(nodeId)
    )
    if (returning.length === 0) return g
    return { ...g, nodeIds: [...g.nodeIds, ...returning.map(([nodeId]) => nodeId)] }
  })

  return { nodes, connections, groups }
}

/** Quantos nós do snapshot ainda faltam no grafo — 0 significa "nada a desfazer". */
export function pendingRestores(graph: NodeGraph, snapshots: RemovedNodeSnapshot[]): number {
  const present = new Set(graph.nodes.map((n) => n.id))
  return snapshots.filter((s) => !present.has(s.node.id)).length
}

/** Cabo é sem direção para efeito de duplicata: A–B e B–A são o mesmo cabo. */
function pairKey(a: UUID, b: UUID): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
