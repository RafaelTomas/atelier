/**
 * Camada 1: grade de fundo.
 *
 * Desenhada num <canvas> que NÃO é transformado — redesenhamos as linhas na
 * escala certa a cada frame de pan/zoom. Escalar o canvas via CSS borraria a
 * grade, o mesmo problema que o xterm tem (ver §4.2 do plano de migração).
 */
import { useEffect, useRef } from 'react'
import { viewport } from './viewport'

const GRID_SPACING = 16

export function CanvasBackground({ mode }: { mode: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const { width, height, zoom, origin } = viewport.state
      if (width === 0 || height === 0) return

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const styles = getComputedStyle(document.documentElement)
      ctx.fillStyle = styles.getPropertyValue('--canvas-bg').trim() || '#ffffff'
      ctx.fillRect(0, 0, width, height)
      if (mode === 'plain') return

      const step = GRID_SPACING * zoom
      // Abaixo de 6px a grade vira ruído cinza — some com ela
      if (step < 6) return

      const offsetX = -((origin.x * zoom) % step)
      const offsetY = -((origin.y * zoom) % step)

      ctx.strokeStyle = styles.getPropertyValue('--canvas-grid').trim() || '#e6e6e6'
      ctx.fillStyle = ctx.strokeStyle
      ctx.lineWidth = 0.5

      if (mode === 'dots') {
        const r = Math.min(1.4, 0.7 * zoom)
        for (let x = offsetX; x < width; x += step) {
          for (let y = offsetY; y < height; y += step) {
            ctx.beginPath()
            ctx.arc(x, y, r, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        return
      }

      ctx.beginPath()
      for (let x = offsetX; x < width; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, height)
      }
      for (let y = offsetY; y < height; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5)
        ctx.lineTo(width, Math.round(y) + 0.5)
      }
      ctx.stroke()
    }

    return viewport.subscribe(draw)
  }, [mode])

  return <canvas ref={ref} className="canvas-background" />
}
