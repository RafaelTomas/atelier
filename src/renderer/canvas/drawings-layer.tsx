/**
 * Camada 2: desenhos à mão livre.
 *
 * Fica entre a grade e os nós — desenhar por cima esconderia terminal e portal,
 * e é a mesma ordem de empilhamento anotada em canvas-view.
 *
 * DESENHA EM <canvas> NÃO TRANSFORMADO, como a grade: os pontos vivem em
 * coordenadas de canvas e são projetados para a tela a cada frame. Escalar o
 * canvas por CSS borraria o traço (mesmo problema do xterm e da grade).
 *
 * O traço em andamento chega por ref e é redesenhado a 60fps sem passar pelo
 * React; só o traço CONCLUÍDO entra pelo estado, já persistido.
 */
import { useEffect, useRef } from 'react'
import type { Drawing, Point, UUID } from '@shared/types'
import { viewport } from './viewport'

export interface LiveStroke {
  points: Point[]
  color: string
  lineWidth: number
  /** Marca-texto: traço grosso e translúcido. */
  translucent: boolean
}

/**
 * Mover/redimensionar um traço já existente, ao vivo — sem tocar no array
 * `drawings` até o soltar do mouse (mesmo tratamento do `live` acima).
 * `scale` a partir de `(anchorX, anchorY)`, `dx`/`dy` depois: mover é escala 1
 * com translação, redimensionar é escala sem translação — as duas cabem na
 * mesma fórmula.
 */
export interface LiveDrawingTransform {
  id: UUID
  anchorX: number
  anchorY: number
  scaleX: number
  scaleY: number
  dx: number
  dy: number
}

interface Props {
  drawings: Drawing[]
  /** Traço sendo desenhado agora; null quando não há arrasto. */
  live: React.MutableRefObject<LiveStroke | null>
  /** Incrementado a cada ponto novo, para redesenhar fora do ciclo do React. */
  tick: React.MutableRefObject<number>
  /** Traço selecionado em movimento/resize; null fora do gesto. */
  liveTransform: React.MutableRefObject<LiveDrawingTransform | null>
}

/** Mesma opacidade que FreehandContent usa para o marca-texto. */
const HIGHLIGHTER_ALPHA = 0.4

export function DrawingsLayer({ drawings, live, tick, liveTransform }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let lastTick = -1

    const project = (px: number, py: number, zoom: number, origin: Point): [number, number] => [
      (px - origin.x) * zoom,
      (py - origin.y) * zoom
    ]

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const { width, height, zoom, origin } = viewport.state
      if (width === 0 || height === 0) return

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      for (const d of drawings) {
        if (d.points.length < 2) continue
        // lineWidth negativo é a marca do marca-texto no formato em disco —
        // ver comentário em canvas-view (o Drawing do Swift não tem campo de tipo).
        const translucent = d.lineWidth < 0
        // Traço em movimento/resize: aplica a transformação ao vivo sem tocar
        // no array — o commit de verdade só acontece no soltar do mouse.
        const t = liveTransform.current?.id === d.id ? liveTransform.current : null
        const w = t ? Math.abs(d.lineWidth) * Math.min(Math.abs(t.scaleX), Math.abs(t.scaleY)) : Math.abs(d.lineWidth)
        ctx.globalAlpha = translucent ? HIGHLIGHTER_ALPHA : 1
        ctx.strokeStyle = d.color
        ctx.lineWidth = Math.max(0.5, w * zoom)
        ctx.beginPath()
        for (let i = 0; i < d.points.length; i++) {
          let [px, py] = d.points[i]
          if (t) {
            px = t.anchorX + (px - t.anchorX) * t.scaleX + t.dx
            py = t.anchorY + (py - t.anchorY) * t.scaleY + t.dy
          }
          const [x, y] = project(px, py, zoom, origin)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      const stroke = live.current
      if (stroke && stroke.points.length > 1) {
        ctx.globalAlpha = stroke.translucent ? HIGHLIGHTER_ALPHA : 1
        ctx.strokeStyle = stroke.color
        ctx.lineWidth = Math.max(0.5, stroke.lineWidth * zoom)
        ctx.beginPath()
        for (let i = 0; i < stroke.points.length; i++) {
          const [x, y] = project(stroke.points[i].x, stroke.points[i].y, zoom, origin)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    draw()
    const offViewport = viewport.subscribe(draw)

    // Só redesenha quando o traço cresceu — um rAF redesenhando sempre
    // queimaria CPU com o canvas parado.
    const loop = (): void => {
      if (tick.current !== lastTick) {
        lastTick = tick.current
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      offViewport()
    }
  }, [drawings, live, tick, liveTransform])

  return <canvas ref={canvasRef} className="drawings-layer" />
}
