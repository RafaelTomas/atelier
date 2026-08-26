/**
 * Nó Editor de Código — CodeMirror 6 dentro do canvas.
 *
 * O nó guarda só o `filePath`; conteúdo, linguagem e estado de "não salvo"
 * vivem aqui, em memória. É a mesma regra do nó de árvore: o que se deriva do
 * disco não é gravado no workspace.json, porque campo extra em conteúdo de nó é
 * descartado na releitura e viraria mentira.
 *
 * Duas coisas que este nó tem e o terminal também: `data-node-interactive` no
 * contêiner, para o canvas não roubar clique nem tecla de dentro dele, e o tema
 * seguindo o do app pelos tokens `--term-bg` / `--term-fg`.
 *
 * Diferente do terminal, NÃO há congelamento por zoom: o CodeMirror desenha em
 * DOM, que escala junto com o `transform` da camada de nós sem borrar.
 */
import { useEffect, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import type { CanvasNode, CodeEditorContent, FileOpError } from '@shared/types'
import { FILE_OP_TEXT } from '../file-ops-text'
import { truncateStart } from '../paths'
import { store, useStore } from '../state/store'
import { effectiveTheme } from '../theme'
import { fileNameOf, languageLoaderFor } from './code-languages'

interface Props {
  node: CanvasNode
  content: CodeEditorContent
}

/**
 * O tema do editor mora em variáveis CSS, não em cores fixas: assim ele
 * acompanha a troca de tema do app sem o nó ser recriado.
 */
const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--term-bg)',
    color: 'var(--term-fg)',
    fontSize: '12px'
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: '1.5'
  },
  '.cm-gutters': {
    backgroundColor: 'var(--term-bg)',
    color: 'var(--text-dim)',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'rgb(127 127 127 / .08)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' }
})

export function CodeEditorNode({ node, content }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageRef = useRef(new Compartment())
  const themeRef = useRef(new Compartment())
  /** O texto que está em disco — a régua do "tem alteração pendente". */
  const savedText = useRef<string>('')
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<FileOpError | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const { theme } = useStore()
  const path = content.filePath

  // O tema base vem DEPOIS do oneDark: as cores dele são as do app, e a última
  // extensão é a que vence.
  const themeExtensions = (): Extension[] =>
    effectiveTheme(theme) === 'dark'
      ? [oneDark, baseTheme]
      : [syntaxHighlighting(defaultHighlightStyle), baseTheme]

  /** Grava o buffer inteiro. Chamada pelo ⌘S, pelo botão e ao fechar. */
  const save = async (): Promise<boolean> => {
    const view = viewRef.current
    if (!view || !path) return false
    const text = view.state.doc.toString()
    setSaving(true)
    const result = await window.atelier.fs.writeFile(path, text)
    setSaving(false)
    if ('error' in result) {
      store.showNotice(FILE_OP_TEXT[result.error] ?? FILE_OP_TEXT.error)
      return false
    }
    savedText.current = text
    setDirty(false)
    store.setEditorDirty(node.id, false)
    return true
  }
  const saveRef = useRef(save)
  saveRef.current = save

  // ─── Monta o editor uma vez, e o recria quando o ARQUIVO muda ───────────────

  useEffect(() => {
    const host = hostRef.current
    if (!host || !path) {
      setLoading(false)
      return
    }
    let disposed = false

    void (async () => {
      const result = await window.atelier.fs.readFile(path)
      if (disposed || !hostRef.current) return
      if ('error' in result) {
        setError(result.error)
        setLoading(false)
        return
      }

      savedText.current = result.text
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: result.text,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            foldGutter(),
            drawSelection(),
            history(),
            indentOnInput(),
            bracketMatching(),
            highlightSelectionMatches(),
            // O ⌘/Ctrl+S vem ANTES dos mapas padrão: é o atalho do nó, e não
            // pode cair no "salvar página" do Chromium por baixo.
            keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  void saveRef.current()
                  return true
                }
              },
              ...defaultKeymap,
              ...historyKeymap,
              ...searchKeymap,
              indentWithTab
            ]),
            languageRef.current.of([]),
            themeRef.current.of(themeExtensions()),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return
              const changed = update.state.doc.toString() !== savedText.current
              setDirty(changed)
              store.setEditorDirty(node.id, changed)
            })
          ]
        })
      })
      viewRef.current = view
      setLoading(false)

      // Linguagem depois do editor de pé: o chunk dela é carregado sob demanda,
      // e esperar por ele atrasaria o texto aparecer.
      const loader = languageLoaderFor(path)
      if (loader) {
        const support = await loader()
        if (!disposed && viewRef.current) {
          viewRef.current.dispatch({
            effects: languageRef.current.reconfigure(support)
          })
        }
      }
    })()

    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
      store.setEditorDirty(node.id, false)
    }
  }, [path, node.id])

  // Troca de tema com o editor montado: reconfigura, não recria — recriar
  // perderia o histórico de desfazer e a posição do cursor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(themeExtensions())
    })
  }, [theme])

  // O arquivo mudou por fora (outro agente editou o que está aberto aqui).
  useEffect(() => {
    return store.onExternalFileChange(path, (text) => {
      const view = viewRef.current
      if (!view) return
      // Com alteração local pendente, quem decide é o usuário: sobrescrever o
      // que ele digitou seria perder trabalho sem pedir licença.
      if (view.state.doc.toString() !== savedText.current) {
        store.showNotice(`${fileNameOf(path)} mudou em disco e você tem alterações não salvas`)
        return
      }
      savedText.current = text
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    })
  }, [path])

  if (!path) {
    return <div className="code-editor is-empty">Nenhum arquivo definido para este nó.</div>
  }

  return (
    <div className="code-editor" data-node-interactive>
      <div className="code-editor-bar">
        <span className="code-editor-name" title={path}>
          {fileNameOf(path)}
        </span>
        {dirty && <span className="code-editor-dot" title="Alterações não salvas" />}
        <span className="code-editor-path" title={path}>
          {truncateStart(path, 40)}
        </span>
        <div className="code-editor-actions">
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Salvar (⌘S)"
            disabled={!dirty || saving || error !== null}
            onClick={() => void save()}
          >
            {saving ? '…' : '⌷'}
          </button>
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Revelar no sistema"
            onClick={() => void window.atelier.fs.reveal(path)}
          >
            ↗
          </button>
        </div>
      </div>

      {error ? (
        <div className="code-editor-error">{FILE_OP_TEXT[error] ?? FILE_OP_TEXT.error}</div>
      ) : (
        <>
          {loading && <div className="code-editor-loading">carregando…</div>}
          <div ref={hostRef} className="code-editor-host" />
        </>
      )}
    </div>
  )
}

/** Rótulo do nó no header — o nome do arquivo, não o caminho inteiro. */
export function codeEditorLabel(content: CodeEditorContent): string {
  return fileNameOf(content.filePath) || 'Arquivo'
}
