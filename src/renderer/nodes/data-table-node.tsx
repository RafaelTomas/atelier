/**
 * Nó Tabela de Resultado — a grade de uma query publicada por um agente.
 *
 * Fase 1 é snapshot: os dados vêm de `tables/<id>.json`, gravado pelo
 * `atelier table`. O nó só lê. Reassina em `table:changed` (padrão do
 * note-node), para o `atelier table append` refletir sem recarregar o canvas.
 *
 * `data-node-interactive` no contêiner: o canvas não rouba scroll nem clique de
 * dentro da grade. Tema pelos tokens `--term-bg` / `--term-fg` / `--text-dim`,
 * igual ao editor de código.
 */
import { useEffect, useState } from 'react'
import type { CanvasNode, DataTableContent, UUID } from '@shared/types'
import type { DataTablePayload } from '@shared/data-table'
import { toCSV } from '@shared/data-table'

interface Props {
  node: CanvasNode
  content: DataTableContent
  workspaceId: UUID
}

export function DataTableNode({ node, content, workspaceId }: Props): JSX.Element {
  const [payload, setPayload] = useState<DataTablePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [queryOpen, setQueryOpen] = useState(false)
  const fileName = content.fileName

  useEffect(() => {
    if (!fileName) {
      setError('esta tabela não tem arquivo')
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      const data = await window.atelier.table.read(workspaceId, fileName)
      if (!alive) return
      if (!data || !Array.isArray(data.columns)) {
        setError('não foi possível ler os dados desta tabela')
        return
      }
      setError(null)
      setPayload(data)
    }
    void load()

    const off = window.atelier.table.onChanged((p) => {
      if (p.nodeId === node.id) void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [fileName, workspaceId, node.id])

  const copyCSV = (): void => {
    if (!payload) return
    void navigator.clipboard.writeText(toCSV(payload)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const columns = payload?.columns ?? []
  const rows = payload?.rows ?? []

  return (
    <div className="data-table" data-node-interactive>
      <div className="data-table-bar">
        <span className="data-table-title" title={content.title}>
          {content.title}
        </span>
        <span className="data-table-dims">
          {content.rowCount} linhas × {content.columnCount} colunas
        </span>
        {content.dialect && <span className="data-table-badge">{content.dialect}</span>}
        {(payload?.truncated ?? content.truncated) && (
          <span className="data-table-badge is-warn" title="O resultado foi cortado no teto de linhas/células">
            truncado
          </span>
        )}
        <div className="data-table-actions">
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Copiar como CSV"
            disabled={!payload}
            onClick={copyCSV}
          >
            {copied ? '✓' : 'CSV'}
          </button>
        </div>
      </div>

      {content.query && (
        <details
          className="data-table-query"
          open={queryOpen}
          onToggle={(e) => setQueryOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>query</summary>
          <pre>{content.query}</pre>
        </details>
      )}

      {error ? (
        <div className="data-table-empty">{error}</div>
      ) : !payload ? (
        <div className="data-table-empty">carregando…</div>
      ) : columns.length === 0 ? (
        <div className="data-table-empty">tabela vazia</div>
      ) : (
        <div className="data-table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((col, i) => (
                  <th key={i} title={col}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {columns.map((_, c) => {
                    const cell = row[c] ?? null
                    const isNum = typeof cell === 'number'
                    return (
                      <td
                        key={c}
                        className={cell === null ? 'is-null' : isNum ? 'is-num' : undefined}
                        title={cell === null ? '' : String(cell)}
                      >
                        {cell === null ? '∅' : String(cell)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Rótulo do nó no header. */
export function dataTableLabel(content: DataTableContent): string {
  return content.title || 'Resultado'
}
