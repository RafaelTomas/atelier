/**
 * Camada 4: as cordas.
 *
 * SVG num contêiner com o mesmo transform dos nós, então os paths ficam em
 * coordenadas de canvas e o pan/zoom sai de graça. Os `d` são escritos direto
 * no DOM pelo tick da física — nunca via estado do React.
 */
import { useEffect, useRef } from 'react'
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
}

export function ConnectionsLayer({ nodes, connections, liveFrames }: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<RopeSimulation | null>(null)
  const pathsRef = useRef(new Map<UUID, SVGPathElement>())

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

    const alive = new Set<UUID>()
    for (const conn of connections) {
      const a = centerOf(conn.nodeIdA)
      const b = centerOf(conn.nodeIdB)
      if (!a || !b) continue
      alive.add(conn.id)
      if (sim.has(conn.id)) {
        sim.updateAnchors(conn.id, a, b)
      } else {
        const existing = conn.ropePoints.length
          ? conn.ropePoints.map(([x, y]) => ({ x, y }))
          : undefined
        sim.add(conn.id, a, b, existing)
      }
    }
    for (const conn of connections) if (!alive.has(conn.id)) sim.remove(conn.id)
  }, [connections, nodes, liveFrames])

  // Reancora durante o arrasto, a 60fps, sem passar pelo React
  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      const sim = simRef.current
      if (sim && liveFrames.current.size > 0) {
        for (const conn of connections) {
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
  }, [connections, nodes, liveFrames])

  // Acompanha o transform do viewport
  useEffect(() => {
    return viewport.subscribe(() => {
      const svg = svgRef.current
      if (svg) svg.style.transform = viewport.transform()
    })
  }, [])

  return (
    <svg ref={svgRef} className="connections-layer" overflow="visible">
      {connections.map((conn) => (
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
