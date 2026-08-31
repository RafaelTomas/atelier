/**
 * Cabo fantasma do modo conectar.
 *
 * Entre o clique no `⇄` e o clique no destino, um cabo tracejado sai do nó de
 * origem e segue o cursor. Usa a MESMA física das cordas reais, então o cabo
 * que nasce ao soltar já aparece na forma que o fantasma tinha.
 *
 * Como o resto do canvas, o `d` é escrito direto no DOM a 60fps: um setState
 * por mousemove re-renderizaria a árvore inteira (invariante 3 do README).
 */
import { useEffect, useRef } from 'react'
import type { CanvasNode, Connection, Point, UUID } from '@shared/types'
import { connectionKindForTypes } from '@shared/types'
import { RopeSimulation, ropePath } from './rope'
import { geometryPath, ropeLayers } from './rope-shapes'
import { rectCenter, rectEdgePoint, viewport } from './viewport'
import { useStore } from '../state/store'

/** Id do fantasma na simulação — nunca colide com um UUID de verdade. */
const PREVIEW_ID = 'preview' as UUID

interface Props {
  /** Nó de onde o cabo sai. */
  from: UUID
  nodes: CanvasNode[]
  connections: Connection[]
  /** Host do canvas, para converter clientX/Y em ponto de canvas. */
  hostRef: React.RefObject<HTMLDivElement>
  hitTest: (canvasPoint: Point) => CanvasNode | null
}

/**
 * O par pode virar cabo? Mesma regra do WorkspaceManager (o `kind` vem do
 * módulo compartilhado), mais a recusa de duplicata que o `addConnection` faz.
 */
export function canLink(a: CanvasNode, b: CanvasNode, connections: Connection[]): boolean {
  if (a.id === b.id) return false
  if (!connectionKindForTypes(a.content.type, b.content.type)) return false
  return !connections.some(
    (c) =>
      (c.nodeIdA === a.id && c.nodeIdB === b.id) || (c.nodeIdA === b.id && c.nodeIdB === a.id)
  )
}

export function ConnectionPreview({
  from,
  nodes,
  connections,
  hostRef,
  hitTest
}: Props): JSX.Element {
  const { ropeStyle, ropeThickness } = useStore()
  const svgRef = useRef<SVGSVGElement>(null)
  // Lista, e não um elemento: o fantasma precisa dos mesmos acabamentos
  // empilhados do desenho escolhido, senão ele mente sobre o que vai virar.
  const pathsRef = useRef<SVGPathElement[]>([])
  const layers = ropeLayers(ropeStyle)

  // Props lidas de dentro do mousemove ficam em ref: assim o listener não é
  // recriado a cada render, e a física não reinicia no meio do gesto.
  const latest = useRef({ nodes, connections, hitTest })
  latest.current = { nodes, connections, hitTest }

  useEffect(() => {
    return viewport.subscribe(() => {
      const svg = svgRef.current
      if (svg) svg.style.transform = viewport.transform()
    })
  }, [])

  useEffect(() => {
    const sim = new RopeSimulation()
    sim.onTick = (points) => {
      const pts = points.get(PREVIEW_ID)
      if (!pts) return
      const d = ropePath(pts)
      const derived = new Map<string, string>()
      for (let i = 0; i < pathsRef.current.length; i++) {
        const el = pathsRef.current[i]
        const geometry = layers[i]?.geometry ?? 'center'
        if (!el) continue
        if (geometry === 'center') {
          el.setAttribute('d', d)
          continue
        }
        let derivedPath = derived.get(geometry)
        if (derivedPath === undefined) {
          derivedPath = geometryPath(geometry, pts, ropeThickness)
          derived.set(geometry, derivedPath)
        }
        el.setAttribute('d', derivedPath)
      }
    }

    const source = latest.current.nodes.find((n) => n.id === from)
    if (source) sim.add(PREVIEW_ID, rectCenter(source.frame), rectCenter(source.frame))

    // Realce do alvo, também fora do React — trocar classe é mais barato que
    // re-renderizar o nó (que pode ser um terminal ou um portal inteiro).
    let marked: Element | null = null
    const mark = (el: Element | null): void => {
      if (el === marked) return
      marked?.classList.remove('is-connect-target')
      el?.classList.add('is-connect-target')
      marked = el
    }

    const onMove = (e: MouseEvent): void => {
      const { nodes, connections, hitTest } = latest.current
      const src = nodes.find((n) => n.id === from)
      if (!src) return

      const rect = hostRef.current?.getBoundingClientRect()
      const cursor = viewport.toCanvas({
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0)
      })

      const target = hitTest(cursor)
      const state = !target || target.id === from
        ? 'open'
        : canLink(src, target, connections)
          ? 'valid'
          : 'invalid'

      // O cabo nasce na BORDA do nó, no lado que olha para o cursor — do
      // centro ele cruzaria o conteúdo do card. Em cima de um alvo válido a
      // outra ponta gruda na borda dele: é onde o cabo de verdade vai encostar.
      const anchorB = state === 'valid' && target
        ? rectEdgePoint(target.frame, rectCenter(src.frame))
        : cursor
      sim.updateAnchors(PREVIEW_ID, rectEdgePoint(src.frame, anchorB), anchorB)

      for (let i = 0; i < pathsRef.current.length; i++) {
        const layer = layers[i]
        pathsRef.current[i]?.setAttribute(
          'class',
          `rope rope-shape-${ropeStyle}${layer?.name ? ` rope-layer-${layer.name}` : ''} rope-preview`
        )
        pathsRef.current[i]?.setAttribute('data-target', state)
      }
      mark(
        state === 'valid' && target
          ? document.querySelector(`[data-node-id="${target.id}"]`)
          : null
      )
    }

    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      mark(null)
      sim.clear()
    }
  }, [from, hostRef, ropeStyle, ropeThickness])

  return (
    <svg
      ref={svgRef}
      className="connections-layer connection-preview"
      overflow="visible"
      style={{ '--rope-scale': ropeThickness } as React.CSSProperties}
    >
      {layers.map((layer, i) => (
        <path
          key={layer.name || 'single'}
          ref={(el) => {
            if (el) pathsRef.current[i] = el
            else delete pathsRef.current[i]
          }}
          className={`rope rope-shape-${ropeStyle}${layer.name ? ` rope-layer-${layer.name}` : ''} rope-preview`}
          fill="none"
        />
      ))}
    </svg>
  )
}
