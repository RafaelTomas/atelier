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
import { fileNameOf, isMarkdownPath, languageLoaderFor } from './code-languages'
import { MarkdownView } from './markdown-view'

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

/**
 * Quanto tempo sem digitar antes de contar ao main o estado do buffer.
 *
 * O push é por tecla no caminho ingênuo, e o buffer sujo viaja inteiro — 300 ms
 * é o mesmo intervalo que o resto do app usa para "parou de digitar", e o que
 * separa um IPC por palavra de um IPC por caractere.
 */
const PUSH_DEBOUNCE_MS = 300

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
  const { theme, revealRequest } = useStore()
  const path = content.filePath
  const isMd = isMarkdownPath(path)
  // Um `.md` arrastado para o canvas nasce em prévia; o botão alterna para o
  // código. O texto vive no CodeMirror — este espelho existe só para a prévia.
  const [preview, setPreview] = useState(isMd)
  const [docText, setDocText] = useState('')

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
    // Sem este push o main seguiria com o buffer velho marcado como sujo, e o
    // agente leria como "não salvo" um arquivo que já está em disco.
    pushNowRef.current(view)
    return true
  }
  const saveRef = useRef(save)
  saveRef.current = save

  // ─── O que o main não tem como perguntar ───────────────────────────────────
  // O buffer vive aqui, no renderer, e o agente ligado a este nó por cabo
  // precisa saber qual arquivo é, se há alteração pendente e onde está o
  // cursor. Quem empurra é este nó; quem guarda é core/editor/editor-registry.
  // A alternativa — o main perguntar quando o agente pedir — exigiria um
  // protocolo de requestId/timeout para um dado minúsculo, e não funcionaria
  // com o nó desmontado, que é justamente quando a resposta seria mais tardia.

  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Manda agora, sem esperar o debounce. Usado no save e na montagem. */
  const pushNow = (view: EditorView): void => {
    const text = view.state.doc.toString()
    const isDirty = text !== savedText.current
    window.atelier.editor.push(node.id, {
      path,
      dirty: isDirty,
      // O texto só sobe enquanto sujo: limpo, o disco é a fonte da verdade e
      // já tem o teto de tamanho. Duas cópias seriam dois lugares divergindo.
      buffer: isDirty ? text : null,
      ...selectionOf(view)
    })
  }
  const pushNowRef = useRef(pushNow)
  pushNowRef.current = pushNow

  const pushSoon = (view: EditorView): void => {
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => pushNowRef.current(view), PUSH_DEBOUNCE_MS)
  }

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
      setDocText(result.text)
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
              // `selectionSet` também conta: "explica ISTO" é a pergunta que só
              // a seleção responde, e ela muda sem o documento mudar.
              if (!update.docChanged && !update.selectionSet) return
              if (update.docChanged) {
                if (isMd) setDocText(update.state.doc.toString())
                const changed = update.state.doc.toString() !== savedText.current
                setDirty(changed)
                store.setEditorDirty(node.id, changed)
              }
              pushSoon(update.view)
            })
          ]
        })
      })
      viewRef.current = view
      setLoading(false)
      // Push de estreia: sem ele o agente só descobriria o caminho depois de o
      // usuário digitar algo, e um arquivo apenas ABERTO é o caso mais comum.
      pushNowRef.current(view)

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
      if (pushTimer.current) clearTimeout(pushTimer.current)
      viewRef.current?.destroy()
      viewRef.current = null
      store.setEditorDirty(node.id, false)
      // Desmonte (zoom, virtualização, remoção) apaga a entrada: um registro
      // sobrevivente afirmaria ao agente que há um editor aqui, com um buffer
      // que já não existe.
      window.atelier.editor.push(node.id, null)
    }
  }, [path, node.id])

  /**
   * "Mostre a linha N" — o clique num resultado da busca por conteúdo.
   *
   * Depende de `loading` de propósito: o pedido chega ANTES de o editor
   * existir quando o nó acabou de nascer, e sem esperar a montagem a linha
   * seria pedida a um `viewRef` nulo e perdida em silêncio.
   */
  useEffect(() => {
    if (revealRequest?.nodeId !== node.id) return
    const view = viewRef.current
    if (!view) return
    // Linha além do fim do arquivo (o disco mudou desde a busca) cai na última,
    // em vez de derrubar o `line()` do CodeMirror.
    const target = Math.min(revealRequest.line, view.state.doc.lines)
    const pos = view.state.doc.line(target).from
    view.dispatch({
      selection: { anchor: pos },
      // `center` e não `nearest`: quem vem de uma busca quer LER o contexto em
      // volta, e a linha encostada na borda de baixo não mostra nada abaixo.
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      scrollIntoView: false
    })
    view.focus()
    store.revealHandled(node.id)
  }, [revealRequest, node.id, loading])

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
          {isMd && (
            <button
              type="button"
              className={preview ? 'icon-btn ghost-btn is-active' : 'icon-btn ghost-btn'}
              title={preview ? 'Ver o código' : 'Prever o Markdown'}
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? '✎' : '👁'}
            </button>
          )}
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
          <div ref={hostRef} className="code-editor-host" hidden={isMd && preview} />
          {isMd && preview && <MarkdownView source={docText} variant="standalone" />}
        </>
      )}
    </div>
  )
}

/**
 * Cursor e seleção em LINHAS 1-based — a unidade em que um agente pensa e a
 * mesma de `offset`/`limit` do resto do CLI. Deslocamento de caractere seria
 * exato e inútil: ninguém pede "explica do byte 4120 ao 4390".
 *
 * Seleção vazia devolve `selection: null`, não um intervalo de uma linha só:
 * "o cursor está na linha 12" e "as linhas 12 a 12 estão selecionadas" são
 * respostas diferentes, e a segunda faria `read --selection` inventar recorte.
 */
function selectionOf(view: EditorView): {
  selection: { from: number; to: number } | null
  cursorLine: number
} {
  const range = view.state.selection.main
  const doc = view.state.doc
  const cursorLine = doc.lineAt(range.head).number
  if (range.empty) return { selection: null, cursorLine }
  return {
    selection: {
      from: doc.lineAt(range.from).number,
      to: doc.lineAt(range.to).number
    },
    cursorLine
  }
}

/** Rótulo do nó no header — o nome do arquivo, não o caminho inteiro. */
export function codeEditorLabel(content: CodeEditorContent): string {
  return fileNameOf(content.filePath) || 'Arquivo'
}
