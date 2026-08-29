/**
 * Porte de Sources/Canvas/Physics/RopeSimulation.swift.
 *
 * Verlet + restrição de distância + gravidade, 21 pontos de controle, com
 * auto-sleep. Os parâmetros são os mesmos do app nativo — é o que faz a corda
 * "cair" com o mesmo peso.
 */
import type { Point, UUID } from '@shared/types'

const POINT_COUNT = 21
const GRAVITY = 0.8
const DAMPING = 0.98
const CONSTRAINT_ITERATIONS = 5
const SLEEP_THRESHOLD = 0.1
const WAKE_THRESHOLD = 0.5
const BEND_RATIO = (1.08 + 1.15) / 2
const MIN_ROPE_LENGTH = 20

interface Rope {
  id: UUID
  points: Point[]
  prev: Point[]
  anchorA: Point
  anchorB: Point
  segmentLength: number
}

function lerpLine(a: Point, b: Point, count: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1)
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  })
}

function segmentLengthFor(a: Point, b: Point): number {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  return Math.max(dist * BEND_RATIO, MIN_ROPE_LENGTH) / (POINT_COUNT - 1)
}

export class RopeSimulation {
  private ropes = new Map<UUID, Rope>()
  private frame: number | null = null
  private sleeping = true

  /** Chamado a cada tick com as posições novas. */
  onTick: ((points: Map<UUID, Point[]>) => void) | null = null

  add(id: UUID, anchorA: Point, anchorB: Point, existing?: Point[]): void {
    const points = existing?.length === POINT_COUNT ? existing.map((p) => ({ ...p })) : lerpLine(anchorA, anchorB, POINT_COUNT)
    this.ropes.set(id, {
      id,
      points,
      prev: points.map((p) => ({ ...p })),
      anchorA,
      anchorB,
      segmentLength: segmentLengthFor(anchorA, anchorB)
    })
    // Restaurar de pontos salvos não acorda: assume-se estado estável
    if (!existing) this.wake()
  }

  remove(id: UUID): void {
    this.ropes.delete(id)
    if (this.ropes.size === 0) this.sleep()
  }

  has(id: UUID): boolean {
    return this.ropes.has(id)
  }

  /** Os ids que a simulação carrega — para varrer o que sobrou sem dono. */
  ids(): UUID[] {
    return [...this.ropes.keys()]
  }

  clear(): void {
    this.ropes.clear()
    this.sleep()
  }

  pointsFor(id: UUID): Point[] | undefined {
    return this.ropes.get(id)?.points
  }

  updateAnchors(id: UUID, anchorA: Point, anchorB: Point): void {
    const rope = this.ropes.get(id)
    if (!rope) return
    const moved =
      Math.hypot(rope.anchorA.x - anchorA.x, rope.anchorA.y - anchorA.y) +
      Math.hypot(rope.anchorB.x - anchorB.x, rope.anchorB.y - anchorB.y)
    rope.anchorA = anchorA
    rope.anchorB = anchorB
    rope.segmentLength = segmentLengthFor(anchorA, anchorB)
    if (moved > WAKE_THRESHOLD) this.wake()
  }

  private wake(): void {
    this.sleeping = false
    if (this.frame === null) this.frame = requestAnimationFrame(this.step)
  }

  private sleep(): void {
    this.sleeping = true
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
  }

  private step = (): void => {
    let movement = 0

    for (const rope of this.ropes.values()) {
      const { points, prev } = rope

      // Verlet: posição nova = posição + velocidade amortecida + gravidade
      for (let i = 0; i < points.length; i++) {
        const p = points[i]
        const q = prev[i]
        const vx = (p.x - q.x) * DAMPING
        const vy = (p.y - q.y) * DAMPING
        prev[i] = { x: p.x, y: p.y }
        points[i] = { x: p.x + vx, y: p.y + vy + GRAVITY }
      }

      // Âncoras são fixas
      points[0] = { ...rope.anchorA }
      points[points.length - 1] = { ...rope.anchorB }

      // Restrição de distância — mais iterações = corda mais rígida
      for (let iter = 0; iter < CONSTRAINT_ITERATIONS; iter++) {
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i]
          const b = points[i + 1]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.hypot(dx, dy) || 0.0001
          const diff = (dist - rope.segmentLength) / dist / 2
          const ox = dx * diff
          const oy = dy * diff
          if (i !== 0) {
            a.x += ox
            a.y += oy
          }
          if (i + 1 !== points.length - 1) {
            b.x -= ox
            b.y -= oy
          }
        }
        points[0] = { ...rope.anchorA }
        points[points.length - 1] = { ...rope.anchorB }
      }

      for (let i = 0; i < points.length; i++) {
        movement += Math.abs(points[i].x - prev[i].x) + Math.abs(points[i].y - prev[i].y)
      }
    }

    const snapshot = new Map<UUID, Point[]>()
    for (const rope of this.ropes.values()) snapshot.set(rope.id, rope.points)
    this.onTick?.(snapshot)

    // Auto-sleep: para de queimar CPU quando tudo está parado
    if (movement < SLEEP_THRESHOLD) {
      this.sleep()
      return
    }
    this.frame = requestAnimationFrame(this.step)
  }
}

/** Converte a lista de pontos num path SVG suavizado. */
export function ropePath(points: Point[]): string {
  if (points.length < 2) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const mid = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2
    }
    d += ` Q ${points[i].x} ${points[i].y} ${mid.x} ${mid.y}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x} ${last.y}`
  return d
}
