/** Nó Text — rótulo leve, editável in-place, sem chrome. */
import { useEffect, useState } from 'react'
import type { CanvasNode, TextContent } from '@shared/types'
import { store } from '../state/store'
import { textNodeStyle } from './typography'

export function TextNode({ node, content }: { node: CanvasNode; content: TextContent }): JSX.Element {
  const [editing, setEditing] = useState(content.text.length === 0)
  const [value, setValue] = useState(content.text)

  // A barra de formatação e o CLI também escrevem no conteúdo; sem isso o
  // rascunho local ficaria preso no texto antigo.
  useEffect(() => setValue(content.text), [content.text])

  const commit = (): void => {
    setEditing(false)
    if (value !== content.text) void store.patchContent(node.id, { text: value })
  }

  const style = textNodeStyle(content)
  const wrapperStyle = {
    background: content.backgroundColor ?? 'transparent',
    // Sem fundo o rótulo é só texto solto; com fundo vira um chip e precisa de
    // respiro proporcional ao corpo da fonte.
    padding: content.backgroundColor ? `${Math.round(content.fontSize * 0.3)}px 8px` : '2px 4px',
    borderRadius: content.backgroundColor ? 8 : 0,
    justifyContent:
      content.alignment === 'center' ? 'center' : content.alignment === 'right' ? 'flex-end' : 'flex-start'
  }

  if (editing) {
    return (
      <div className="text-node" style={wrapperStyle}>
        <textarea
          className="text-node-input"
          data-node-interactive
          autoFocus
          rows={1}
          value={value}
          style={style}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          // Enter confirma; Shift+Enter quebra linha, como nos apps de canvas.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              setValue(content.text)
              setEditing(false)
            }
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="text-node"
      style={wrapperStyle}
      // O gesto já é do rótulo: duplo clique aqui é EDITAR. Sem parar a
      // propagação ele subiria para o canvas e abriria o modo foco junto —
      // dois efeitos para um clique. Focar o texto é duplo clique na borda.
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <span className="text-node-measure" style={style}>
        {content.text || 'texto'}
      </span>
    </div>
  )
}
