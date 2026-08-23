/**
 * Camada de canvas — porte de CanvasViewportView.
 *
 * Empilhamento (mesma ordem do app nativo):
 *   1 fundo/grade   2 (desenho — pendente)   3 nós   4 conexões   5 guias
 *
 * As três regras de performance de docs/migracao-electron.md §5 estão aqui:
 *   • virtualização por viewport (+200px), só o set visível vai para o React
 *   • hit testing por lista ordenada por z-index, nunca elementFromPoint
 *   • arrasto escreve em style.transform direto, fora do ciclo do React
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasNode, Point, Rect, UUID } from '@shared/types'
import { store, useStore } from '../state/store'
import { NodeShell } from '../nodes/node-shell'
import { CanvasBackground } from './background'
import { ConnectionsLayer } from './connections-layer'
import { CULL_MARGIN, rectsIntersect, viewport } from './viewport'

type Interaction =
  | { kind: 'idle' }
  | { kind: 'panning'; last: Point }
  | { kind: 'mayDrag'; id: UUID; start: Point; frame: Rect }
  | { kind: 'dragging'; id: UUID; start: Point; frame: Rect }
  | { kind: 'resizing'; id: UUID; start: Point; frame: Rect }
  | { kind: 'marquee'; start: Point; current: Point }
  | { kind: 'connecting'; from: UUID; current: Point }

const DRAG_THRESHOLD = 3 // px de tela antes de virar arrasto de verdade

export function CanvasView(): JSX.Element {
  const { workspace, selection, connectingFrom } = useStore()
  const hostRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef<HTMLDivElement>(null)
  const interaction = useRef<Interaction>({ kind: 'idle' })

  /** Centro ao vivo dos nós em arrasto — lido pela camada de cordas a 60fps. */
  const liveFrames = useRef(new Map<UUID, Point>())
  const [visibleIds, setVisibleIds] = useState<Set<UUID>>(new Set())
  const [marquee, setMarquee] = useState<Rect | null>(null)

  const nodes = workspace?.nodes ?? []
  const connections = workspace?.connections ?? []

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

  const screenPoint = (e: React.MouseEvent | MouseEvent): Point => {
    const rect = hostRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  // ─── Mouse ──────────────────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      interaction.current = { kind: 'panning', last: screenPoint(e) }
      return
    }
    if (e.button !== 0) return

    const target = e.target as HTMLElement
    // Cliques dentro do conteúdo do nó (terminal, editor) são do nó, não do canvas
    if (target.closest('[data-node-interactive]')) return

    const sp = screenPoint(e)
    const cp = viewport.toCanvas(sp)

    const handle = target.closest('[data-resize-handle]')
    const nodeEl = target.closest('[data-node-id]') as HTMLElement | null
    const nodeId = nodeEl?.dataset.nodeId as UUID | undefined
    const node = nodeId ? nodes.find((n) => n.id === nodeId) : hitTest(cp)

    if (connectingFrom && node) {
      void store.addConnection(connectingFrom, node.id)
      store.startConnecting(null)
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
        case 'connecting': {
          interaction.current = { ...state, current: cp }
          break
        }
      }
    }

    const onUp = (e: MouseEvent): void => {
      const state = interaction.current
      interaction.current = { kind: 'idle' }
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
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [nodes])

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
      if (e.key === 'Escape') store.startConnecting(null)
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        viewport.setZoom(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection])

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const cp = viewport.toCanvas(screenPoint(e))
    void store.addNode('note', { x: cp.x, y: cp.y })
  }

  const visibleNodes = renderOrder.filter((n) => visibleIds.has(n.id))

  return (
    <div
      ref={hostRef}
      className={`canvas-host ${connectingFrom ? 'is-connecting' : ''}`}
      onMouseDown={onMouseDown}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      <CanvasBackground mode="grid" />

      <ConnectionsLayer nodes={nodes} connections={connections} liveFrames={liveFrames} />

      <div ref={nodesRef} className="nodes-layer">
        {visibleNodes.map((node) => (
          <NodeShell
            key={node.id}
            node={node}
            selected={selection.includes(node.id)}
            workspaceId={workspace?.id ?? ''}
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

      <div className="canvas-hud">
        {visibleNodes.length}/{nodes.length} nós · {Math.round(viewport.zoom * 100)}%
      </div>
    </div>
  )
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}
