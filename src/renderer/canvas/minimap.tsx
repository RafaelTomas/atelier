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
 *
 * Fica escondido enquanto o canvas está parado: só aparece durante o pan/zoom
 * e some sozinho pouco depois. A visibilidade é escrita direto no `style` do
 * elemento, pela mesma razão — um useState por frame de arrasto colocaria de
 * volta exatamente o re-render que o resto do arquivo evita.
 */
import { useEffect, useRef } from 'react'
import type { CanvasNode, NodeGroup, Rect } from '@shared/types'
import { useStore } from '../state/store'
import { viewport } from './viewport'

/** Tamanho do painel, em pixels de tela. */
const WIDTH = 208
const HEIGHT = 132
/** Respiro entre o conteúdo e a borda, para nada encostar no canto. */
const PADDING = 10

/**
 * Quanto o mapa fica na tela depois que o canvas para de se mexer.
 *
 * Longo o bastante para sobreviver à pausa entre dois arrastos do mesmo
 * gesto — some no meio de uma navegação seria pior que não aparecer.
 */
const LINGER_MS = 1500

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
function contentBounds(nodes: CanvasNode[], groups: NodeGroup[], view: Rect): Rect {
  let minX = view.x
  let minY = view.y
  let maxX = view.x + view.width
  let maxY = view.y + view.height

  // As molduras entram na conta junto com os nós: um grupo é sempre maior que
  // os membros dele, e deixá-lo de fora cortaria a borda no mapa.
  for (const { frame } of [...nodes, ...groups]) {
    minX = Math.min(minX, frame.x)
    minY = Math.min(minY, frame.y)
    maxX = Math.max(maxX, frame.x + frame.width)
    maxY = Math.max(maxY, frame.y + frame.height)
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

export function Minimap(): JSX.Element | null {
  const { workspace, selection, candidates } = useStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const hovering = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * O desenho inicial não revela o mapa — no boot ele nasce escondido. Mora
   * num ref, e não numa variável do efeito: o efeito re-roda a cada mudança de
   * nó ou de seleção, e uma variável local voltaria a `true` ali, engolindo a
   * revelação do pan seguinte. Arrastar um nó muda `nodes` — seria justamente
   * o gesto em que o mapa deixaria de aparecer.
   */
  const revealArmed = useRef(false)

  // Os nós mudam por evento (store), o pan muda por frame (viewport). Um ref
  // deixa o loop de desenho ler os dois sem reassinar o viewport a cada
  // mudança de nó.
  const nodesRef = useRef<CanvasNode[]>([])
  nodesRef.current = workspace?.nodes ?? []
  const groupsRef = useRef<NodeGroup[]>([])
  groupsRef.current = workspace?.groups ?? []
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

    /**
     * Mostra o mapa e arma o desligamento. Escreve no style direto: um
     * useState aqui rodaria a cada frame de pan.
     */
    const reveal = (): void => {
      const host = hostRef.current
      if (host) host.classList.add('is-visible')
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => {
        // Não some debaixo do ponteiro: quem está com o mouse em cima está
        // usando o mapa, e quem está arrastando, mais ainda.
        if (dragging.current || hovering.current) {
          reveal()
          return
        }
        hostRef.current?.classList.remove('is-visible')
      }, LINGER_MS)
    }

    const draw = (): void => {
      const nodes = nodesRef.current
      const groups = groupsRef.current
      const view = viewport.visibleRect(0)
      const bounds = contentBounds(nodes, groups, view)

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

      // Molduras primeiro, POR BAIXO dos nós — a mesma ordem do canvas. Em 25%
      // de zoom, quando o corpo dos nós já não se lê, é este bloco de cor que
      // transforma o mapa no índice do canvas.
      for (const group of groups) {
        const [x, y] = toMap(group.frame.x, group.frame.y)
        const w = Math.max(3, group.frame.width * scale)
        const h = Math.max(3, group.frame.height * scale)
        ctx.globalAlpha = 0.16
        ctx.fillStyle = group.color
        ctx.fillRect(x, y, w, h)
        ctx.globalAlpha = 0.55
        ctx.strokeStyle = group.color
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      }
      ctx.globalAlpha = 1

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
      //
      // Só depois que o ResizeObserver mediu o host. No primeiro frame o
      // viewport ainda é 0×0, e o retângulo sairia com 0 de lado — invisível.
      // Era isso que fazia o mapa parecer vazio até o primeiro pan.
      if (view.width > 0 && view.height > 0) {
        const [vx, vy] = toMap(view.x, view.y)
        const vw = view.width * scale
        const vh = view.height * scale
        ctx.strokeStyle = 'rgba(255,255,255,.9)'
        ctx.lineWidth = 1.5
        ctx.strokeRect(vx, vy, vw, vh)
        ctx.fillStyle = 'rgba(255,255,255,.08)'
        ctx.fillRect(vx, vy, vw, vh)
      }
    }

    // O primeiro desenho não revela: no boot o mapa deve nascer escondido.
    // Só as notificações SEGUINTES são pan/zoom de verdade.
    const onViewportChange = (): void => {
      draw()
      // A primeira notificação da sessão é o desenho inicial do subscribe, não
      // um gesto: o mapa fica escondido. Da segunda em diante, é pan ou zoom.
      if (!revealArmed.current) {
        revealArmed.current = true
        return
      }
      reveal()
    }

    // subscribe() desenha na hora e a cada notificação seguinte.
    //
    // Só que "a cada notificação" não cobre o boot: o canvas-view monta antes
    // do workspace chegar, então o ResizeObserver dele já mediu o host quando
    // o minimapa aparece. Sem uma MUDANÇA de tamanho depois disso, setSize()
    // não é chamado de novo e nenhuma notificação vem — o mapa ficava sem o
    // retângulo da área visível até o primeiro pan. Por isso o desenho inicial
    // lê `viewport.width/height` como estão, em vez de esperar um evento.
    //
    // (Um requestAnimationFrame extra não resolveria: pela spec o rAF roda
    // antes do ResizeObserver no mesmo frame, e veria o viewport ainda 0×0.)
    const unsubscribe = viewport.subscribe(onViewportChange)
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      unsubscribe()
    }
    // `workspace?.nodes` entra nas deps para o mapa redesenhar quando um nó
    // nasce ou morre — o viewport não é notificado disso.
  }, [workspace?.nodes, workspace?.groups, selection])

  if (!workspace) return null

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
      ref={hostRef}
      // Com o aviso de projetos aberto, o mapa desliza para o lado em vez de
      // sumir: eles dividem o canto, e sumir de vez tirava a navegação da
      // pessoa por causa de um aviso que ela ainda nem leu.
      className={candidates.length > 0 ? 'floating minimap is-raised' : 'floating minimap'}
      title="Clique ou arraste para mover o quadro"
      // Enquanto o ponteiro estiver em cima, o mapa não some — e chegar perto
      // dele já o traz de volta, que é como se pega um mapa que acabou de
      // sumir sem precisar mexer no canvas antes.
      onMouseEnter={() => {
        hovering.current = true
        hostRef.current?.classList.add('is-visible')
      }}
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
        hovering.current = false
      }}
    >
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT }} />
    </div>
  )
}
