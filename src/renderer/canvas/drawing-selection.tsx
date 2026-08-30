/**
 * Moldura de seleção do traço — mesmo tratamento da moldura de grupo (retrato
 * tracejado + 8 alças), mas para um Drawing. Só existe UM por vez (a seleção é
 * exclusiva), então não precisa da camada de culling do groups-layer — só a
 * assinatura do viewport para acompanhar pan/zoom.
 *
 * O traço em si (a tinta) continua sendo pintado pelo <canvas> de
 * drawings-layer.tsx; esta camada é só o CONTORNO clicável (as alças) — mover
 * e redimensionar de verdade é o canvas-view que decide, via hitDrawing() para
 * o corpo e as alças daqui para o resize.
 */
import { useEffect, useRef } from 'react'
import type { Drawing } from '@shared/types'
import { strokeBounds, viewport } from './viewport'

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

interface Props {
  drawing: Drawing | null
}

export function DrawingSelection({ drawing }: Props): JSX.Element | null {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return viewport.subscribe(() => {
      const layer = layerRef.current
      if (layer) layer.style.transform = viewport.transform()
    })
  }, [])

  if (!drawing) return null
  const bounds = strokeBounds(drawing.points)
  if (!bounds) return null

  return (
    <div ref={layerRef} className="drawing-selection-layer">
      <div
        className="drawing-selection"
        data-drawing-id={drawing.id}
        style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
      >
        {EDGES.map((edge) => (
          <div key={edge} data-drawing-handle={edge} />
        ))}
      </div>
    </div>
  )
}
