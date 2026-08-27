/** Nó Note — editor de Markdown com gravação debounced no arquivo .md. */
import { useEffect, useRef, useState } from 'react'
import type { CanvasNode, StickyNoteContent, UUID } from '@shared/types'
import { store } from '../state/store'
import { MarkdownView } from './markdown-view'
import { noteEditorStyle } from './typography'

interface Props {
  node: CanvasNode
  content: StickyNoteContent
  workspaceId: UUID
}

export function NoteNode({ node, content, workspaceId }: Props): JSX.Element {
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileName = content.fileName
  const previewing = content.isPreviewing

  useEffect(() => {
    if (!fileName) return
    let alive = true
    void window.atelier.note.read(workspaceId, fileName).then((body) => {
      if (alive) setText(body)
    })

    // O CLI pode escrever na nota por fora (atelier note write)
    const off = window.atelier.note.onChanged(async (p) => {
      if (p.nodeId !== node.id) return
      const fresh = await window.atelier.note.read(workspaceId, fileName)
      if (alive) setText(fresh)
    })

    return () => {
      alive = false
      off()
    }
  }, [fileName, workspaceId, node.id])

  const onChange = (value: string): void => {
    setText(value)
    if (!fileName) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void window.atelier.note.write(workspaceId, fileName, value)
    }, 400)
  }

  const toggle = (): void => void store.patchContent(node.id, { isPreviewing: !previewing })

  const { backgroundColor, color } = noteEditorStyle(content)

  return (
    <div className="note-node" style={{ backgroundColor, color }}>
      <button
        type="button"
        className="icon-btn note-mode-toggle"
        data-node-interactive
        title={previewing ? 'Editar o Markdown' : 'Prever o Markdown'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
      >
        {previewing ? '✎' : '👁'}
      </button>

      {previewing ? (
        <MarkdownView source={text} variant="note" />
      ) : (
        <textarea
          className="note-editor"
          data-node-interactive
          spellCheck={false}
          value={text}
          style={noteEditorStyle(content)}
          placeholder="Markdown…"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
