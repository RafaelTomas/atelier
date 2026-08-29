/**
 * Presets de aparência do terminal: cores do nó e temas do xterm.
 *
 * O "Início Rápido" (nome, comando, ícone) saiu daqui para
 * `@shared/terminal-presets`: o `atelier recruit` cria terminal a partir do
 * main, e o main não importa renderer. O re-export abaixo mantém os dois
 * consumidores de UI com um import só.
 */
import type { TerminalTheme } from '@shared/types'

export { QUICK_STARTS, presetById, type QuickStart } from '@shared/terminal-presets'

/** As oito cores fixas da aba Aparência; a nona é o seletor livre. */
export const NODE_COLORS = [
  '#007AFF',
  '#FF3B30',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#FF2D55',
  '#5AC8FA',
  '#FFCC00'
]

// ─── Temas ────────────────────────────────────────────────────────────────────

export const SYSTEM_THEME_ID = 'system'

export const BUILTIN_THEMES: TerminalTheme[] = [
  { id: SYSTEM_THEME_ID, name: 'Sistema', background: '#101014', foreground: '#e6e6e6' },
  { id: 'dark', name: 'Escuro', background: '#0d0d0f', foreground: '#e6e6e6' },
  { id: 'light', name: 'Claro', background: '#fbfbfd', foreground: '#26262b' }
]

/**
 * Cores do tema "Sistema": os tokens que o CSS já resolve por data-theme /
 * prefers-color-scheme (ver renderer/theme.ts). Ler daqui é o que faz o
 * terminal acompanhar o tema do app junto com o resto da UI — o xterm precisa
 * das cores em JS, ele não enxerga custom properties.
 */
function systemPalette(): TerminalTheme {
  const css = getComputedStyle(document.documentElement)
  const fallback = BUILTIN_THEMES[1]
  return {
    id: SYSTEM_THEME_ID,
    name: 'Sistema',
    background: css.getPropertyValue('--term-bg').trim() || fallback.background,
    foreground: css.getPropertyValue('--term-fg').trim() || fallback.foreground
  }
}

/**
 * Resolve o themeId gravado no nó para cores concretas. 'system' acompanha o
 * tema do app; um id desconhecido (tema personalizado apagado) cai no sistema.
 */
export function resolveTheme(themeId: string | null, custom: TerminalTheme[]): TerminalTheme {
  const id = themeId ?? SYSTEM_THEME_ID
  if (id === SYSTEM_THEME_ID) return systemPalette()
  return (
    BUILTIN_THEMES.find((t) => t.id === id) ??
    custom.find((t) => t.id === id) ??
    systemPalette()
  )
}

// ─── Fonte ────────────────────────────────────────────────────────────────────

export const DEFAULT_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, monospace'
export const DEFAULT_FONT_SIZE = 13

/**
 * O Electron não expõe seletor de fonte nativo, então a lista é fixa: fontes
 * monoespaçadas presentes por padrão em pelo menos um dos três sistemas, com
 * fallback genérico em toda entrada.
 */
export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: 'Padrão do sistema', value: DEFAULT_FONT_FAMILY },
  { label: 'SF Mono', value: '"SF Mono", ui-monospace, monospace' },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", monospace' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'Ubuntu Mono', value: '"Ubuntu Mono", monospace' },
  { label: 'Courier New', value: '"Courier New", monospace' }
]

export function fontLabel(value: string | null): string {
  if (!value) return FONT_CHOICES[0].label
  return FONT_CHOICES.find((f) => f.value === value)?.label ?? value
}
