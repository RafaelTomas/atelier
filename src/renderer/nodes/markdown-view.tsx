/**
 * Visualizador de Markdown — a superfície de leitura compartilhada pelo nó Nota
 * (modo prever) e pelo nó Editor de Código quando o arquivo é `.md`.
 *
 * O HTML vem do conversor sem-dependência de `markdown.ts`, que escapa todo o
 * texto antes de montar a marcação — nada do que o usuário escreveu chega ao DOM
 * como tag. Ainda assim o clique em link é interceptado: só `http(s)` abre, e
 * abre no navegador do sistema, nunca dentro do app.
 *
 * O tema (claro / GitHub dark) é 100% CSS, via `data-theme` no <html> — ver
 * styles/nodes/markdown-view.css. Este componente não lê o tema.
 */
import { useMemo } from 'react'
import { renderMarkdown } from './markdown'

interface Props {
  source: string
  /** `is-standalone` pinta o fundo (editor); `is-note` fica transparente. */
  variant: 'standalone' | 'note'
}

export function MarkdownView({ source, variant }: Props): JSX.Element {
  const html = useMemo(() => renderMarkdown(source), [source])

  const onClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) void window.atelier.portal.openExternal(href)
  }

  return (
    <div
      className={`markdown-body is-${variant}`}
      data-node-interactive
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
