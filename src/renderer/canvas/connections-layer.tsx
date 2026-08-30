/**
 * Camada 4: as cordas.
 *
 * SVG num contêiner com o mesmo transform dos nós, então os paths ficam em
 * coordenadas de canvas e o pan/zoom sai de graça. Os `d` são escritos direto
 * no DOM pelo tick da física — nunca via estado do React.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasNode, Connection, Point, UUID } from '@shared/types'
import { IconScissors } from '../icons'
import { store } from '../state/store'
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
  // Path invisível e mais grosso por cima de cada corda, só para dar uma área
  // de clique generosa — a corda visível tem 2px, quase impossível de acertar.
  const hitPathsRef = useRef(new Map<UUID, SVGPathElement>())

  // Tesourinha no hover: mostra perto do cursor, não na corda (a corda se move
  // sozinha pela física — perseguir o ponto exato seria mais trabalho para um
  // ganho que ninguém nota).
  const [scissors, setScissors] = useState<{ id: UUID; x: number; y: number } | null>(null)
  const hideTimer = useRef<number | null>(null)

  const cancelHide = (): void => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const scheduleHide = (): void => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setScissors(null), 150)
  }

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
        const d = ropePath(pts)
        const el = pathsRef.current.get(id)
        if (el) el.setAttribute('d', d)
        const hit = hitPathsRef.current.get(id)
        if (hit) hit.setAttribute('d', d)
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
    <>
      <svg ref={svgRef} className="connections-layer" overflow="visible">
        {visible.map((conn) => (
          <path
            key={`hit-${conn.id}`}
            ref={(el) => {
              if (el) hitPathsRef.current.set(conn.id, el)
              else hitPathsRef.current.delete(conn.id)
            }}
            fill="none"
            stroke="transparent"
            strokeWidth={16}
            style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
            onMouseMove={(e) => {
              cancelHide()
              setScissors({ id: conn.id, x: e.clientX, y: e.clientY })
            }}
            onMouseLeave={scheduleHide}
          />
        ))}
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

      {scissors && (
        <button
          type="button"
          className="rope-scissors"
          title="Cortar conexão"
          style={{ position: 'fixed', left: scissors.x, top: scissors.y }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          onClick={() => {
            void store.removeConnection(scissors.id)
            setScissors(null)
          }}
        >
          <IconScissors size={14} />
        </button>
      )}
    </>
  )
}
