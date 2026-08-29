/**
 * Camada 4: as cordas.
 *
 * SVG num contêiner com o mesmo transform dos nós, então os paths ficam em
 * coordenadas de canvas e o pan/zoom sai de graça. Os `d` são escritos direto
 * no DOM pelo tick da física — nunca via estado do React.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { CanvasNode, Connection, Point, UUID } from '@shared/types'
import { RopeSimulation, ropePath } from './rope'
import { rectCenter, viewport } from './viewport'

const STATUS_CLASS: Record<string, string> = {
  idle: 'rope rope-idle',
  communicating: 'rope rope-communicating',
  error: 'rope rope-error'
}

interface Props {
  nodes: CanvasNode[]
  connections: Connection[]
  /** Muda a cada frame de arrasto para reancorar as cordas em tempo real. */
  liveFrames: React.MutableRefObject<Map<UUID, Point>>
  /** Membros de grupos colapsados — as cordas deles somem junto com os nós. */
  hiddenNodes?: Set<UUID>
}

export function ConnectionsLayer({
  nodes,
  connections,
  liveFrames,
  hiddenNodes
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<RopeSimulation | null>(null)
  const pathsRef = useRef(new Map<UUID, SVGPathElement>())

  /**
   * As cordas que aparecem: basta UMA das pontas estar dobrada para a corda
   * sair. Ela ligaria a moldura fechada ao lugar onde o nó estaria — um fio
   * saindo de um retângulo e morrendo no vazio.
   *
   * Sai do desenho e da reancoragem, mas NÃO da simulação: colapsar não move
   * nó nenhum, então a corda guardada volta exatamente como estava ao expandir.
   * Removê-la faria a expansão remontá-la a partir dos `ropePoints` do disco,
   * que podem estar velhos — e a corda daria um pulo na tela.
   */
  const visible = useMemo(() => {
    if (!hiddenNodes?.size) return connections
    return connections.filter(
      (c) => !hiddenNodes.has(c.nodeIdA) && !hiddenNodes.has(c.nodeIdB)
    )
  }, [connections, hiddenNodes])

  // Física: uma instância viva enquanto a camada existir
  useEffect(() => {
    const sim = new RopeSimulation()
    simRef.current = sim
    sim.onTick = (points) => {
      for (const [id, pts] of points) {
        const el = pathsRef.current.get(id)
        if (el) el.setAttribute('d', ropePath(pts))
      }
    }
    return () => {
      sim.clear()
      simRef.current = null
    }
  }, [])

  // Sincroniza as cordas com a lista de conexões
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return

    const centerOf = (id: UUID): Point | null => {
      const live = liveFrames.current.get(id)
      if (live) return live
      const node = nodes.find((n) => n.id === id)
      return node ? rectCenter(node.frame) : null
    }

    for (const conn of visible) {
      const a = centerOf(conn.nodeIdA)
      const b = centerOf(conn.nodeIdB)
      if (!a || !b) continue
      if (sim.has(conn.id)) {
        sim.updateAnchors(conn.id, a, b)
      } else {
        const existing = conn.ropePoints.length
          ? conn.ropePoints.map(([x, y]) => ({ x, y }))
          : undefined
        sim.add(conn.id, a, b, existing)
      }
    }
    // A varredura é sobre o que a SIMULAÇÃO carrega, não sobre a lista de
    // conexões: uma corda cuja conexão foi apagada não aparece mais na lista, e
    // iterar a lista nunca a alcançaria — ela ficava na física para sempre. A
    // lista completa, e não a visível, para a corda dobrada sobreviver.
    const live = new Set(connections.map((c) => c.id))
    for (const id of sim.ids()) if (!live.has(id)) sim.remove(id)
  }, [connections, visible, nodes, liveFrames])

  // Reancora durante o arrasto, a 60fps, sem passar pelo React
  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      const sim = simRef.current
      if (sim && liveFrames.current.size > 0) {
        for (const conn of visible) {
          const a = liveFrames.current.get(conn.nodeIdA)
          const b = liveFrames.current.get(conn.nodeIdB)
          if (!a && !b) continue
          const nodeA = nodes.find((n) => n.id === conn.nodeIdA)
          const nodeB = nodes.find((n) => n.id === conn.nodeIdB)
          if (!nodeA || !nodeB) continue
          sim.updateAnchors(conn.id, a ?? rectCenter(nodeA.frame), b ?? rectCenter(nodeB.frame))
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [visible, nodes, liveFrames])

  // Acompanha o transform do viewport
  useEffect(() => {
    return viewport.subscribe(() => {
      const svg = svgRef.current
      if (svg) svg.style.transform = viewport.transform()
    })
  }, [])

  return (
    <svg ref={svgRef} className="connections-layer" overflow="visible">
      {visible.map((conn) => (
        <path
          key={conn.id}
          ref={(el) => {
            if (el) pathsRef.current.set(conn.id, el)
            else pathsRef.current.delete(conn.id)
          }}
          className={STATUS_CLASS[conn.status] ?? STATUS_CLASS.idle}
          fill="none"
        />
      ))}
    </svg>
  )
}
