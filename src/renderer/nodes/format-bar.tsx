/**
 * Barra de formatação flutuante do nó selecionado (Text ou Nota).
 *
 * Vive FORA do contêiner transformado do canvas: é posicionada em coordenadas
 * de tela e reposicionada no callback do viewport, para não escalar junto com
 * o zoom (a 300% uma barra escalada cobriria metade da tela) e para não
 * re-renderizar a árvore de nós a cada pan.
 */
import { useEffect, useRef, useState } from 'react'
import type { CanvasNode, FontFamily, FontWeight, TextAlignment } from '@shared/types'
import { viewport } from '../canvas/viewport'
import { store } from '../state/store'
import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_STEPS,
  FONT_WEIGHT_OPTIONS,
  SURFACE_COLORS,
  TEXT_COLORS,
  clampFontSize,
  contrastingText,
  stepFontSize
} from './typography'

const BAR_GAP = 10 // px de tela entre o topo do nó e a barra

type Popover = 'color' | 'background' | 'font' | null

interface Props {
  node: CanvasNode
}

export function FormatBar({ node }: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [popover, setPopover] = useState<Popover>(null)

  // Posição segue o pan/zoom sem passar pelo React (regra §5).
  useEffect(() => {
    const place = (): void => {
      const el = ref.current
      if (!el) return
      const { frame } = node
      const topLeft = viewport.toScreen({ x: frame.x, y: frame.y })
      const width = frame.width * viewport.zoom
      el.style.left = `${topLeft.x + width / 2}px`
      el.style.top = `${topLeft.y - BAR_GAP}px`
    }
    place()
    return viewport.subscribe(place)
  }, [node.frame.x, node.frame.y, node.frame.width])

  // Trocar de nó não deve manter um popover aberto do nó anterior.
  useEffect(() => setPopover(null), [node.id])

  const patch = (p: Record<string, unknown>): void => void store.patchContent(node.id, p)

  const body = ((): JSX.Element | null => {
    if (node.content.type === 'text') {
      return <TextControls node={node} content={node.content.value} patch={patch}
        popover={popover} setPopover={setPopover} />
    }
    if (node.content.type === 'stickyNote') {
      return <NoteControls content={node.content.value} patch={patch}
        popover={popover} setPopover={setPopover} />
    }
    return null
  })()

  if (!body) return null

  return (
    <div
      ref={ref}
      className="format-bar"
      data-node-interactive
      // O canvas trata mousedown como início de arrasto/deseleção; a barra é
      // chrome, então engole o evento antes de ele chegar lá.
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {body}
    </div>
  )
}

// ─── Controles do nó Text ─────────────────────────────────────────────────────

interface ControlProps {
  patch: (p: Record<string, unknown>) => void
  popover: Popover
  setPopover: (p: Popover) => void
}

function TextControls({
  node,
  content,
  patch,
  popover,
  setPopover
}: ControlProps & { node: CanvasNode; content: import('@shared/types').TextContent }): JSX.Element {
  return (
    <>
      <FontPicker
        family={content.fontFamily}
        weight={content.fontWeight}
        onFamily={(fontFamily) => patch({ fontFamily })}
        onWeight={(fontWeight) => patch({ fontWeight })}
        open={popover === 'font'}
        toggle={() => setPopover(popover === 'font' ? null : 'font')}
      />

      <span className="fb-sep" />

      <SizeStepper
        size={content.fontSize}
        onSize={(fontSize) => patch({ fontSize })}
      />

      <span className="fb-sep" />

      <ColorButton
        title="Cor do texto"
        swatch={content.color}
        glyph="A"
        open={popover === 'color'}
        toggle={() => setPopover(popover === 'color' ? null : 'color')}
        colors={TEXT_COLORS}
        selected={content.color}
        onPick={(color) => {
          patch({ color })
          setPopover(null)
        }}
      />

      <ColorButton
        title="Cor de fundo"
        swatch={content.backgroundColor ?? 'transparent'}
        glyph="◧"
        open={popover === 'background'}
        toggle={() => setPopover(popover === 'background' ? null : 'background')}
        colors={SURFACE_COLORS}
        selected={content.backgroundColor}
        onPick={(backgroundColor) => {
          patch({ backgroundColor })
          setPopover(null)
        }}
        onClear={() => {
          patch({ backgroundColor: null })
          setPopover(null)
        }}
      />

      <span className="fb-sep" />

      <button
        type="button"
        className={`icon-btn fb-btn${content.fontWeight === 'bold' ? ' is-on' : ''}`}
        title="Negrito"
        style={{ fontWeight: 700 }}
        onClick={() => patch({ fontWeight: content.fontWeight === 'bold' ? 'regular' : 'bold' })}
      >
        B
      </button>
      <button
        type="button"
        className={`icon-btn fb-btn${content.isItalic ? ' is-on' : ''}`}
        title="Itálico"
        style={{ fontStyle: 'italic', fontFamily: 'ui-serif, Georgia, serif' }}
        onClick={() => patch({ isItalic: !content.isItalic })}
      >
        I
      </button>
      <button
        type="button"
        className={`icon-btn fb-btn${content.isUnderlined ? ' is-on' : ''}`}
        title="Sublinhado"
        style={{ textDecoration: 'underline' }}
        onClick={() => patch({ isUnderlined: !content.isUnderlined })}
      >
        U
      </button>
      <button
        type="button"
        className={`icon-btn fb-btn${content.isStrikethrough ? ' is-on' : ''}`}
        title="Riscado"
        style={{ textDecoration: 'line-through' }}
        onClick={() => patch({ isStrikethrough: !content.isStrikethrough })}
      >
        S
      </button>

      <span className="fb-sep" />

      <AlignGroup value={content.alignment} onPick={(alignment) => patch({ alignment })} />

      <span className="fb-sep" />

      <button
        type="button"
        className="icon-btn fb-btn"
        title="Ajustar altura ao texto"
        onClick={() => void fitHeight(node, content)}
      >
        ⇕
      </button>
    </>
  )
}

/**
 * Recalcula a altura do nó medindo o texto renderizado. Sem isso, aumentar a
 * fonte deixa o rótulo cortado dentro do frame antigo.
 */
async function fitHeight(
  node: CanvasNode,
  content: import('@shared/types').TextContent
): Promise<void> {
  const el = document.querySelector(`[data-node-id="${node.id}"] .text-node-measure`)
  const measured = el?.scrollHeight ?? content.fontSize * content.lineHeight
  const height = Math.max(24, Math.ceil(measured) + 8)
  if (Math.abs(height - node.frame.height) < 2) return
  await store.commitFrame(node.id, { ...node.frame, height })
}

// ─── Controles da Nota ────────────────────────────────────────────────────────

function NoteControls({
  content,
  patch,
  popover,
  setPopover
}: ControlProps & { content: import('@shared/types').StickyNoteContent }): JSX.Element {
  return (
    <>
      <FontPicker
        family={content.fontFamily}
        onFamily={(fontFamily) => patch({ fontFamily })}
        open={popover === 'font'}
        toggle={() => setPopover(popover === 'font' ? null : 'font')}
      />

      <span className="fb-sep" />

      <SizeStepper size={content.fontSize} onSize={(fontSize) => patch({ fontSize })} />

      <span className="fb-sep" />

      <ColorButton
        title="Cor do texto"
        swatch={content.textColor ?? contrastingText(content.color)}
        glyph="A"
        open={popover === 'color'}
        toggle={() => setPopover(popover === 'color' ? null : 'color')}
        colors={TEXT_COLORS}
        selected={content.textColor}
        onPick={(textColor) => {
          patch({ textColor })
          setPopover(null)
        }}
        onClear={() => {
          patch({ textColor: null })
          setPopover(null)
        }}
        clearLabel="Automática"
      />

      <ColorButton
        title="Cor do papel"
        swatch={content.color}
        glyph="◧"
        open={popover === 'background'}
        toggle={() => setPopover(popover === 'background' ? null : 'background')}
        colors={SURFACE_COLORS}
        selected={content.color}
        onPick={(color) => {
          patch({ color })
          setPopover(null)
        }}
      />

      <span className="fb-sep" />

      <AlignGroup value={content.alignment} onPick={(alignment) => patch({ alignment })} />
    </>
  )
}

// ─── Peças reutilizáveis ──────────────────────────────────────────────────────

function SizeStepper({
  size,
  onSize
}: {
  size: number
  onSize: (n: number) => void
}): JSX.Element {
  return (
    <div className="fb-stepper">
      <button type="button" className="icon-btn fb-btn" title="Diminuir" onClick={() => onSize(stepFontSize(size, -1))}>
        −
      </button>
      <select
        className="fb-size"
        title="Tamanho"
        value={FONT_SIZE_STEPS.includes(size) ? String(size) : 'custom'}
        onChange={(e) => onSize(clampFontSize(Number(e.target.value)))}
      >
        {!FONT_SIZE_STEPS.includes(size) && (
          <option value="custom">{size}</option>
        )}
        {FONT_SIZE_STEPS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <button type="button" className="icon-btn fb-btn" title="Aumentar" onClick={() => onSize(stepFontSize(size, 1))}>
        +
      </button>
    </div>
  )
}

function AlignGroup({
  value,
  onPick
}: {
  value: TextAlignment
  onPick: (a: TextAlignment) => void
}): JSX.Element {
  const options: { value: TextAlignment; glyph: string; title: string }[] = [
    { value: 'left', glyph: '⤒', title: 'Alinhar à esquerda' },
    { value: 'center', glyph: '↕', title: 'Centralizar' },
    { value: 'right', glyph: '⤓', title: 'Alinhar à direita' }
  ]
  return (
    <div className="fb-group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`icon-btn fb-btn${value === o.value ? ' is-on' : ''}`}
          data-align={o.value}
          title={o.title}
          onClick={() => onPick(o.value)}
        >
          <span className="fb-align-glyph" aria-hidden />
        </button>
      ))}
    </div>
  )
}

function FontPicker({
  family,
  weight,
  onFamily,
  onWeight,
  open,
  toggle
}: {
  family: FontFamily
  weight?: FontWeight
  onFamily: (f: FontFamily) => void
  onWeight?: (w: FontWeight) => void
  open: boolean
  toggle: () => void
}): JSX.Element {
  const label = FONT_FAMILY_OPTIONS.find((o) => o.value === family)?.label ?? 'Sans'
  return (
    <div className="fb-pop-host">
      <button type="button" className={`icon-btn fb-btn fb-wide${open ? ' is-on' : ''}`} title="Fonte" onClick={toggle}>
        {label} <span className="fb-caret">▾</span>
      </button>
      {open && (
        <div className="fb-popover">
          <div className="fb-popover-title">Fonte</div>
          <div className="fb-list">
            {FONT_FAMILY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`fb-row${family === o.value ? ' is-on' : ''}`}
                data-family={o.value}
                onClick={() => onFamily(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {onWeight && weight && (
            <>
              <div className="fb-popover-title">Peso</div>
              <div className="fb-list">
                {FONT_WEIGHT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`fb-row${weight === o.value ? ' is-on' : ''}`}
                    onClick={() => onWeight(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ColorButton({
  title,
  swatch,
  glyph,
  open,
  toggle,
  colors,
  selected,
  onPick,
  onClear,
  clearLabel = 'Nenhuma'
}: {
  title: string
  swatch: string
  glyph: string
  open: boolean
  toggle: () => void
  colors: { value: string; label: string }[]
  selected: string | null
  onPick: (c: string) => void
  onClear?: () => void
  clearLabel?: string
}): JSX.Element {
  return (
    <div className="fb-pop-host">
      <button
        type="button"
        className={`icon-btn fb-btn fb-color${open ? ' is-on' : ''}`}
        title={title}
        onClick={toggle}
      >
        <span className="fb-color-glyph">{glyph}</span>
        <span
          className={`fb-color-chip${swatch === 'transparent' ? ' is-empty' : ''}`}
          style={{ background: swatch }}
        />
      </button>
      {open && (
        <div className="fb-popover">
          <div className="fb-popover-title">{title}</div>
          <div className="fb-swatches">
            {colors.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`fb-swatch${selected?.toLowerCase() === c.value.toLowerCase() ? ' is-on' : ''}`}
                style={{ background: c.value }}
                title={c.label}
                onClick={() => onPick(c.value)}
              />
            ))}
          </div>
          <div className="fb-popover-foot">
            <label className="fb-custom">
              Personalizada
              <input
                type="color"
                value={selected ?? '#000000'}
                onChange={(e) => onPick(e.target.value)}
              />
            </label>
            {onClear && (
              <button type="button" className="fb-clear" onClick={onClear}>
                {clearLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
