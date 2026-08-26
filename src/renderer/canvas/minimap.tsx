/**
 * Minimapa: o workspace inteiro num retângulo, com a área visível marcada.
 *
 * Existe porque o canvas é grande e não tem bordas — depois de arrastar um nó
 * para longe, a única forma de reencontrá-lo era lembrar para que lado se foi.
 * Aqui o conjunto todo cabe de uma vez, e clicar leva o quadro até lá.
 *
 * Desenha em <canvas> e NÃO em divs: um workspace com dezenas de nós viraria
 * dezenas de elementos redesenhados a cada frame de pan. No canvas é um
 * `fillRect` por nó, sem tocar no DOM.
 *
 * Pelo mesmo motivo, não assina a store para o pan: o viewport notifica no
 * máximo uma vez por frame (ver canvas/viewport.ts) e nós redesenhamos ali,
 * fora do React — um setState por frame de arrasto re-renderizaria a árvore
 * inteira junto.
 */
import { useEffect, useRef } from 'react'
import type { CanvasNode, Rect } from '@shared/types'
import { useStore } from '../state/store'
import { viewport } from './viewport'

/** Tamanho do painel, em pixels de tela. */
const WIDTH = 208
const HEIGHT = 132
/** Respiro entre o conteúdo e a borda, para nada encostar no canto. */
const PADDING = 10

/**
 * Cor por tipo de nó — a mesma leitura que a pessoa tem no canvas, reduzida a
 * um bloco. Nota amarela, terminal azul, e assim por diante.
 */
const COLORS: Record<string, string> = {
  terminal: '#3b6fd4',
  stickyNote: '#e8dd6a',
  text: '#7a8290',
  portal: '#4a9a86',
  fileTree: '#8a6ac4'
}

/**
 * Retângulo que contém todos os nós, mais a área visível.
 *
 * A área visível entra no cálculo de propósito: sem ela, um quadro que se
 * afastou de tudo sairia do mapa, e o indicador ficaria preso na borda sem
 * dizer o quanto se está longe.
 */
function contentBounds(nodes: CanvasNode[], view: Rect): Rect {
  let minX = view.x
  let minY = view.y
  let maxX = view.x + view.width
  let maxY = view.y + view.height

  for (const node of nodes) {
    minX = Math.min(minX, node.frame.x)
    minY = Math.min(minY, node.frame.y)
    maxX = Math.max(maxX, node.frame.x + node.frame.width)
    maxY = Math.max(maxY, node.frame.y + node.frame.height)
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

export function Minimap(): JSX.Element | null {
  const { workspace, selection, candidates } = useStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)

  // Os nós mudam por evento (store), o pan muda por frame (viewport). Um ref
  // deixa o loop de desenho ler os dois sem reassinar o viewport a cada
  // mudança de nó.
  const nodesRef = useRef<CanvasNode[]>([])
  nodesRef.current = workspace?.nodes ?? []
  const selectionRef = useRef<string[]>([])
  selectionRef.current = selection

  // A escala de cada frame, guardada para o clique converter tela → canvas.
  // Recalcular no handler daria um valor diferente do que está desenhado
  // quando o conteúdo mudou entre o último frame e o clique.
  const projection = useRef({ scale: 1, offsetX: 0, offsetY: 0, bounds: { x: 0, y: 0, width: 1, height: 1 } })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Tela de densidade alta: sem isto o mapa fica borrado num display Retina.
    const dpr = window.devicePixelRatio || 1
    canvas.width = WIDTH * dpr
    canvas.height = HEIGHT * dpr
    ctx.scale(dpr, dpr)

    const draw = (): void => {
      const nodes = nodesRef.current
      const view = viewport.visibleRect(0)
      const bounds = contentBounds(nodes, view)

      // Uma escala só para os dois eixos: escalas diferentes distorceriam as
      // proporções, e um nó largo apareceria quadrado.
      const scale = Math.min(
        (WIDTH - PADDING * 2) / bounds.width,
        (HEIGHT - PADDING * 2) / bounds.height
      )
      // Centraliza o conteúdo na sobra do eixo que não mandou na escala.
      const offsetX = (WIDTH - bounds.width * scale) / 2
      const offsetY = (HEIGHT - bounds.height * scale) / 2
      projection.current = { scale, offsetX, offsetY, bounds }

      const toMap = (x: number, y: number): [number, number] => [
        (x - bounds.x) * scale + offsetX,
        (y - bounds.y) * scale + offsetY
      ]

      ctx.clearRect(0, 0, WIDTH, HEIGHT)

      // Nós: um retângulo por nó, com piso de 2px. Sem o piso, um nó pequeno
      // num workspace espalhado desaparece — e um nó invisível no mapa é
      // exatamente o que se está tentando achar.
      const selected = new Set(selectionRef.current)
      for (const node of nodes) {
        const [x, y] = toMap(node.frame.x, node.frame.y)
        const w = Math.max(2, node.frame.width * scale)
        const h = Math.max(2, node.frame.height * scale)
        ctx.fillStyle = COLORS[node.content.type] ?? '#7a8290'
        ctx.globalAlpha = selected.has(node.id) ? 1 : 0.75
        ctx.fillRect(x, y, w, h)

        if (selected.has(node.id)) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1
          ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1)
        }
      }
      ctx.globalAlpha = 1

      // Área visível por último, por cima de tudo: é o que se procura ao olhar.
      const [vx, vy] = toMap(view.x, view.y)
      const vw = view.width * scale
      const vh = view.height * scale
      ctx.strokeStyle = 'rgba(255,255,255,.9)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(vx, vy, vw, vh)
      ctx.fillStyle = 'rgba(255,255,255,.08)'
      ctx.fillRect(vx, vy, vw, vh)
    }

    // Redesenha a cada notificação do viewport (no máximo uma por frame) e
    // uma vez agora, para o mapa já nascer preenchido.
    draw()
    return viewport.subscribe(draw)
    // `workspace?.nodes` entra nas deps para o mapa redesenhar quando um nó
    // nasce ou morre — o viewport não é notificado disso.
  }, [workspace?.nodes, selection])

  // O aviso de projetos ocupa este mesmo canto (.candidates-card). Os dois
  // juntos se sobrepõem, e o aviso é passageiro — some assim que a pessoa
  // responde —, então quem cede é o mapa.
  if (!workspace || candidates.length > 0) return null

  /** Centraliza o quadro no ponto do canvas que corresponde ao clique. */
  const goTo = (e: { clientX: number; clientY: number }): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { scale, offsetX, offsetY, bounds } = projection.current

    const canvasX = (e.clientX - rect.left - offsetX) / scale + bounds.x
    const canvasY = (e.clientY - rect.top - offsetY) / scale + bounds.y

    // O clique marca o CENTRO da área visível, não o canto: mirar um nó e
    // recebê-lo no canto superior esquerdo é o oposto do que se pediu.
    viewport.setOrigin({
      x: canvasX - viewport.width / viewport.zoom / 2,
      y: canvasY - viewport.height / viewport.zoom / 2
    })
  }

  return (
    <div
      className="minimap"
      title="Clique ou arraste para mover o quadro"
      // stopPropagation: sem isto o mousedown desce para o canvas e abre um
      // marquee de seleção por baixo do mapa.
      onMouseDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        dragging.current = true
        goTo(e)
      }}
      onMouseMove={(e) => {
        if (dragging.current) goTo(e)
      }}
      onMouseUp={() => {
        dragging.current = false
      }}
      // O ponteiro sai do mapa no meio do arrasto com frequência; sem isto o
      // arrasto continuaria "ligado" e o próximo hover moveria o quadro.
      onMouseLeave={() => {
        dragging.current = false
      }}
    >
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT }} />
    </div>
  )
}
