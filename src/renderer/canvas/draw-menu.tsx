/**
 * Menu do modo desenho — abre NO PONTO clicado dentro do canvas.
 *
 * O modo 'draw' (dock) não desenha nada por si: o clique pergunta o que fazer
 * ali. Escolher caneta/marca-texto/borracha troca a ferramenta ativa e o
 * próximo arrasto já desenha; as formas prontas (linha, seta, retângulo,
 * elipse) são gravadas na hora como traço, centradas no ponto do clique.
 *
 * Posicionado em coordenadas de TELA (position: fixed): o menu não deve
 * escalar nem deslizar com pan/zoom enquanto está aberto.
 */
import { useEffect } from 'react'
import type { Point } from '@shared/types'
import {
  IconArrow,
  IconEllipse,
  IconEraser,
  IconHighlighter,
  IconLine,
  IconPen,
  IconRect,
  IconTrash
} from '../icons'
import { store, type DrawTool } from '../state/store'

/** Paleta curta: o suficiente para anotar sem virar um seletor de cor. */
const PALETTE = ['#e0245e', '#f5a623', '#f8e71c', '#2ecc71', '#007aff', '#1a1a1a']

/** Lado do bounding box das formas prontas, em coordenadas de canvas. */
const SHAPE_SIZE = 160

export interface DrawMenuState {
  /** Onde abrir, em coordenadas de tela (relativas à janela). */
  screen: Point
  /** Onde a forma pronta nasce, em coordenadas de canvas. */
  canvas: Point
}

interface Props {
  state: DrawMenuState
  /** Cor e espessura atuais, para marcar o que está selecionado. */
  color: string
  lineWidth: number
  onClose: () => void
}

export function DrawMenu({ state, color, lineWidth, onClose }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Ativa a ferramenta e fecha: o próximo arrasto no canvas já desenha. */
  const pick = (tool: DrawTool): void => {
    store.setTool(tool)
    onClose()
  }

  /** Grava a forma direto, centrada no ponto clicado. */
  const shape = (points: Point[]): void => {
    void store.addDrawing(
      points.map((p) => [p.x, p.y]),
      color,
      lineWidth
    )
    onClose()
  }

  const { x, y } = state.canvas
  const h = SHAPE_SIZE / 2

  return (
    <div
      className="dock-menu draw-menu"
      role="menu"
      style={{ left: state.screen.x, top: state.screen.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="dock-menu-title">Desenhar aqui</div>

      <button type="button" role="menuitem" onClick={() => pick('pen')}>
        <IconPen size={15} />
        <span className="dock-menu-label">Traço livre</span>
        <span className="dock-menu-hint">arraste</span>
      </button>
      <button type="button" role="menuitem" onClick={() => pick('highlighter')}>
        <IconHighlighter size={15} />
        <span className="dock-menu-label">Marca-texto</span>
        <span className="dock-menu-hint">arraste</span>
      </button>

      <div className="dock-menu-sep" />

      <button
        type="button"
        role="menuitem"
        onClick={() =>
          shape([
            { x: x - h, y },
            { x: x + h, y }
          ])
        }
      >
        <IconLine size={15} />
        <span className="dock-menu-label">Linha</span>
      </button>
      <button type="button" role="menuitem" onClick={() => shape(arrowPoints(x, y, h))}>
        <IconArrow size={15} />
        <span className="dock-menu-label">Seta</span>
      </button>
      <button type="button" role="menuitem" onClick={() => shape(rectPoints(x, y, h))}>
        <IconRect size={15} />
        <span className="dock-menu-label">Retângulo</span>
      </button>
      <button type="button" role="menuitem" onClick={() => shape(ellipsePoints(x, y, h))}>
        <IconEllipse size={15} />
        <span className="dock-menu-label">Elipse</span>
      </button>

      <div className="dock-menu-sep" />

      <div className="draw-menu-row">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={color === c ? 'swatch is-active' : 'swatch'}
            style={{ background: c }}
            title={`Cor ${c}`}
            onClick={() => store.setPen({ color: c })}
          />
        ))}
      </div>
      <div className="draw-menu-row">
        <input
          type="range"
          className="pen-width"
          min={1}
          max={12}
          step={1}
          value={lineWidth}
          title={`Espessura ${lineWidth}`}
          onChange={(e) => store.setPen({ lineWidth: Number(e.target.value) })}
        />
        <span className="draw-menu-width">{lineWidth}px</span>
      </div>

      <div className="dock-menu-sep" />

      <button type="button" role="menuitem" onClick={() => pick('eraser')}>
        <IconEraser size={15} />
        <span className="dock-menu-label">Borracha</span>
        <span className="dock-menu-hint">E</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        onClick={() => {
          void store.clearDrawings()
          onClose()
        }}
      >
        <IconTrash size={15} />
        <span className="dock-menu-label">Limpar desenhos</span>
      </button>
    </div>
  )
}

/** Seta apontando para a direita: haste mais as duas barbas, em um traço só. */
function arrowPoints(x: number, y: number, h: number): Point[] {
  const tip = { x: x + h, y }
  const barb = h * 0.28
  return [
    { x: x - h, y },
    tip,
    { x: tip.x - barb, y: y - barb },
    tip,
    { x: tip.x - barb, y: y + barb }
  ]
}

/** Retângulo fechado — o traço volta ao primeiro ponto. */
function rectPoints(x: number, y: number, h: number): Point[] {
  const w = h * 1.3
  return [
    { x: x - w, y: y - h },
    { x: x + w, y: y - h },
    { x: x + w, y: y + h },
    { x: x - w, y: y + h },
    { x: x - w, y: y - h }
  ]
}

/** Elipse aproximada por 48 segmentos — o suficiente para não ver a facetagem. */
function ellipsePoints(x: number, y: number, h: number): Point[] {
  const rx = h * 1.3
  const steps = 48
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    points.push({ x: x + Math.cos(t) * rx, y: y + Math.sin(t) * h })
  }
  return points
}
