/**
 * Primitivas de (de)serialização compatíveis com o Codable do Swift.
 *
 * Três detalhes decidem a compatibilidade com o app nativo e com o Maestri.
 * Errar qualquer um deles gera arquivos que o app Swift recusa a ler:
 *
 *   1. UUID  → string MAIÚSCULA          ("09A997B8-…", não "09a997b8-…")
 *   2. Date  → ISO8601 SEM milissegundos ("2026-08-23T17:12:00Z")
 *   3. CGPoint → [x, y]   e   CGRect → [[x, y], [w, h]]
 *
 * Verificado contra a saída real de JSONEncoder(dateEncodingStrategy: .iso8601).
 */
import { randomUUID } from 'node:crypto'
import type { Point, Rect, UUID } from '@shared/types'

/** UUID v4 em maiúsculas, igual ao UUID.uuidString do Swift. */
export function uuid(): UUID {
  return randomUUID().toUpperCase()
}

export function normalizeUUID(value: unknown, fallback: () => UUID = uuid): UUID {
  return typeof value === 'string' && value.length > 0 ? value.toUpperCase() : fallback()
}

/**
 * ISO8601 sem fração de segundo. O JSONDecoder do Swift com .iso8601 aceita as
 * duas formas, mas emitimos a curta para bater byte a byte com o app nativo.
 */
export function toISO8601(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function nowISO(): string {
  return toISO8601()
}

export function decodeDate(value: unknown, fallback: () => string = nowISO): string {
  if (typeof value !== 'string') return fallback()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback() : toISO8601(new Date(parsed))
}

export function decodeOptionalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : toISO8601(new Date(parsed))
}

// ─── Geometria ────────────────────────────────────────────────────────────────

/** CGRect do Swift ⇄ [[x, y], [w, h]] */
export function encodeRect(r: Rect): number[][] {
  return [
    [r.x, r.y],
    [r.width, r.height]
  ]
}

export function decodeRect(value: unknown): Rect | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [origin, size] = value
  if (!Array.isArray(origin) || !Array.isArray(size)) return null
  if (origin.length !== 2 || size.length !== 2) return null
  const [x, y] = origin
  const [width, height] = size
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x, y, width, height }
}

/** CGPoint do Swift ⇄ [x, y] */
export function encodePoint(p: Point): number[] {
  return [p.x, p.y]
}

export function decodePoint(value: unknown, fallback: Point = { x: 0, y: 0 }): Point {
  if (Array.isArray(value) && value.length === 2) {
    const [x, y] = value
    if (typeof x === 'number' && typeof y === 'number') return { x, y }
  }
  // tolerância: alguns arquivos antigos usam objeto
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y }
  }
  return fallback
}

// ─── Acesso defensivo ─────────────────────────────────────────────────────────

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function optStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function optNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
