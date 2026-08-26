/**
 * Estado de pan/zoom, deliberadamente FORA do React.
 *
 * Equivale ao par canvasOrigin/zoom do CanvasViewportView. Escrevemos direto no
 * `transform` de um único contêiner: pan e zoom viram uma composição de GPU,
 * sem recalcular a posição de nó nenhum.
 *
 * Os assinantes são notificados no máximo uma vez por frame (o "throttle de root
 * view a 60 fps" do app nativo).
 */
import type { Point, Rect } from '@shared/types'

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 3.0

/**
 * As paradas dos botões − e +.
 *
 * A escada é APERTADA perto de 100% e larga nos extremos, porque é assim que o
 * olho percebe zoom: a diferença entre 90% e 100% é a mesma, para quem olha,
 * que entre 200% e 250%. O passo aditivo que existia antes (0,25 fixo) errava
 * nas duas pontas — de 100% para 75% era um salto grande demais para ajustar
 * enquadramento, e lá embaixo o mesmo 0,25 pulava de 35% direto para o piso.
 *
 * Os números são redondos de propósito: quem lê "67%" reconhece o valor de
 * qualquer navegador, e voltar a um zoom conhecido vale mais do que uma
 * progressão geométrica exata.
 */
const ZOOM_STOPS = [
  0.1, 0.15, 0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
  2.5, 3
]

/** Folga na comparação: o zoom da roda cai em valores como 0.9999999. */
const EPSILON = 0.001
export const CULL_MARGIN = 200

export interface ViewportState {
  origin: Point // ponto do canvas que fica no canto superior esquerdo da view
  zoom: number
  width: number
  height: number
}

type Listener = (v: ViewportState) => void

class Viewport {
  origin: Point = { x: 9800, y: 8500 }
  zoom = 1
  width = 0
  height = 0

  private listeners = new Set<Listener>()
  private frame: number | null = null

  get state(): ViewportState {
    return { origin: { ...this.origin }, zoom: this.zoom, width: this.width, height: this.height }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  /** Coalesce várias mudanças no mesmo frame numa notificação só. */
  private schedule(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      const s = this.state
      for (const l of this.listeners) l(s)
    })
  }

  setSize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.schedule()
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.origin = { x: this.origin.x - dxScreen / this.zoom, y: this.origin.y - dyScreen / this.zoom }
    this.schedule()
  }

  setOrigin(origin: Point): void {
    this.origin = origin
    this.schedule()
  }

  /** Zoom ancorado no cursor: o ponto sob o mouse não se move. */
  zoomAt(screenPoint: Point, factor: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor))
    if (next === this.zoom) return
    const before = this.toCanvas(screenPoint)
    this.zoom = next
    const after = this.toCanvas(screenPoint)
    this.origin = { x: this.origin.x + (before.x - after.x), y: this.origin.y + (before.y - after.y) }
    this.schedule()
  }

  setZoom(zoom: number): void {
    const center = { x: this.width / 2, y: this.height / 2 }
    this.zoomAt(center, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) / this.zoom)
  }

  /**
   * Um degrau para cima (+1) ou para baixo (-1) na escada de zoom.
   *
   * Anda até a PRÓXIMA parada acima ou abaixo do valor atual, e não até o
   * vizinho de um índice: o zoom da roda é contínuo, então quase sempre o
   * valor está entre duas paradas, e um índice fixo daria um salto para trás
   * antes de andar para frente.
   */
  zoomStep(direction: 1 | -1): void {
    const atual = this.zoom
    const alvo =
      direction > 0
        ? ZOOM_STOPS.find((z) => z > atual + EPSILON)
        : [...ZOOM_STOPS].reverse().find((z) => z < atual - EPSILON)
    if (alvo !== undefined) this.setZoom(alvo)
  }

  /**
   * Enquadra um retângulo do canvas na tela: ajusta pan e zoom para ele caber
   * inteiro, com uma folga em volta.
   *
   * Uma escala só para os dois eixos — escalas separadas distorceriam o
   * conteúdo. O zoom é preso em [MIN_ZOOM, MAX_ZOOM]: um workspace com dois
   * nós colados pediria um zoom de 40x, e enquadrar não é desculpa para passar
   * do teto que o resto do app respeita.
   */
  fit(rect: Rect, padding = 60): void {
    if (this.width === 0 || this.height === 0) return
    if (rect.width <= 0 || rect.height <= 0) return

    const scale = Math.min(
      (this.width - padding * 2) / rect.width,
      (this.height - padding * 2) / rect.height
    )
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))

    // Centraliza: o que sobra do eixo que não mandou na escala vira margem
    // dos dois lados, e não tudo de um lado só.
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    this.origin = {
      x: cx - this.width / this.zoom / 2,
      y: cy - this.height / this.zoom / 2
    }
    this.schedule()
  }

  reset(origin: Point, zoom: number): void {
    this.origin = { ...origin }
    this.zoom = zoom
    this.schedule()
  }

  // ─── Conversões ─────────────────────────────────────────────────────────────

  toCanvas(screen: Point): Point {
    return { x: this.origin.x + screen.x / this.zoom, y: this.origin.y + screen.y / this.zoom }
  }

  toScreen(canvas: Point): Point {
    return { x: (canvas.x - this.origin.x) * this.zoom, y: (canvas.y - this.origin.y) * this.zoom }
  }

  /** Retângulo do canvas visível, já com a margem de culling. */
  visibleRect(margin = CULL_MARGIN): Rect {
    return {
      x: this.origin.x - margin,
      y: this.origin.y - margin,
      width: this.width / this.zoom + margin * 2,
      height: this.height / this.zoom + margin * 2
    }
  }

  /** String de transform do contêiner de nós. */
  transform(): string {
    return `translate(${-this.origin.x * this.zoom}px, ${-this.origin.y * this.zoom}px) scale(${this.zoom})`
  }
}

export const viewport = new Viewport()

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  )
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/**
 * Ponto da BORDA do retângulo na direção de `toward` — onde o raio que sai do
 * centro cruza o contorno. É daí que um cabo deve sair: ancorar no centro faz
 * a corda atravessar o conteúdo do nó.
 */
export function rectEdgePoint(r: Rect, toward: Point): Point {
  const c = rectCenter(r)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (dx === 0 && dy === 0) return c
  // t = o quanto dá para andar na direção do alvo antes de cruzar a borda;
  // manda o eixo que estoura primeiro. Na diagonal, os dois empatam no canto.
  const t = Math.min(
    dx === 0 ? Infinity : r.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : r.height / 2 / Math.abs(dy)
  )
  return { x: c.x + dx * t, y: c.y + dy * t }
}

/**
 * Retângulo que contém todos os nós. null quando não há nenhum — quem chama
 * decide o que fazer com um workspace vazio (enquadrar o nada não faz sentido).
 */
export function nodesBounds(nodes: { frame: Rect }[]): Rect | null {
  if (nodes.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { frame } of nodes) {
    minX = Math.min(minX, frame.x)
    minY = Math.min(minY, frame.y)
    maxX = Math.max(maxX, frame.x + frame.width)
    maxY = Math.max(maxY, frame.y + frame.height)
  }
  // Piso de 1: um único nó de área zero daria width 0, e quem enquadra
  // dividiria por ele.
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}
