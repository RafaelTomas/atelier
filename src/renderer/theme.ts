/**
 * Aplicação do tema no DOM.
 *
 * O CSS resolve tudo por tokens (ver styles.css): só precisamos escrever
 * data-theme no <html>. 'system' REMOVE o atributo, deixando o
 * prefers-color-scheme decidir — não existe data-theme="system".
 */
export type ThemeMode = 'system' | 'light' | 'dark'

export function isThemeMode(value: string): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)

  // Faz o Chromium pintar scrollbars e form controls no esquema certo, e
  // define o que prefers-color-scheme responde dentro dos <webview>.
  root.style.colorScheme = mode === 'system' ? 'light dark' : mode
}

/** O tema efetivo — 'system' resolvido pelo que o SO está pedindo agora. */
export function effectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
