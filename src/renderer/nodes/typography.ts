/**
 * Vocabulário de tipografia compartilhado pelos nós de texto/nota e pela
 * barra de formatação.
 *
 * As paletas ficam aqui, e não no CSS, porque a barra precisa desenhar as
 * amostras e o nó precisa gravar o valor no conteúdo — os dois leem a mesma
 * lista, então nunca saem de sincronia.
 */
import type { CSSProperties } from 'react'
import type { FontFamily, FontWeight, StickyNoteContent, TextContent } from '@shared/types'

// ─── Fontes ───────────────────────────────────────────────────────────────────

export const FONT_STACKS: Record<FontFamily, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  rounded: '"SF Pro Rounded", ui-rounded, "Nunito", "Avenir Next", system-ui, sans-serif'
}

export const FONT_FAMILY_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
  { value: 'rounded', label: 'Rounded' }
]

export const FONT_WEIGHT_VALUES: Record<FontWeight, number> = {
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700
}

export const FONT_WEIGHT_OPTIONS: { value: FontWeight; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'regular', label: 'Regular' },
  { value: 'medium', label: 'Medium' },
  { value: 'semibold', label: 'Semibold' },
  { value: 'bold', label: 'Bold' }
]

// ─── Tamanhos ─────────────────────────────────────────────────────────────────

/** Degraus do stepper — o mesmo conjunto do seletor rápido. */
export const FONT_SIZE_STEPS = [11, 12, 14, 16, 18, 24, 32, 40, 56, 72, 96]

export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 200

export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

/** Próximo/anterior degrau; fora da lista, anda de 1 em 1 até encostar num. */
export function stepFontSize(current: number, direction: 1 | -1): number {
  const steps = direction === 1 ? FONT_SIZE_STEPS : [...FONT_SIZE_STEPS].reverse()
  const next = steps.find((s) => (direction === 1 ? s > current : s < current))
  return clampFontSize(next ?? current + direction)
}

// ─── Cores ────────────────────────────────────────────────────────────────────

export interface Swatch {
  value: string
  label: string
}

/** Cores de texto — tons que funcionam sobre fundo claro e escuro. */
export const TEXT_COLORS: Swatch[] = [
  { value: '#1a1a1a', label: 'Preto' },
  { value: '#6b6b70', label: 'Cinza' },
  { value: '#ffffff', label: 'Branco' },
  { value: '#e0245e', label: 'Rosa' },
  { value: '#e74c3c', label: 'Vermelho' },
  { value: '#f39c12', label: 'Laranja' },
  { value: '#f1c40f', label: 'Amarelo' },
  { value: '#2ecc71', label: 'Verde' },
  { value: '#1abc9c', label: 'Turquesa' },
  { value: '#007aff', label: 'Azul' },
  { value: '#5856d6', label: 'Índigo' },
  { value: '#af52de', label: 'Violeta' }
]

/** Fundos de nota / realce de texto — pastéis, para o texto continuar legível. */
export const SURFACE_COLORS: Swatch[] = [
  { value: '#FEFDE8', label: 'Amarelo' },
  { value: '#FFF1E6', label: 'Pêssego' },
  { value: '#FFE8EC', label: 'Rosa' },
  { value: '#F3E8FF', label: 'Lilás' },
  { value: '#E6F0FF', label: 'Azul' },
  { value: '#E3F9F2', label: 'Menta' },
  { value: '#EEF7DC', label: 'Lima' },
  { value: '#F2F2F5', label: 'Cinza' },
  { value: '#2A2A30', label: 'Grafite' }
]

/**
 * Luminância relativa (WCAG) para escolher texto preto ou branco sobre um
 * fundo arbitrário — o usuário pode escolher grafite e o texto preto padrão
 * ficaria ilegível.
 */
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (full.length !== 6) return 1
  const channel = (i: number): number => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** Cor de texto legível sobre `background`. */
export function contrastingText(background: string): string {
  return luminance(background) > 0.45 ? '#2a2a2a' : '#f0f0f2'
}

// ─── Estilos derivados ────────────────────────────────────────────────────────

/** CSS do nó Text — a mesma função serve ao modo leitura e ao editor. */
export function textNodeStyle(content: TextContent): CSSProperties {
  const decorations = [
    content.isUnderlined ? 'underline' : '',
    content.isStrikethrough ? 'line-through' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return {
    fontSize: content.fontSize,
    fontWeight: FONT_WEIGHT_VALUES[content.fontWeight] ?? 400,
    fontFamily: FONT_STACKS[content.fontFamily] ?? FONT_STACKS.sans,
    fontStyle: content.isItalic ? 'italic' : 'normal',
    textDecoration: decorations || 'none',
    color: content.color,
    textAlign: content.alignment,
    lineHeight: content.lineHeight,
    letterSpacing: `${content.letterSpacing}px`
  }
}

/** CSS do editor de nota. */
export function noteEditorStyle(content: StickyNoteContent): CSSProperties {
  return {
    backgroundColor: content.color,
    color: content.textColor ?? contrastingText(content.color),
    fontSize: content.fontSize,
    fontFamily: FONT_STACKS[content.fontFamily] ?? FONT_STACKS.mono,
    textAlign: content.alignment
  }
}
