/**
 * Geometria das molduras de grupo — a parte que depende do viewport.
 *
 * As medidas e os retângulos puros mudaram para `@shared/group-geometry`
 * quando o main passou a criar grupos pelo CLI (`atelier node group`): os dois
 * processos precisam da MESMA folga e da mesma faixa de título. Este arquivo
 * reexporta tudo, então quem já importava daqui continua importando daqui —
 * é o endereço que a store, o canvas-view e a camada de render conhecem.
 */
import type { NodeGroup, UUID } from '@shared/types'

export {
  GROUP_TITLE_HEIGHT,
  GROUP_PADDING,
  GROUP_MIN_WIDTH,
  GROUP_MIN_HEIGHT,
  GROUP_EDGE,
  boundsForNodes,
  rectContains,
  // `groupAt` saiu daqui para o compartilhado quando o `atelier node move`
  // passou a mover nó pelo CLI: a decisão de quem está dentro da moldura tem
  // de ser a MESMA no fim de um arrasto e num comando de agente.
  groupAt
} from '@shared/group-geometry'

/** O grupo de que este nó é membro, ou null. */
export function groupOf(groups: NodeGroup[], nodeId: UUID): NodeGroup | null {
  return groups.find((g) => g.nodeIds.includes(nodeId)) ?? null
}

/** Ids de todos os nós que estão dentro de ALGUM grupo colapsado. */
export function collapsedMembers(groups: NodeGroup[]): Set<UUID> {
  const out = new Set<UUID>()
  for (const g of groups) {
    if (!g.isCollapsed) continue
    for (const id of g.nodeIds) out.add(id)
  }
  return out
}
