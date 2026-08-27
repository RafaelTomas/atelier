export { quoteForShell } from '@shared/shell'

/** Encurtamento de caminhos para exibição. Extraído do diálogo de terminal. */
export function shortenPath(path: string): string {
  if (!path) return ''
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/)
  return home ? `~${path.slice(home[0].length)}` : path
}

/** Corta pelo início: num caminho, o fim é a parte informativa. */
export function truncateStart(path: string, max = 42): string {
  const short = shortenPath(path)
  return short.length <= max ? short : `…${short.slice(short.length - max + 1)}`
}
