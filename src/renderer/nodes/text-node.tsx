/** Nó Text — rótulo leve, editável in-place, sem chrome. */
import { useState } from 'react'
import type { CanvasNode, TextContent } from '@shared/types'
import { store } from '../state/store'

export function TextNode({ node, content }: { node: CanvasNode; content: TextContent }): JSX.Element {
  const [editing, setEditing] = useState(content.text.length === 0)
  const [value, setValue] = useState(content.text)

  const commit = (): void => {
    setEditing(false)
    if (value !== content.text) void store.patchContent(node.id, { text: value })
  }

  const style = {
    fontSize: content.fontSize,
    fontWeight: content.fontWeight === 'bold' ? 700 : content.fontWeight === 'medium' ? 500 : 400,
    color: content.color,
    textAlign: content.alignment as 'left' | 'center' | 'right'
  }

  if (editing) {
    return (
      <input
        className="text-node-input"
        data-node-interactive
        autoFocus
        value={value}
        style={style}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    )
  }

  return (
    <div className="text-node" style={style} onDoubleClick={() => setEditing(true)}>
      {content.text || 'texto'}
    </div>
  )
}
