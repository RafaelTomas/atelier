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
import type { CanvasNode, Point, Rect, UUID } from '@shared/types'
import { ContextMenu } from '../context-menu'
import { FILE_DRAG_TYPE, PROJECT_DRAG_TYPE, readFileDrag } from '../drag'
import { store, useStore } from '../state/store'
import { NodeShell } from '../nodes/node-shell'
import { FormatBar } from '../nodes/format-bar'
import { NodeActionBar } from '../nodes/node-action-bar'
import { Dock } from '../dock'
import { CanvasBackground } from './background'
import { DrawingsLayer, type LiveStroke } from './drawings-layer'
import { DrawMenu, type DrawMenuState } from './draw-menu'
import { ConnectionsLayer } from './connections-layer'
import { ConnectionPreview, canLink } from './connection-preview'
import { CULL_MARGIN, rectsIntersect, viewport } from './viewport'

type Interaction =
  | { kind: 'idle' }
  | { kind: 'panning'; last: Point }
  | { kind: 'mayDrag'; id: UUID; start: Point; frame: Rect }
  | { kind: 'dragging'; id: UUID; start: Point; frame: Rect }
  | { kind: 'resizing'; id: UUID; start: Point; frame: Rect }
  | { kind: 'marquee'; start: Point; current: Point }
  | { kind: 'placing'; start: Point }
  | { kind: 'drawing' }

const DRAG_THRESHOLD = 3 // px de tela antes de virar arrasto de verdade
const CLICK_SLOP = 12 // px de tela: abaixo disso o gesto de área é só um clique

export function CanvasView(): JSX.Element {
  const { workspace, selection, connectingFrom, placing, tool, pen, roles, prefs, terminalStatus, projects } =
    useStore()
  const hostRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<HTMLDivElement>(null)
  const interaction = useRef<Interaction>({ kind: 'idle' })

  /** Centro ao vivo dos nós em arrasto — lido pela camada de cordas a 60fps. */
  const liveFrames = useRef(new Map<UUID, Point>())
  /** Traço em andamento — escrito a 60fps, fora do estado do React. */
  const liveStroke = useRef<LiveStroke | null>(null)
  const strokeTick = useRef(0)
  const [visibleIds, setVisibleIds] = useState<Set<UUID>>(new Set())
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
  /** Espaço segurado: o canvas vira mão e qualquer arrasto é pan. */
  const [spacePan, setSpacePan] = useState(false)
  /** Espaço solto no meio do arrasto — a mão fica até o mouseup. */
  const releasePanOnUp = useRef(false)

  const nodes = workspace?.nodes ?? []
  const connections = workspace?.connections ?? []
  const drawings = workspace?.drawings ?? []
  const isDrawingTool = tool === 'pen' || tool === 'highlighter'
  const customThemes = prefs?.terminalThemes ?? []

  /** id → responsabilidade, para o header do nó não varrer a lista por nó. */
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  /** Cache de z-index: ascendente para render, descendente para hit testing. */
  const { renderOrder, hitOrder } = useMemo(() => {
    const asc = [...nodes].sort((a, b) => a.zIndex - b.zIndex)
    return { renderOrder: asc, hitOrder: [...asc].reverse() }
  }, [nodes])

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

  // ─── Transform + virtualização ──────────────────────────────────────────────

  useEffect(() => {
    return viewport.subscribe(() => {
      if (nodesRef.current) nodesRef.current.style.transform = viewport.transform()

      // Só chama setState quando o CONJUNTO visível muda de fato —
      // sem isso o React re-renderizaria a cada pixel de pan.
      const visible = viewport.visibleRect(CULL_MARGIN)
      const next = new Set<UUID>()
      for (const node of renderOrder) if (rectsIntersect(node.frame, visible)) next.add(node.id)

      setVisibleIds((prev) => {
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev
        return next
      })
    })
  }, [renderOrder])

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
    if (!types.includes(PROJECT_DRAG_TYPE) && !types.includes(FILE_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDrop = (e: React.DragEvent): void => {
    const canvas = viewport.toCanvas(screenPoint(e))

    // Arquivo e pasta agem DIRETO, sem menu: foi o pedido. Um arquivo abre o
    // editor no ponto solto; uma pasta vira nó de árvore, que é o análogo.
    const dragged = e.dataTransfer.getData(FILE_DRAG_TYPE)
    if (dragged) {
      e.preventDefault()
      const payload = readFileDrag(dragged)
      if (!payload) return

      if (payload.isDirectory) void store.addFolderTreeToWorkspace(payload.path, payload.name, canvas)
      else void store.openFileInWorkspace(payload.path, canvas)
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
    if (spacePan && e.button === 0) {
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
    // mouse, então o arrasto move o quadro mesmo começando sobre um nó.
    if (tool === 'pan' && e.button === 0) {
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

    const handle = target.closest('[data-resize-handle]')
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
      if (!selection.includes(node.id)) store.select(e.shiftKey ? [...selection, node.id] : [node.id])
      void store.bringToFront(node.id)
      interaction.current = handle
        ? { kind: 'resizing', id: node.id, start: cp, frame: { ...node.frame } }
        : { kind: 'mayDrag', id: node.id, start: cp, frame: { ...node.frame } }
      return
    }

    store.select([])
    interaction.current = { kind: 'marquee', start: cp, current: cp }
  }

  useEffect(() => {
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
          // Escreve direto no DOM: nada de setState no caminho do mousemove
          const el = nodesRef.current?.querySelector<HTMLElement>(`[data-node-id="${state.id}"]`)
          if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
          liveFrames.current.set(state.id, {
            x: state.frame.x + dx + state.frame.width / 2,
            y: state.frame.y + dy + state.frame.height / 2
          })
          break
        }
        case 'resizing': {
          const el = nodesRef.current?.querySelector<HTMLElement>(`[data-node-id="${state.id}"]`)
          if (el) {
            const w = Math.max(120, state.frame.width + (cp.x - state.start.x))
            const h = Math.max(60, state.frame.height + (cp.y - state.start.y))
            el.style.width = `${w}px`
            el.style.height = `${h}px`
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
          const el = nodesRef.current?.querySelector<HTMLElement>(`[data-node-id="${state.id}"]`)
          if (el) el.style.transform = ''
          liveFrames.current.delete(state.id)
          void store.commitFrame(state.id, {
            ...state.frame,
            x: state.frame.x + dx,
            y: state.frame.y + dy
          })
          break
        }
        case 'resizing': {
          void store.commitFrame(state.id, {
            ...state.frame,
            width: Math.max(120, state.frame.width + (cp.x - state.start.x)),
            height: Math.max(60, state.frame.height + (cp.y - state.start.y))
          })
          break
        }
        case 'marquee': {
          const box = normalizeRect(state.start, cp)
          const hits = nodes.filter((n) => rectsIntersect(n.frame, box)).map((n) => n.id)
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
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // tool/hitDrawing entram aqui: sem eles a borracha apagaria contra uma
    // lista de traços velha (closure obsoleta).
  }, [nodes, tool, hitDrawing])

  // ─── Roda: pan por padrão, zoom com ⌘/Ctrl (convenção de trackpad) ──────────

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      viewport.zoomAt(screenPoint(e), Math.exp(-e.deltaY * 0.01))
    } else {
      viewport.panBy(-e.deltaX, -e.deltaY)
    }
  }

  // ─── Teclado ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName))) return

      if ((e.key === 'Backspace' || e.key === 'Delete') && selection.length > 0) {
        e.preventDefault()
        for (const id of selection) void store.removeNode(id)
      }
      if (e.key === 'Escape') {
        store.cancelPlacing()
        setPlaceBox(null)
        store.startConnecting(null)
        setDrawMenu(null)
        store.setTool('select')
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
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        viewport.setZoom(1)
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
  }, [selection])

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const cp = viewport.toCanvas(screenPoint(e))
    void store.addNode('note', { x: cp.x, y: cp.y })
  }

  const visibleNodes = renderOrder.filter((n) => visibleIds.has(n.id))

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
   * Terminal com seleção única — ganha a barra de ligar/editar/recarregar/
   * excluir. Com vários selecionados a barra não teria um alvo só.
   */
  const actionTarget =
    selection.length === 1
      ? nodes.find((n) => n.id === selection[0] && n.content.type === 'terminal') ?? null
      : null

  return (
    <div
      ref={hostRef}
      className={[
        'canvas-host',
        spacePan ? 'is-space-pan' : '',
        placing ? 'is-placing' : '',
        connectingFrom ? 'is-connecting' : '',
        `tool-${tool}`
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={onMouseDown}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <CanvasBackground mode="grid" />

      <DrawingsLayer drawings={drawings} live={liveStroke} tick={strokeTick} />

      <ConnectionsLayer nodes={nodes} connections={connections} liveFrames={liveFrames} />

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

      {formatTarget && <FormatBar key={formatTarget.id} node={formatTarget} />}

      {actionTarget && <NodeActionBar key={actionTarget.id} node={actionTarget} />}

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
