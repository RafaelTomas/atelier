/**
 * Camada de canvas — porte de CanvasViewportView.
 *
 * Empilhamento (mesma ordem do app nativo):
 *   1 fundo/grade   2 desenho   3 nós   4 conexões   5 guias
 *
 * As três regras de performance de docs/migracao-electron.md §5 estão aqui:
 *   • virtualização por viewport (+200px), só o set visível vai para o React
 *   • hit testing por lista ordenada por z-index, nunca elementFromPoint
 *   • arrasto escreve em style.transform direto, fora do ciclo do React
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasNode, Point, Project, Rect, UUID } from '@shared/types'
import { isSupportedImageName } from '@shared/image'
import { ContextMenu } from '../context-menu'
import { FILE_DRAG_TYPE, PROJECT_DRAG_TYPE, readFileDrag } from '../drag'
import { portalWake } from '../state/portal-wake'
import { store, useStore } from '../state/store'
import { NodeShell } from '../nodes/node-shell'
import { FormatBar } from '../nodes/format-bar'
import { NodeActionBar } from '../nodes/node-action-bar'
import { Dock } from '../dock'
import { MonitorDock } from '../monitor-dock'
import { CanvasBackground } from './background'
import { DrawingsLayer, type LiveDrawingTransform, type LiveStroke } from './drawings-layer'
import { DrawingSelection } from './drawing-selection'
import { DrawMenu, type DrawMenuState } from './draw-menu'
import { GroupsLayer } from './groups-layer'
import { GroupMenu } from './group-menu'
import {
  GROUP_MIN_HEIGHT,
  GROUP_MIN_WIDTH,
  collapsedMembers,
  groupAt,
  groupOf
} from './group-geometry'
import { Minimap } from './minimap'
import { ConnectionsLayer } from './connections-layer'
import { ConnectionPreview, canLink } from './connection-preview'
import { CULL_MARGIN, KEEP_MARGIN, rectsIntersect, strokeBounds, viewport } from './viewport'

/**
 * Nome do projeto de um widget FIXADO, para o cabeçalho do nó. Resolvido AQUI,
 * e não dentro do widget: o canvas já assina a lista de projetos, e um widget
 * que a assinasse por conta própria poria mais um assinante da store por nó na
 * tela — a mesma razão pela qual role e tema de terminal descem por prop.
 */
function widgetProjectName(node: CanvasNode, projects: Project[]): string | null {
  if (node.content.type !== 'widget') return null
  const { projectId } = node.content.value
  if (!projectId) return null
  return projects.find((p) => p.id === projectId)?.name ?? null
}

/**
 * Um arrasto move a SELEÇÃO INTEIRA, não o nó clicado.
 *
 * `frames` guarda a geometria de cada nó no início do gesto: durante o
 * movimento só se soma o deslocamento a ela, e o commit no fim é um só, em
 * lote. Ler a posição atual a cada frame acumularia erro de arredondamento.
 *
 * `group` presente = o gesto começou na faixa do título: a moldura anda junto
 * com os membros. É o mesmo caminho, com um retângulo a mais para mover.
 */
interface DragTargets {
  ids: UUID[]
  start: Point
  frames: Map<UUID, Rect>
  group: { id: UUID; frame: Rect } | null
}

type Interaction =
  | { kind: 'idle' }
  | { kind: 'panning'; last: Point }
  | ({ kind: 'mayDrag' } & DragTargets)
  | ({ kind: 'dragging' } & DragTargets)
  | { kind: 'resizing'; id: UUID; start: Point; frame: Rect; edge: ResizeEdge }
  | { kind: 'groupResizing'; id: UUID; start: Point; frame: Rect; edge: ResizeEdge }
  | { kind: 'marquee'; start: Point; current: Point }
  | { kind: 'placing'; start: Point }
  | { kind: 'drawing' }
  | { kind: 'draggingDrawing'; id: UUID; start: Point; points: number[][] }
  | {
      kind: 'resizingDrawing'
      id: UUID
      start: Point
      frame: Rect
      points: number[][]
      lineWidth: number
      edge: ResizeEdge
    }

/**
 * De qual borda o redimensionamento partiu. As letras se combinam: 'nw' é a
 * quina superior esquerda, e o teste é por `includes`, não por igualdade.
 */
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Piso do nó ao redimensionar. Abaixo disto nem o cabeçalho cabe. */
const MIN_NODE_WIDTH = 120
const MIN_NODE_HEIGHT = 60

/** Piso do traço ao redimensionar — bem menor que o do nó: um rabisco pode
 * nascer pequeno de verdade, e o mínimo do nó o impediria de encolher. */
const DRAWING_MIN_SIZE = 8

/**
 * O frame novo a partir da borda arrastada.
 *
 * A regra que faz o gesto parecer natural: a borda OPOSTA à arrastada não se
 * move. Por isso puxar pela esquerda muda `x` e `width` juntos — e o clamp do
 * mínimo entra na largura ANTES de recalcular `x`, senão a borda direita
 * escorregaria ao encostar no piso.
 *
 * Os pisos vêm por parâmetro porque a moldura de grupo usa o mesmo gesto com
 * medidas próprias — ela precisa caber o título, não um cabeçalho de nó.
 */
function resizeFrame(
  frame: Rect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  minWidth = MIN_NODE_WIDTH,
  minHeight = MIN_NODE_HEIGHT
): Rect {
  let { x, y, width, height } = frame

  if (edge.includes('e')) width = Math.max(minWidth, frame.width + dx)
  if (edge.includes('s')) height = Math.max(minHeight, frame.height + dy)
  if (edge.includes('w')) {
    width = Math.max(minWidth, frame.width - dx)
    x = frame.x + frame.width - width
  }
  if (edge.includes('n')) {
    height = Math.max(minHeight, frame.height - dy)
    y = frame.y + frame.height - height
  }
  return { x, y, width, height }
}

/**
 * Quanto um Portal continua montado depois de sair da faixa de permanência.
 *
 * Desmontar um portal é destruir um processo do Chromium; remontá-lo é criar
 * outro e recarregar a página inteira — numa SPA autenticada, com login e estado
 * em memória junto. Cinco segundos cobrem o vai-e-volta de quem foi olhar outro
 * canto do canvas e voltou, e ainda liberam o processo de quem foi embora.
 */
const PORTAL_GRACE_MS = 5000

const DRAG_THRESHOLD = 3 // px de tela antes de virar arrasto de verdade
const CLICK_SLOP = 12 // px de tela: abaixo disso o gesto de área é só um clique

export function CanvasView(): JSX.Element {
  const {
    workspace,
    selection,
    selectedGroupId,
    selectedDrawingId,
    isolatedGroupId,
    connectingFrom,
    placing,
    tool,
    pen,
    roles,
    prefs,
    terminalStatus,
    projects,
    platform,
    monitorDockVisible
  } = useStore()
  const hostRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<HTMLDivElement>(null)
  const interaction = useRef<Interaction>({ kind: 'idle' })

  /** Centro ao vivo dos nós em arrasto — lido pela camada de cordas a 60fps. */
  const liveFrames = useRef(new Map<UUID, Point>())
  /** Traço em andamento — escrito a 60fps, fora do estado do React. */
  const liveStroke = useRef<LiveStroke | null>(null)
  /** Traço selecionado sendo movido/redimensionado — mesmo tratamento: fora
   * do estado do React, só o retrato final (no soltar) vira commit. */
  const liveDrawingTransform = useRef<LiveDrawingTransform | null>(null)
  const strokeTick = useRef(0)
  const [visibleIds, setVisibleIds] = useState<Set<UUID>>(new Set())
  /** Espelho de `visibleIds` para o cálculo de culling — ver recomputeVisible. */
  const visibleRef = useRef<Set<UUID>>(new Set())
  /** nodeId → instante em que o portal saiu da faixa de permanência. */
  const portalGrace = useRef(new Map<UUID, number>())
  const graceTimer = useRef<number | null>(null)
  /** Redesenha quando o agente acorda (ou solta) um portal fora da viewport. */
  const [, setWakeTick] = useState(0)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  /**
   * Projeto solto no canvas, esperando o usuário dizer o que fazer com ele.
   * Guarda o ponto da tela (para o menu) e o do canvas (para o nó nascer onde
   * foi solto, e não onde o menu foi clicado).
   */
  const [dropped, setDropped] = useState<{
    id: UUID
    screen: Point
    canvas: Point
  } | null>(null)
  /** Retângulo da área sendo desenhada para um componente novo. */
  const [placeBox, setPlaceBox] = useState<Rect | null>(null)
  /** Menu do modo desenho, ancorado no ponto clicado. null = fechado. */
  const [drawMenu, setDrawMenu] = useState<DrawMenuState | null>(null)
  /** Grupo com o título em edição. null = ninguém renomeando. */
  const [editingGroup, setEditingGroup] = useState<UUID | null>(null)
  /** Menu de contexto da faixa do título, ancorado no ponto clicado. */
  const [groupMenu, setGroupMenu] = useState<{ id: UUID; screen: Point } | null>(null)
  /**
   * Moldura realçada durante o arrasto: quem vai adotar o nó ao soltar. Mora
   * num ref porque a marcação é uma classe escrita no DOM a 60fps — em estado
   * do React ela re-renderizaria o canvas a cada pixel do gesto.
   */
  const candidateGroup = useRef<UUID | null>(null)
  /** Espaço segurado: o canvas vira mão e qualquer arrasto é pan. */
  const [spacePan, setSpacePan] = useState(false)
  /** Espaço solto no meio do arrasto — a mão fica até o mouseup. */
  const releasePanOnUp = useRef(false)

  const nodes = workspace?.nodes ?? []
  const connections = workspace?.connections ?? []
  const drawings = workspace?.drawings ?? []
  const groups = workspace?.groups ?? []
  const isDrawingTool = tool === 'pen' || tool === 'highlighter'
  const customThemes = prefs?.terminalThemes ?? []

  /** id → responsabilidade, para o header do nó não varrer a lista por nó. */
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  /**
   * Membros de grupos colapsados. Saem do RENDER e do hit test — nunca do
   * estado: o PTY de um terminal vive no processo principal e continua rodando
   * dobrado, e é isso que faz colapsar ser barato.
   */
  const hiddenNodes = useMemo(() => collapsedMembers(groups), [groups])

  /** Cache de z-index: ascendente para render, descendente para hit testing. */
  const { renderOrder, hitOrder } = useMemo(() => {
    const asc = [...nodes].sort((a, b) => a.zIndex - b.zIndex)
    // Nó dobrado não é alvo: clicar no lugar onde ele estaria selecionaria algo
    // invisível, e o usuário arrastaria o nada.
    const visible = asc.filter((n) => !hiddenNodes.has(n.id))
    return { renderOrder: asc, hitOrder: [...visible].reverse() }
  }, [nodes, hiddenNodes])

  // ─── Tamanho do viewport ────────────────────────────────────────────────────

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(([entry]) => {
      viewport.setSize(entry.contentRect.width, entry.contentRect.height)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // Restaura a posição salva do canvas ao trocar de workspace
  useEffect(() => {
    if (!workspace) return
    viewport.reset(workspace.canvasOrigin, workspace.canvasZoom)
  }, [workspace?.id])

  useEffect(() => portalWake.subscribe(() => setWakeTick((t) => t + 1)), [])

  // Colar imagem no canvas (Ctrl/Cmd+V). O terminal tem o próprio handler em
  // captura e chama stopPropagation, então uma colagem destinada a um agente
  // nunca chega aqui. Texto no clipboard não é problema desta tela — quem cola
  // texto usa o item "Anexo" da dock.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName))) return
      const item = [...(e.clipboardData?.items ?? [])].find(
        (i) => i.kind === 'file' && i.type.startsWith('image/')
      )
      if (!item) return
      const file = item.getAsFile()
      if (!file) return
      e.preventDefault()
      const at = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
      void store.addImageFromBlob(file, at)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // ─── Transform + virtualização ──────────────────────────────────────────────

  /**
   * O conjunto visível, calculado com DOIS limiares e uma carência.
   *
   * O espelho em ref existe porque a decisão de cada nó depende de ele já estar
   * montado (é o que separa entrar de continuar), e ler isso de dentro do
   * updater do setState misturaria efeito com render.
   *
   * A carência é só para o Portal, e é o segundo degrau da mesma defesa da
   * histerese: um pan largo que atravessa o nó de ponta a ponta o tira da faixa
   * de KEEP_MARGIN em poucos frames, e sem ela um vai-e-volta de dois segundos
   * ainda custaria o processo e o recarregamento da página. Terminal não entra:
   * o PTY vive no main e sobrevive à desmontagem.
   */
  const recomputeVisible = useCallback((): void => {
    const prev = visibleRef.current
    const enter = viewport.visibleRect(CULL_MARGIN)
    const keep = viewport.visibleRect(KEEP_MARGIN)
    const now = performance.now()
    const next = new Set<UUID>()
    let wakeIn = Infinity

    for (const node of renderOrder) {
      const id = node.id
      // Entra perto, permanece longe: quem oscila na borda não pisca.
      if (rectsIntersect(node.frame, enter) || (prev.has(id) && rectsIntersect(node.frame, keep))) {
        portalGrace.current.delete(id)
        next.add(id)
        continue
      }
      if (!prev.has(id) || node.content.type !== 'portal') {
        portalGrace.current.delete(id)
        continue
      }
      const since = portalGrace.current.get(id) ?? now
      portalGrace.current.set(id, since)
      const restante = PORTAL_GRACE_MS - (now - since)
      if (restante > 0) {
        next.add(id)
        wakeIn = Math.min(wakeIn, restante)
        continue
      }
      portalGrace.current.delete(id)
    }

    // Nó removido do canvas no meio da carência não volta ao laço acima para ser
    // limpo lá — o mapa é podado aqui.
    for (const id of portalGrace.current.keys()) if (!next.has(id)) portalGrace.current.delete(id)

    // Uma carência só termina quando o relógio anda, e o viewport parado não
    // notifica ninguém: sem este despertar o portal ficaria montado para sempre
    // depois de um pan que parasse fora da faixa.
    if (wakeIn !== Infinity && graceTimer.current === null) {
      graceTimer.current = window.setTimeout(() => {
        graceTimer.current = null
        recomputeVisible()
      }, wakeIn + 16)
    }

    // Só chama setState quando o CONJUNTO visível muda de fato — sem isso o
    // React re-renderizaria a cada pixel de pan.
    if (prev.size === next.size && [...next].every((id) => prev.has(id))) return
    visibleRef.current = next
    setVisibleIds(next)
  }, [renderOrder])

  useEffect(() => {
    const unsubscribe = viewport.subscribe(() => {
      if (nodesRef.current) nodesRef.current.style.transform = viewport.transform()
      recomputeVisible()
    })
    return () => {
      unsubscribe()
      if (graceTimer.current !== null) clearTimeout(graceTimer.current)
      graceTimer.current = null
    }
  }, [recomputeVisible])

  // Persiste pan/zoom (sem marcar dirty: é estado de runtime)
  useEffect(() => {
    const id = workspace?.id
    if (!id) return
    const timer = setInterval(() => {
      void window.atelier.workspace.setViewport(id, viewport.origin, viewport.zoom)
    }, 2000)
    return () => clearInterval(timer)
  }, [workspace?.id])

  // ─── Hit testing ────────────────────────────────────────────────────────────

  const hitTest = useCallback(
    (canvasPoint: Point): CanvasNode | null => {
      for (const node of hitOrder) {
        const f = node.frame
        if (
          canvasPoint.x >= f.x &&
          canvasPoint.x <= f.x + f.width &&
          canvasPoint.y >= f.y &&
          canvasPoint.y <= f.y + f.height
        ) {
          return node
        }
      }
      return null
    },
    [hitOrder]
  )

  /**
   * Traço sob o cursor, para a borracha. Testa distância ponto→segmento; a
   * tolerância acompanha o zoom para a borracha não ficar impossível de acertar
   * com o canvas afastado.
   */
  const hitDrawing = useCallback(
    (cp: Point): UUID | null => {
      const tolerance = Math.max(6, 10 / viewport.zoom)
      // De trás para frente: o traço mais recente está por cima.
      for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i]
        const half = Math.max(Math.abs(d.lineWidth) / 2, 1)
        const reach = tolerance + half
        for (let j = 0; j < d.points.length - 1; j++) {
          const [x1, y1] = d.points[j]
          const [x2, y2] = d.points[j + 1]
          if (pointSegmentDistance(cp, x1, y1, x2, y2) <= reach) return d.id
        }
      }
      return null
    },
    [drawings]
  )

  useEffect(() => {
    if (!dropped) return
    const close = (): void => setDropped(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [dropped])

  const screenPoint = (e: React.MouseEvent | MouseEvent): Point => {
    const rect = hostRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  // ─── Projeto arrastado do painel ────────────────────────────────────────────

  /**
   * Só os nossos dois tipos: arquivo do gerenciador, link do navegador ou texto
   * de outro app continuam não sendo drop.
   */
  const onDragOver = (e: React.DragEvent): void => {
    const types = e.dataTransfer.types
    // `Files` cobre imagem arrastada do Explorer/Finder; os dois tipos próprios
    // continuam sendo o arrasto interno (projeto e arquivo da árvore).
    if (
      !types.includes(PROJECT_DRAG_TYPE) &&
      !types.includes(FILE_DRAG_TYPE) &&
      !types.includes('Files')
    ) {
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDrop = (e: React.DragEvent): void => {
    const canvas = viewport.toCanvas(screenPoint(e))

    // Arquivo arrastado do sistema (Explorer/Finder). Vem antes dos tipos
    // próprios: um arrasto interno não carrega `files`, então não colide.
    const osFiles = [...(e.dataTransfer.files ?? [])]
    const isInternalDrag =
      e.dataTransfer.types.includes(FILE_DRAG_TYPE) ||
      e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)
    if (osFiles.length > 0 && !isInternalDrag) {
      // Sempre segura o drop: sem isto o Chromium navegaria para o file://.
      e.preventDefault()
      const osImages = osFiles.filter((f) => f.type.startsWith('image/'))
      if (osImages.length === 0) {
        store.showNotice('só imagens podem ser soltas no canvas')
        return
      }
      const under = hitTest(canvas)
      if (under?.content.type === 'terminal') {
        // Dentro de um terminal o gesto quer o caminho na linha, igual ao paste.
        void osImages[0].arrayBuffer().then(async (buf) => {
          const r = await window.atelier.terminal.pasteImage(under.id, buf, osImages[0].type)
          if ('error' in r) store.showNotice(r.error)
        })
        return
      }
      osImages.forEach((file, i) => {
        const at = { x: canvas.x + i * 24, y: canvas.y + i * 24 }
        void store.addImageFromBlob(file, at)
      })
      return
    }

    // Arquivo e pasta agem DIRETO, sem menu: foi o pedido. Um arquivo abre o
    // editor no ponto solto; uma pasta vira nó de árvore, que é o análogo.
    const dragged = e.dataTransfer.getData(FILE_DRAG_TYPE)
    if (dragged) {
      e.preventDefault()
      const payload = readFileDrag(dragged)
      if (!payload) return

      // Solto DENTRO de um terminal, o gesto quer outra coisa: o caminho na
      // linha de comando. Abrir um editor por cima do terminal seria tapar
      // justamente o que a pessoa estava usando.
      const under = hitTest(canvas)
      if (under?.content.type === 'terminal') {
        void store.pasteIntoTerminal(under.id, payload.path)
        return
      }

      if (payload.isDirectory) {
        void store.addFolderTreeToWorkspace(payload.path, payload.name, canvas)
      } else if (isSupportedImageName(payload.path)) {
        // Imagem vira nó de imagem, não editor de código (que a rejeita por
        // binária). O main lê os bytes pela allowlist e copia para o nó.
        void store.addImageFromPath(payload.path, canvas)
      } else {
        void store.openFileInWorkspace(payload.path, canvas)
      }
      return
    }

    // Projeto continua perguntando: as duas ações possíveis (adicionar árvore,
    // subir um agente ali) são igualmente razoáveis, e adivinhar erraria metade.
    const id = e.dataTransfer.getData(PROJECT_DRAG_TYPE)
    if (!id) return
    e.preventDefault()
    setDropped({
      id: id as UUID,
      screen: { x: e.clientX, y: e.clientY },
      canvas
    })
  }

  // ─── Mouse ──────────────────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent): void => {
    // Mão do espaço antes de qualquer outra coisa: com ela segurada o arrasto é
    // pan, venha de onde vier — a .nodes-layer fica transparente ao mouse, então
    // nem terminal nem portal chegam a ver o clique.
    if (spacePan && e.button === 0 && !placing) {
      e.preventDefault()
      interaction.current = { kind: 'panning', last: screenPoint(e) }
      return
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      interaction.current = { kind: 'panning', last: screenPoint(e) }
      return
    }
    // Ferramenta mão: o espaço segurado, só que travado no botão da dock. Vem
    // antes do hit test pelo mesmo motivo — a .nodes-layer está transparente ao
    // mouse, então o arrasto move o quadro mesmo começando sobre um nó. Mas
    // colocar um widget novo tem prioridade — senão o clique só arrasta o
    // quadro e o widget nunca nasce.
    if (tool === 'pan' && e.button === 0 && !placing) {
      e.preventDefault()
      interaction.current = { kind: 'panning', last: screenPoint(e) }
      return
    }
    if (e.button !== 0) return

    // Modo "desenhe a área": o clique não seleciona nem cria nada ainda, só
    // começa o retângulo. Vem antes do hit test para funcionar por cima de
    // qualquer nó — o componente novo pode nascer sobreposto, é escolha do usuário.
    if (placing) {
      const start = viewport.toCanvas(screenPoint(e))
      interaction.current = { kind: 'placing', start }
      setPlaceBox({ x: start.x, y: start.y, width: 0, height: 0 })
      return
    }

    const target = e.target as HTMLElement
    const sp = screenPoint(e)
    const cp = viewport.toCanvas(sp)

    // Modo desenho: o clique não desenha, PERGUNTA. Abre o menu no ponto e
    // deixa a interação idle — quem escolher a ferramenta lá desenha no
    // arrasto seguinte.
    if (tool === 'draw') {
      setDrawMenu({ screen: { x: e.clientX, y: e.clientY }, canvas: cp })
      interaction.current = { kind: 'idle' }
      return
    }

    // Ferramentas de desenho vêm ANTES de tudo: com a caneta ativa o arrasto é
    // traço, não seleção nem pan, e nem o conteúdo do nó captura o clique.
    if (isDrawingTool) {
      liveStroke.current = {
        points: [cp],
        color: pen.color,
        lineWidth: tool === 'highlighter' ? pen.lineWidth * 4 : pen.lineWidth,
        translucent: tool === 'highlighter'
      }
      strokeTick.current++
      interaction.current = { kind: 'drawing' }
      return
    }

    if (tool === 'eraser') {
      const hit = hitDrawing(cp)
      if (hit) void store.removeDrawing(hit)
      interaction.current = { kind: 'drawing' } // segue apagando no arrasto
      return
    }

    // Cliques dentro do conteúdo do nó (terminal, editor) são do nó, não do canvas
    if (target.closest('[data-node-interactive]')) return

    // ─── Alças do traço selecionado ─────────────────────────────────────────
    // Mesma prioridade das alças de grupo: são a única parte clicável do
    // retrato de seleção, então chegar aqui já decide o gesto.
    const drawingHandleEl = target.closest('[data-drawing-handle]') as HTMLElement | null
    if (drawingHandleEl && selectedDrawingId) {
      const selectedDrawing = drawings.find((d) => d.id === selectedDrawingId)
      const bounds = selectedDrawing ? strokeBounds(selectedDrawing.points) : null
      if (selectedDrawing && bounds) {
        interaction.current = {
          kind: 'resizingDrawing',
          id: selectedDrawing.id,
          start: cp,
          frame: bounds,
          points: selectedDrawing.points,
          lineWidth: selectedDrawing.lineWidth,
          edge: (drawingHandleEl.dataset.drawingHandle as ResizeEdge) || 'se'
        }
        return
      }
    }

    // ─── Molduras de grupo ───────────────────────────────────────────────────
    // Antes do hit test de nó: a faixa e as alças são as ÚNICAS partes
    // clicáveis da moldura (o corpo é `pointer-events: none`), então chegar
    // aqui já significa que o gesto é do grupo. Perguntar ao hitTest antes
    // devolveria o nó cujo frame por acaso passa por baixo da faixa.
    const groupHandleEl = target.closest('[data-group-handle]') as HTMLElement | null
    const groupTitleEl = target.closest('[data-group-title]') as HTMLElement | null
    const groupEl = target.closest('[data-group-id]') as HTMLElement | null
    const groupId = groupEl?.dataset.groupId as UUID | undefined
    const group = groupId ? groups.find((g) => g.id === groupId) : undefined

    if (group && (groupHandleEl || groupTitleEl)) {
      store.selectGroup(group.id)
      if (groupHandleEl) {
        interaction.current = {
          kind: 'groupResizing',
          id: group.id,
          start: cp,
          frame: { ...group.frame },
          edge: (groupHandleEl.dataset.groupHandle as ResizeEdge) || 'se'
        }
        return
      }
      // Arrastar a faixa move a moldura E os membros — é o mesmo caminho do
      // arrasto de seleção múltipla, com a lista de membros no lugar da seleção.
      const members = nodes.filter((n) => group.nodeIds.includes(n.id))
      interaction.current = {
        kind: 'mayDrag',
        ids: members.map((n) => n.id),
        start: cp,
        frames: new Map(members.map((n) => [n.id, { ...n.frame }])),
        group: { id: group.id, frame: { ...group.frame } }
      }
      return
    }

    const handle = target.closest('[data-resize-handle]') as HTMLElement | null
    const nodeEl = target.closest('[data-node-id]') as HTMLElement | null
    const nodeId = nodeEl?.dataset.nodeId as UUID | undefined
    const node = nodeId ? nodes.find((n) => n.id === nodeId) : hitTest(cp)

    if (connectingFrom) {
      const source = nodes.find((n) => n.id === connectingFrom)
      // Clique no vazio cancela. Em alvo que não aceita o cabo o clique é
      // ignorado e o modo continua ligado — o fantasma já avisou em vermelho.
      if (!node || !source) {
        store.startConnecting(null)
        return
      }
      if (canLink(source, node, connections)) {
        void store.addConnection(connectingFrom, node.id)
        store.startConnecting(null)
      }
      return
    }

    if (node) {
      // A seleção que vai se mover é a de DEPOIS deste clique: clicar num nó
      // fora da seleção troca a seleção, e o arrasto seguinte é dele só.
      let dragIds = selection
      if (!selection.includes(node.id)) {
        dragIds = e.shiftKey ? [...selection, node.id] : [node.id]
        store.select(dragIds)
      }

      // Com vários nós, subir todos ao topo embaralharia a ordem relativa que
      // o usuário montou — o z passa a ser o da última iteração do laço, não o
      // que ele via. Com um só, subir é o comportamento de sempre.
      if (dragIds.length === 1) void store.bringToFront(node.id)

      if (handle) {
        interaction.current = {
          kind: 'resizing',
          id: node.id,
          start: cp,
          frame: { ...node.frame },
          // Sem valor no atributo vale a quina de sempre — assim uma alça
          // antiga no DOM continua funcionando durante um hot reload.
          edge: (handle.dataset.resizeHandle as ResizeEdge) || 'se'
        }
        return
      }

      const dragged = nodes.filter((n) => dragIds.includes(n.id) && !hiddenNodes.has(n.id))
      interaction.current = {
        kind: 'mayDrag',
        ids: dragged.map((n) => n.id),
        start: cp,
        frames: new Map(dragged.map((n) => [n.id, { ...n.frame }])),
        group: null
      }
      return
    }

    // Corpo de um traço: mesmo hit-test da borracha, mas para selecionar em vez
    // de apagar. Depois do miss de nó — traço fica ATRÁS dos nós no empilhamento
    // (ver cabeçalho do arquivo), então nó por cima sempre ganha o clique.
    const hitDrawingId = hitDrawing(cp)
    if (hitDrawingId) {
      store.selectDrawing(hitDrawingId)
      const hitDrawingObj = drawings.find((d) => d.id === hitDrawingId)
      if (hitDrawingObj) {
        interaction.current = {
          kind: 'draggingDrawing',
          id: hitDrawingId,
          start: cp,
          points: hitDrawingObj.points
        }
      }
      return
    }

    store.select([])
    store.selectGroup(null)
    store.selectDrawing(null)
    interaction.current = { kind: 'marquee', start: cp, current: cp }
  }

  useEffect(() => {
    /**
     * Realça a moldura que vai adotar o nó ao soltar.
     *
     * Sem isto o gesto de entrar num grupo seria adivinhação: o usuário só
     * descobriria o dono depois de largar o botão. Toca só na classe do
     * elemento, e só quando o candidato MUDA — a 60fps, reescrever a mesma
     * classe já seria trabalho à toa.
     */
    const clearCandidate = (): void => {
      if (!candidateGroup.current) return
      hostRef.current
        ?.querySelector(`[data-group-id="${candidateGroup.current}"]`)
        ?.classList.remove('is-candidate')
      candidateGroup.current = null
    }

    const highlightCandidate = (state: DragTargets, dx: number, dy: number): void => {
      // O primeiro nó do arrasto manda: com vários selecionados, deixar cada um
      // cair num grupo diferente espalharia a seleção por várias molduras num
      // gesto só, e o realce não teria como mostrar isso.
      const frame = state.ids.length > 0 ? state.frames.get(state.ids[0]) : undefined
      const next = frame
        ? groupAt(groups, { ...frame, x: frame.x + dx, y: frame.y + dy })?.id ?? null
        : null
      if (next === candidateGroup.current) return
      clearCandidate()
      if (next) {
        hostRef.current
          ?.querySelector(`[data-group-id="${next}"]`)
          ?.classList.add('is-candidate')
        candidateGroup.current = next
      }
    }

    const onMove = (e: MouseEvent): void => {
      const state = interaction.current
      if (state.kind === 'idle') return

      const sp = screenPoint(e)
      const cp = viewport.toCanvas(sp)

      switch (state.kind) {
        case 'panning': {
          viewport.panBy(sp.x - state.last.x, sp.y - state.last.y)
          interaction.current = { kind: 'panning', last: sp }
          break
        }
        case 'mayDrag': {
          const moved = Math.hypot(cp.x - state.start.x, cp.y - state.start.y) * viewport.zoom
          if (moved > DRAG_THRESHOLD) interaction.current = { ...state, kind: 'dragging' }
          break
        }
        case 'dragging': {
          const dx = cp.x - state.start.x
          const dy = cp.y - state.start.y
          const shift = `translate(${dx}px, ${dy}px)`
          // Escreve direto no DOM: nada de setState no caminho do mousemove.
          // Um laço sobre a seleção inteira, não um nó — e ainda assim é uma
          // escrita de `transform` por elemento, que a GPU compõe sozinha.
          for (const id of state.ids) {
            const el = nodesRef.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
            if (el) el.style.transform = shift
            const frame = state.frames.get(id)
            // liveFrames é o que mantém os cabos colados durante o arrasto.
            if (frame) {
              liveFrames.current.set(id, {
                x: frame.x + dx + frame.width / 2,
                y: frame.y + dy + frame.height / 2
              })
            }
          }
          if (state.group) {
            const el = hostRef.current?.querySelector<HTMLElement>(
              `[data-group-id="${state.group.id}"]`
            )
            if (el) el.style.transform = shift
          } else {
            highlightCandidate(state, dx, dy)
          }
          break
        }
        case 'groupResizing': {
          const el = hostRef.current?.querySelector<HTMLElement>(`[data-group-id="${state.id}"]`)
          if (el) {
            const next = resizeFrame(
              state.frame,
              state.edge,
              cp.x - state.start.x,
              cp.y - state.start.y,
              GROUP_MIN_WIDTH,
              GROUP_MIN_HEIGHT
            )
            el.style.left = `${next.x}px`
            el.style.top = `${next.y}px`
            el.style.width = `${next.width}px`
            el.style.height = `${next.height}px`
          }
          break
        }
        case 'resizing': {
          const el = nodesRef.current?.querySelector<HTMLElement>(`[data-node-id="${state.id}"]`)
          if (el) {
            const next = resizeFrame(state.frame, state.edge, cp.x - state.start.x, cp.y - state.start.y)
            // Escreve as quatro: puxar pela esquerda ou pelo topo move o nó
            // além de mudar o tamanho.
            el.style.left = `${next.x}px`
            el.style.top = `${next.y}px`
            el.style.width = `${next.width}px`
            el.style.height = `${next.height}px`
          }
          break
        }
        case 'marquee': {
          interaction.current = { ...state, current: cp }
          setMarquee(normalizeRect(state.start, cp))
          break
        }
        case 'placing': {
          const pending = store.getSnapshot().placing
          setPlaceBox(clampToMin(normalizeRect(state.start, cp), pending?.minSize))
          break
        }
        case 'drawing': {
          const stroke = liveStroke.current
          if (stroke) {
            // Descarta micro-movimentos: sem isso um traço lento gera centenas
            // de pontos quase idênticos e engorda o arquivo à toa.
            const last = stroke.points[stroke.points.length - 1]
            const minStep = 1.5 / viewport.zoom
            if (Math.hypot(cp.x - last.x, cp.y - last.y) >= minStep) {
              stroke.points.push(cp)
              strokeTick.current++
            }
          } else if (tool === 'eraser') {
            const hit = hitDrawing(cp)
            if (hit) void store.removeDrawing(hit)
          }
          break
        }
        case 'draggingDrawing': {
          const dx = cp.x - state.start.x
          const dy = cp.y - state.start.y
          liveDrawingTransform.current = {
            id: state.id,
            anchorX: 0,
            anchorY: 0,
            scaleX: 1,
            scaleY: 1,
            dx,
            dy
          }
          strokeTick.current++
          const el = hostRef.current?.querySelector<HTMLElement>(`[data-drawing-id="${state.id}"]`)
          if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
          break
        }
        case 'resizingDrawing': {
          const next = resizeFrame(
            state.frame,
            state.edge,
            cp.x - state.start.x,
            cp.y - state.start.y,
            DRAWING_MIN_SIZE,
            DRAWING_MIN_SIZE
          )
          // O canto OPOSTO à borda arrastada é o que não se move — mesma regra
          // do resizeFrame, só que aqui vira o ponto de ancoragem da escala.
          const anchorX = state.edge.includes('w') ? state.frame.x + state.frame.width : state.frame.x
          const anchorY = state.edge.includes('n') ? state.frame.y + state.frame.height : state.frame.y
          liveDrawingTransform.current = {
            id: state.id,
            anchorX,
            anchorY,
            scaleX: next.width / state.frame.width,
            scaleY: next.height / state.frame.height,
            dx: 0,
            dy: 0
          }
          strokeTick.current++
          const el = hostRef.current?.querySelector<HTMLElement>(`[data-drawing-id="${state.id}"]`)
          if (el) {
            el.style.left = `${next.x}px`
            el.style.top = `${next.y}px`
            el.style.width = `${next.width}px`
            el.style.height = `${next.height}px`
          }
          break
        }
      }
    }

    const onUp = (e: MouseEvent): void => {
      const state = interaction.current
      interaction.current = { kind: 'idle' }
      if (releasePanOnUp.current) {
        releasePanOnUp.current = false
        setSpacePan(false)
      }
      const cp = viewport.toCanvas(screenPoint(e))

      switch (state.kind) {
        case 'dragging': {
          const dx = cp.x - state.start.x
          const dy = cp.y - state.start.y

          const entries: { nodeId: UUID; frame: Rect }[] = []
          for (const id of state.ids) {
            const el = nodesRef.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
            if (el) el.style.transform = ''
            liveFrames.current.delete(id)
            const frame = state.frames.get(id)
            if (frame) entries.push({ nodeId: id, frame: { ...frame, x: frame.x + dx, y: frame.y + dy } })
          }
          // UM commit para a seleção inteira: N chamadas seriam N idas ao main
          // e N notificações da store, com o usuário já parado.
          void store.commitFrames(entries)

          if (state.group) {
            const el = hostRef.current?.querySelector<HTMLElement>(
              `[data-group-id="${state.group.id}"]`
            )
            if (el) el.style.transform = ''
            void store.setGroupFrame(state.group.id, {
              ...state.group.frame,
              x: state.group.frame.x + dx,
              y: state.group.frame.y + dy
            })
            // Mover o grupo NÃO recruta nem solta ninguém: os membros andaram
            // junto com a moldura, e a relação entre eles não mudou.
            break
          }

          // Arrastar um nó é o que edita a lista de membros: quem parou com o
          // centro dentro de uma moldura passa a ser dela; quem saiu, some dela.
          clearCandidate()
          for (const entry of entries) {
            void store.setNodeGroup(entry.nodeId, groupAt(groups, entry.frame)?.id ?? null)
          }
          break
        }
        case 'resizing': {
          void store.commitFrame(
            state.id,
            resizeFrame(state.frame, state.edge, cp.x - state.start.x, cp.y - state.start.y)
          )
          break
        }
        case 'groupResizing': {
          // Redimensionar a moldura mexe SÓ no retângulo: encolher não expulsa
          // membro nenhum. Só o arrasto de um nó muda quem pertence a quê —
          // senão a moldura expulsaria nós que ninguém tocou.
          void store.setGroupFrame(
            state.id,
            resizeFrame(
              state.frame,
              state.edge,
              cp.x - state.start.x,
              cp.y - state.start.y,
              GROUP_MIN_WIDTH,
              GROUP_MIN_HEIGHT
            )
          )
          break
        }
        case 'marquee': {
          const box = normalizeRect(state.start, cp)
          // Nó dobrado não entra: ele não está na tela, e selecioná-lo faria o
          // Delete seguinte apagar algo que o usuário não vê.
          const hits = nodes
            .filter((n) => !hiddenNodes.has(n.id) && rectsIntersect(n.frame, box))
            .map((n) => n.id)
          store.select(hits)
          setMarquee(null)
          break
        }
        case 'placing': {
          setPlaceBox(null)
          const raw = normalizeRect(state.start, cp)
          const pending = store.getSnapshot().placing
          if (!pending) break
          // Clique seco (sem arrasto de verdade) vale como "use o tamanho
          // padrão aqui" — senão um clique acidental criaria um nó de 3px.
          const dragged = Math.max(raw.width, raw.height) * viewport.zoom > CLICK_SLOP
          const [w, h] = pending.defaultSize
          store.completePlacing(
            dragged
              ? clampToMin(raw, pending.minSize)
              : { x: raw.x - w / 2, y: raw.y - h / 2, width: w, height: h }
          )
          break
        }
        case 'drawing': {
          const stroke = liveStroke.current
          liveStroke.current = null
          strokeTick.current++
          if (stroke && stroke.points.length > 1) {
            // Marca-texto vai com lineWidth NEGATIVO: o Drawing do formato em
            // disco não tem campo de tipo, e o sinal sobrevive ao round-trip
            // sem quebrar o app nativo (que lê o valor absoluto como espessura).
            const width = stroke.translucent ? -stroke.lineWidth : stroke.lineWidth
            void store.addDrawing(
              stroke.points.map((p) => [p.x, p.y]),
              stroke.color,
              width
            )
          }
          break
        }
        case 'draggingDrawing': {
          const dx = cp.x - state.start.x
          const dy = cp.y - state.start.y
          liveDrawingTransform.current = null
          const el = hostRef.current?.querySelector<HTMLElement>(`[data-drawing-id="${state.id}"]`)
          if (el) el.style.transform = ''
          const points = state.points.map(([x, y]) => [x + dx, y + dy])
          void store.commitDrawingPoints(state.id, points)
          strokeTick.current++
          break
        }
        case 'resizingDrawing': {
          const next = resizeFrame(
            state.frame,
            state.edge,
            cp.x - state.start.x,
            cp.y - state.start.y,
            DRAWING_MIN_SIZE,
            DRAWING_MIN_SIZE
          )
          const anchorX = state.edge.includes('w') ? state.frame.x + state.frame.width : state.frame.x
          const anchorY = state.edge.includes('n') ? state.frame.y + state.frame.height : state.frame.y
          const scaleX = next.width / state.frame.width
          const scaleY = next.height / state.frame.height
          const points = state.points.map(([x, y]) => [
            anchorX + (x - anchorX) * scaleX,
            anchorY + (y - anchorY) * scaleY
          ])
          // O sinal do lineWidth marca marca-texto (ver 'drawing' acima) — a
          // escala não pode virá-lo positivo por engano.
          const scale = Math.min(Math.abs(scaleX), Math.abs(scaleY))
          const nextWidth =
            state.lineWidth < 0 ? -Math.abs(state.lineWidth) * scale : Math.abs(state.lineWidth) * scale
          liveDrawingTransform.current = null
          const el = hostRef.current?.querySelector<HTMLElement>(`[data-drawing-id="${state.id}"]`)
          if (el) {
            el.style.left = ''
            el.style.top = ''
            el.style.width = ''
            el.style.height = ''
          }
          void store.commitDrawingPoints(state.id, points, nextWidth)
          strokeTick.current++
          break
        }
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // tool/hitDrawing entram aqui: sem eles a borracha apagaria contra uma
    // lista de traços velha (closure obsoleta). `groups` e `hiddenNodes` pelo
    // mesmo motivo — quem decide o dono de um nó ao soltar é esta closure.
  }, [nodes, tool, hitDrawing, groups, hiddenNodes])

  // ─── Roda: pan por padrão, zoom com ⌘/Ctrl (convenção de trackpad) ──────────

  /**
   * Listener NATIVO em CAPTURA, e não a prop `onWheel` do React.
   *
   * O zoom é gesto do CANVAS e tem de valer com o cursor em cima de qualquer
   * coisa — mas na borbulha ele não chegava aqui: quem está por baixo às vezes
   * mata o evento antes. O xterm é o caso que se nota, porque chama
   * `preventDefault` + `stopPropagation` na roda sempre que o programa do
   * terminal reporta mouse (é o que as TUIs de agente fazem) ou quando o buffer
   * não tem scrollback. Na captura o host vê o evento ANTES de todo descendente,
   * então widget nenhum consegue engolir o gesto.
   *
   * `passive: false` porque o handler chama `preventDefault` — sem isso o
   * Chromium registra o listener como passivo e ignora o pedido.
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const onWheel = (e: WheelEvent): void => {
      // O modificador já diz que a intenção não é rolar o conteúdo sob o cursor.
      if (e.ctrlKey || e.metaKey) {
        // preventDefault contra o zoom de página do Chromium (mesmo gesto);
        // stopPropagation para o widget de baixo não rolar junto com o zoom.
        e.preventDefault()
        e.stopPropagation()
        viewport.zoomByWheel(screenPoint(e), e.deltaY, e.deltaMode)
        return
      }
      // Rolar dentro do conteúdo de um nó é DO nó — a mesma regra que o clique
      // já segue, com o mesmo marcador. Sem ela o canvas panorâmica junto com a
      // lista, e quando a lista chega ao fim sobra só o canvas andando, que é o
      // efeito que se nota. Aqui só devolvemos o evento ao dono: sem
      // stopPropagation, ele segue para o widget normalmente.
      if ((e.target as HTMLElement).closest('[data-node-interactive]')) return
      viewport.panBy(-e.deltaX, -e.deltaY)
    }

    host.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => host.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // ─── Teclado ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName))) return

      // Backspace NÃO apaga — a tecla é grande demais e fica no caminho de quem
      // só queria corrigir o que digitou. A exceção é o macOS: num MacBook não
      // existe `Delete` dedicado (é fn+delete), e sem ela o atalho ficaria sem
      // gesto naquele teclado. Ver `platform`, que vem do bootInfo.
      const apaga = e.key === 'Delete' || (platform === 'darwin' && e.key === 'Backspace')

      if (apaga && selection.length > 0) {
        e.preventDefault()
        // Um IPC e UM retrato de undo para a seleção inteira: apagar cinco nós
        // e ter de desfazer cinco vezes não é desfazer o que se fez.
        void store.removeNodes(selection)
      }
      // Delete com a moldura selecionada DESAGRUPA: some o retângulo, ficam os
      // nós. Apagar os membros junto existe, mas só pelo menu de contexto e com
      // confirmação — é o único caminho destrutivo do grupo, e uma tecla é
      // barata demais para ele.
      if (apaga && selectedGroupId) {
        e.preventDefault()
        void store.removeGroup(selectedGroupId)
      }
      if (apaga && selectedDrawingId) {
        e.preventDefault()
        void store.removeDrawing(selectedDrawingId)
      }
      if (e.key === 'Escape') {
        store.cancelPlacing()
        setPlaceBox(null)
        store.startConnecting(null)
        setDrawMenu(null)
        setGroupMenu(null)
        setEditingGroup(null)
        store.isolateGroup(null)
        store.selectDrawing(null)
        store.setTool('select')
      }

      // Desfazer/refazer, no atalho que todo editor usa — Shift inverte o sentido.
      //
      // É UM histórico só, delete incluído: este bloco era disparado junto com
      // um segundo, que desfazia o último delete por outra pilha, e o mesmo
      // ⌘Z rodava os dois. Refazer não apaga de novo — o store para no delete
      // em vez de atravessá-lo, e quem quiser mesmo apagar aperta Delete. A
      // guarda lá de cima já protege quem está digitando: dentro de uma nota ou
      // do editor o ⌘Z é do texto, e nem chega aqui.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) void store.redo()
        else void store.undo()
      }

      // Agrupar e desagrupar, no atalho que todo editor de canvas usa.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) {
          if (selectedGroupId) void store.removeGroup(selectedGroupId)
        } else if (selection.length > 0) {
          void store.groupSelection()
        }
      }

      // Atalhos das ferramentas, no padrão de editor de canvas
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'v') store.setTool('select')
        if (key === 'd') store.setTool('draw')
        if (key === 'p') store.setTool('pen')
        if (key === 'm') store.setTool('highlighter')
        if (key === 'e') store.setTool('eraser')
      }
      // Zoom pelo teclado, no padrão de todo editor. O `=` entra junto do `+`
      // porque no teclado sem numérico o mais exige Shift, e ninguém segura
      // Shift para dar zoom; `-` e `_` pelo mesmo motivo.
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '0') {
          e.preventDefault()
          viewport.setZoom(1)
        }
        if (e.key === '+' || e.key === '=') {
          e.preventDefault()
          viewport.zoomStep(1)
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          viewport.zoomStep(-1)
        }
      }

      // Espaço: mão. preventDefault porque senão a tecla ativa o botão focado.
      if (e.code === 'Space' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setSpacePan(true)
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      // Soltar o espaço no meio do arrasto não corta o pan: a mão fica até o
      // mouseup, senão o gesto morre pela metade.
      if (interaction.current.kind === 'panning') releasePanOnUp.current = true
      else setSpacePan(false)
    }

    // Alt-tab com o espaço apertado nunca entrega o keyup — sem isso o canvas
    // ficaria preso na mão.
    const onBlur = (): void => {
      releasePanOnUp.current = false
      setSpacePan(false)
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [selection, selectedGroupId, selectedDrawingId, platform])

  /**
   * Botão direito no canvas não CRIA nada.
   *
   * Ele criava uma nota no ponto clicado, e isso é ação destrutiva por engano:
   * um clique direito acidental — ou um trackpad interpretando dois dedos —
   * deixava um nó no canvas sem o usuário ter pedido. Criar é papel da dock,
   * onde o gesto é deliberado.
   *
   * O handler fica, só para segurar o preventDefault: sem ele o menu nativo do
   * Chromium aparece por cima do canvas.
   */
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    // A faixa do título é a exceção: ali o botão direito é o caminho para tudo
    // que o grupo faz e que não cabe num atalho.
    const band = (e.target as HTMLElement).closest('[data-group-title]') as HTMLElement | null
    const id = band?.dataset.groupTitle as UUID | undefined
    if (!id) return
    store.selectGroup(id)
    setGroupMenu({ id, screen: { x: e.clientX, y: e.clientY } })
  }

  /**
   * Duplo-clique na faixa. Dois gestos no mesmo lugar, separados pelo alvo:
   * no RÓTULO ele renomeia (é o texto que se quer trocar); no resto da faixa
   * ele enquadra o grupo, que é o "focar" do pedido. Sem essa divisão, o gesto
   * mais frequente — enquadrar — abriria um campo de texto por engano toda vez.
   */
  const onDoubleClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    const band = target.closest('[data-group-title]') as HTMLElement | null
    const id = band?.dataset.groupTitle as UUID | undefined
    if (!id) return
    if (target.closest('.group-title-text')) {
      setEditingGroup(id)
      return
    }
    const group = groups.find((g) => g.id === id)
    if (group) viewport.fit(group.frame)
  }

  // Um portal acordado pelo agente renderiza mesmo fora da viewport: sem isso a
  // leitura só funcionaria com o nó na tela, que é o mesmo que não funcionar.
  //
  // A mesma exceção vale para o colapso, e é deliberada: um portal dentro de um
  // grupo dobrado continua MONTADO enquanto o agente estiver lendo dele. Um
  // retângulo fechado na tela não pode desligar uma leitura em curso.
  //
  // Montado, não visível: quem está dobrado sai da tela pelo `hidden` abaixo.
  // Sem essa separação o portal acordado — e o controle ligado renova o
  // despertar de 10 em 10 segundos, indefinidamente — continuava desenhado por
  // cima do grupo fechado, enquanto os outros nós sumiam.
  const visibleNodes = renderOrder.filter(
    (n) => portalWake.has(n.id) || (visibleIds.has(n.id) && !hiddenNodes.has(n.id))
  )

  /**
   * Modo foco: os nós de FORA do grupo apagam. Só em memória — não vai para o
   * disco, porque é como se está lendo o canvas agora, não uma propriedade do
   * grupo.
   */
  const isolatedMembers = isolatedGroupId
    ? new Set(groups.find((g) => g.id === isolatedGroupId)?.nodeIds ?? [])
    : null

  const menuGroup = groupMenu ? groups.find((g) => g.id === groupMenu.id) ?? null : null

  /**
   * Nó formatável selecionado — só com seleção única: com vários nós a barra
   * não teria um valor único para mostrar nos controles.
   */
  const formatTarget =
    selection.length === 1
      ? nodes.find(
          (n) =>
            n.id === selection[0] &&
            (n.content.type === 'text' || n.content.type === 'stickyNote')
        ) ?? null
      : null

  /**
   * Terminal ou botão com seleção única — ganha a barra de editar/excluir (e,
   * no terminal, ligar e recarregar). Com vários selecionados a barra não teria
   * um alvo só.
   *
   * O botão entrou aqui porque ele é chromeless: sem cabeçalho, editar e
   * excluir não teriam onde morar, e o duplo clique sozinho é um gesto que não
   * se anuncia.
   */
  const actionTarget =
    selection.length === 1
      ? nodes.find(
          (n) =>
            n.id === selection[0] &&
            (n.content.type === 'terminal' ||
              (n.content.type === 'widget' && n.content.value.kind === 'button'))
        ) ?? null
      : null

  return (
    <div
      ref={hostRef}
      className={[
        'canvas-host',
        spacePan ? 'is-space-pan' : '',
        placing ? 'is-placing' : '',
        connectingFrom ? 'is-connecting' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      data-tool={tool}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <CanvasBackground mode="grid" />

      <DrawingsLayer
        drawings={drawings}
        live={liveStroke}
        tick={strokeTick}
        liveTransform={liveDrawingTransform}
      />
      <DrawingSelection drawing={drawings.find((d) => d.id === selectedDrawingId) ?? null} />

      {/* ANTES da .nodes-layer: a moldura é o fundo em que os nós estão. */}
      <GroupsLayer
        groups={groups}
        selectedId={selectedGroupId}
        isolatedId={isolatedGroupId}
        editingId={editingGroup}
        onEditDone={(id, title) => {
          setEditingGroup(null)
          void store.renameGroup(id, title)
        }}
        onEditCancel={() => setEditingGroup(null)}
      />

      <ConnectionsLayer
        nodes={nodes}
        connections={connections}
        liveFrames={liveFrames}
        hiddenNodes={hiddenNodes}
      />

      {connectingFrom && (
        <ConnectionPreview
          from={connectingFrom}
          nodes={nodes}
          connections={connections}
          hostRef={hostRef}
          hitTest={hitTest}
        />
      )}

      <div ref={nodesRef} className="nodes-layer">
        {visibleNodes.map((node) => (
          <NodeShell
            key={node.id}
            node={node}
            selected={selection.includes(node.id)}
            workspaceId={workspace?.id ?? ''}
            role={
              node.content.type === 'terminal' && node.content.value.assignedRoleId
                ? rolesById.get(node.content.value.assignedRoleId) ?? null
                : null
            }
            customThemes={customThemes}
            status={terminalStatus[node.id] ?? null}
            projectName={widgetProjectName(node, projects)}
            dimmed={isolatedMembers !== null && !isolatedMembers.has(node.id)}
            hidden={hiddenNodes.has(node.id)}
          />
        ))}
      </div>

      {marquee && (
        <div
          className="marquee"
          style={{
            left: (marquee.x - viewport.origin.x) * viewport.zoom,
            top: (marquee.y - viewport.origin.y) * viewport.zoom,
            width: marquee.width * viewport.zoom,
            height: marquee.height * viewport.zoom
          }}
        />
      )}

      {placeBox && (
        <div
          className="marquee is-placement"
          style={{
            left: (placeBox.x - viewport.origin.x) * viewport.zoom,
            top: (placeBox.y - viewport.origin.y) * viewport.zoom,
            width: placeBox.width * viewport.zoom,
            height: placeBox.height * viewport.zoom
          }}
        >
          <span className="placement-size">
            {Math.round(placeBox.width)} × {Math.round(placeBox.height)}
          </span>
        </div>
      )}

      {/* Fora da .nodes-layer: é UI de tela, não conteúdo do canvas — dentro
          dela ele seria transformado junto no pan e no zoom. */}
      <Minimap />

      {formatTarget && <FormatBar key={formatTarget.id} node={formatTarget} />}

      {actionTarget && <NodeActionBar key={actionTarget.id} node={actionTarget} />}

      {groupMenu && menuGroup && (
        <GroupMenu
          group={menuGroup}
          screen={groupMenu.screen}
          onClose={() => setGroupMenu(null)}
          onRename={() => {
            setGroupMenu(null)
            setEditingGroup(menuGroup.id)
          }}
        />
      )}

      {drawMenu && (
        <DrawMenu
          state={drawMenu}
          color={pen.color}
          lineWidth={pen.lineWidth}
          onClose={() => setDrawMenu(null)}
        />
      )}

      {dropped && (
        <ContextMenu x={dropped.screen.x} y={dropped.screen.y}>
          <button
            type="button"
            onClick={() => {
              setDropped(null)
              // O nó nasce com o canto onde o projeto foi solto.
              void store.addProjectToWorkspace(dropped.id, dropped.canvas)
            }}
          >
            Adicionar ao workspace
          </button>
          <button
            type="button"
            onClick={() => {
              const project = projects.find((p) => p.id === dropped.id)
              setDropped(null)
              if (!project) return
              store.openNewTerminal(
                { x: dropped.canvas.x, y: dropped.canvas.y, width: 560, height: 360 },
                project.path
              )
            }}
          >
            Novo agente aqui
          </button>
        </ContextMenu>
      )}

      <Dock />

      {/* Condicionada à preferência, e não escondida por CSS: desligada, a tira
          não é MONTADA, e com ela não existe o `useSystemStats` que assina o
          amostrador. É isso que faz "desligar" custar zero de verdade — ver a
          abertura de monitor-dock.tsx. */}
      {monitorDockVisible && <MonitorDock />}

      <div className="canvas-hud">
        {visibleNodes.length}/{nodes.length} nós · {Math.round(viewport.zoom * 100)}%
      </div>
    </div>
  )
}

/** Distância de um ponto ao segmento (x1,y1)-(x2,y2). */
function pointSegmentDistance(p: Point, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - x1, p.y - y1)
  // t = projeção normalizada do ponto no segmento, presa em [0,1]
  const t = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / lenSq))
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy))
}

/** Não deixa a área cair abaixo do piso do tipo, mantendo o canto de origem. */
function clampToMin(rect: Rect, min?: [number, number]): Rect {
  if (!min) return rect
  return { ...rect, width: Math.max(rect.width, min[0]), height: Math.max(rect.height, min[1]) }
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}
