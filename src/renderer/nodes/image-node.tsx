/**
 * Nó Imagem — uma imagem colada, arrastada do sistema ou publicada por um
 * agente (`atelier image`).
 *
 * Os bytes vivem em `images/<id>.<ext>` (arquivo gerenciado, padrão da nota e da
 * tabela); o nó lê o data URL pelo canal `image:read` e reassina `image:changed`
 * para o `atelier image` refletir sem recarregar o canvas.
 *
 * `data-node-interactive` no contêiner: o canvas não rouba o clique nem o scroll
 * de dentro do nó. Tema pelos tokens `--term-bg` / `--term-fg`, igual à tabela.
 */
import { useEffect, useState } from 'react'
import type { CanvasNode, ImageContent, UUID } from '@shared/types'

interface Props {
  node: CanvasNode
  content: ImageContent
  workspaceId: UUID
}

export function ImageNode({ node, content, workspaceId }: Props): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fileName = content.fileName

  useEffect(() => {
    if (!fileName) {
      setError('esta imagem não tem arquivo')
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      const result = await window.atelier.image.read(workspaceId, fileName)
      if (!alive) return
      if ('error' in result) {
        setError(result.error === 'missing' ? 'arquivo da imagem não encontrado' : result.error)
        return
      }
      setError(null)
      setDataUrl(result.dataUrl)
    }
    void load()

    const off = window.atelier.image.onChanged((p) => {
      if (p.nodeId === node.id) void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [fileName, workspaceId, node.id])

  const copy = (): void => {
    const blob = dataUrl ? dataUrlToBlob(dataUrl) : null
    if (!blob) return
    void (async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {
        /* sem permissão de clipboard — silencioso, o botão só não confirma */
      }
    })()
  }

  const dims =
    content.naturalWidth > 0 && content.naturalHeight > 0
      ? `${content.naturalWidth} × ${content.naturalHeight}`
      : null

  return (
    <div className="image-node" data-node-interactive>
      <div className="image-node-bar">
        <span className="image-node-title" title={content.title}>
          {content.title}
        </span>
        {dims && <span className="image-node-dims">{dims}</span>}
        <div className="image-node-actions">
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Copiar imagem"
            disabled={!dataUrl}
            onClick={copy}
          >
            {copied ? '✓' : 'copiar'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="image-node-empty">{error}</div>
      ) : !dataUrl ? (
        <div className="image-node-empty">carregando…</div>
      ) : (
        <div className="image-node-canvas">
          <img src={dataUrl} alt={content.alt || content.title} draggable={false} />
        </div>
      )}
    </div>
  )
}

/** Rótulo do nó no header. */
export function imageLabel(content: ImageContent): string {
  return content.title || 'Imagem'
}

/** `data:<mime>;base64,<…>` → Blob, sem `fetch` (a CSP bloqueia fetch de data:). */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const [, mime, isBase64, data] = match
  try {
    if (isBase64) {
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(data)], { type: mime })
  } catch {
    return null
  }
}
