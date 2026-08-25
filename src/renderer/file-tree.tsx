/**
 * Árvore de arquivos de uma pasta — usada no nó do canvas e na aba Arquivos.
 *
 * Expansão preguiçosa: cada pasta aberta é um `fs:list-dir` daquele nível, e
 * nada é lido antes de o usuário pedir. Recursão antecipada aqui repetiria o
 * erro que a poda do scanner evita — abrir um node_modules mandaria dezenas de
 * milhares de objetos pelo IPC, que os clona um a um.
 *
 * O componente é burro de propósito: recebe a raiz e não sabe se está dentro de
 * um nó ou de um painel. Quem sabe disso é quem o renderiza.
 */
import { useCallback, useEffect, useState } from 'react'
import type { FsEntry } from '@shared/types'
import { store, useStore } from './state/store'

interface Props {
  /** Pasta raiz, absoluta. Também é a fronteira do que o main deixa ler. */
  root: string
}

interface DirState {
  entries: FsEntry[]
  truncated: number
  ignored: number
  error: string | null
}

const DENIAL_TEXT: Record<string, string> = {
  denied: 'sem permissão para ler esta pasta',
  missing: 'esta pasta não existe mais',
  error: 'não foi possível ler esta pasta'
}

export function FileTree({ root }: Props): JSX.Element {
  const { projects } = useStore()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** A entrada inteira, não só o caminho: o botão "novo agente" precisa saber
   *  se o que está selecionado é pasta ou arquivo. */
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)

  const project = projects.find((p) => p.path === root) ?? null

  const load = useCallback(
    async (path: string): Promise<void> => {
      const result = await window.atelier.fs.listDir(path, { root, showIgnored })
      setDirs((prev) => ({
        ...prev,
        [path]:
          'error' in result
            ? { entries: [], truncated: 0, ignored: 0, error: DENIAL_TEXT[result.error] ?? result.error }
            : { entries: result.entries, truncated: result.truncated, ignored: result.ignored, error: null }
      }))
    },
    [root, showIgnored]
  )

  // Trocar o filtro ou a raiz invalida tudo que já foi lido: o que está aberto
  // precisa ser relido com a nova regra.
  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setSelected(null)
    if (root) void load(root)
  }, [root, showIgnored, load])

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!dirs[path]) void load(path)
      }
      return next
    })
  }

  const refresh = (): void => {
    setDirs({})
    setExpanded(new Set())
    if (root) void load(root)
  }

  if (!root) {
    return <div className="file-tree is-empty">Nenhuma pasta definida.</div>
  }

  const renderLevel = (path: string, depth: number): JSX.Element | null => {
    const state = dirs[path]
    if (!state) return <div className="file-tree-loading" style={{ paddingLeft: depth * 12 + 8 }}>carregando…</div>
    if (state.error) {
      return (
        <div className="file-tree-error" style={{ paddingLeft: depth * 12 + 8 }}>
          {state.error}
        </div>
      )
    }

    return (
      <>
        {state.entries.map((entry) => {
          const isOpen = expanded.has(entry.path)
          return (
            <div key={entry.path}>
              <button
                type="button"
                data-node-interactive
                className={
                  selected?.path === entry.path ? 'file-tree-row is-selected' : 'file-tree-row'
                }
                style={{ paddingLeft: depth * 12 + 8 }}
                title={entry.path}
                onClick={() => {
                  setSelected(entry)
                  if (entry.isDirectory) toggle(entry.path)
                }}
              >
                <span className="file-tree-caret">
                  {entry.isDirectory ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <span className="file-tree-icon">{entry.isDirectory ? '📁' : '📄'}</span>
                <span className="file-tree-name">{entry.name}</span>
              </button>
              {entry.isDirectory && isOpen && renderLevel(entry.path, depth + 1)}
            </div>
          )
        })}
        {state.truncated > 0 && (
          <div className="file-tree-more" style={{ paddingLeft: depth * 12 + 8 }}>
            … mais {state.truncated} itens
          </div>
        )}
      </>
    )
  }

  return (
    <div className="file-tree" data-node-interactive>
      <div className="file-tree-bar">
        {project?.description && (
          <span className="file-tree-desc" title={project.description}>
            {project.description}
          </span>
        )}
        <div className="file-tree-actions">
          <button
            type="button"
            className="ghost-btn"
            title="Novo agente nesta pasta"
            onClick={() => store.openNewTerminal(null, selectedDir(selected, root))}
          >
            ⌘
          </button>
          <button
            type="button"
            className={showIgnored ? 'ghost-btn is-active' : 'ghost-btn'}
            title={showIgnored ? 'Ocultar arquivos ignorados pelo git' : 'Mostrar arquivos ignorados pelo git'}
            onClick={() => setShowIgnored((v) => !v)}
          >
            ◌
          </button>
          <button type="button" className="ghost-btn" title="Recarregar" onClick={refresh}>
            ⟳
          </button>
          <button
            type="button"
            className="ghost-btn"
            title="Revelar no sistema"
            onClick={() => void window.atelier.fs.reveal(selected?.path ?? root)}
          >
            ↗
          </button>
        </div>
      </div>

      <div className="file-tree-body">{renderLevel(root, 0)}</div>

      {selected && (
        <div className="file-tree-status" title={selected.path}>
          {selected.path.slice(root.length + 1) || '.'}
        </div>
      )}
    </div>
  )
}

/**
 * O agente nasce na pasta selecionada, ou na raiz. Arquivo selecionado cai na
 * pasta dele — abrir um shell "dentro" de um arquivo não existe.
 *
 * O corte aceita as duas barras: o caminho vem do main, então no Windows ele
 * chega com `\`.
 */
function selectedDir(selected: FsEntry | null, root: string): string {
  if (!selected) return root
  if (selected.isDirectory) return selected.path
  const parent = selected.path.replace(/[\\/][^\\/]*$/, '')
  return parent.length >= root.length ? parent : root
}
