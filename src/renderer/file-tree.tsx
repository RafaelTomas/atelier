/**
 * Árvore de arquivos de uma pasta — usada no nó do canvas e na aba Arquivos.
 *
 * Expansão preguiçosa: cada pasta aberta é um `fs:list-dir` daquele nível, e
 * nada é lido antes de o usuário pedir. Recursão antecipada aqui repetiria o
 * erro que a poda do scanner evita — abrir um node_modules mandaria dezenas de
 * milhares de objetos pelo IPC, que os clona um a um.
 *
 * O componente é burro de propósito: recebe a raiz e não sabe se está dentro de
 * um nó ou de um painel. Quem sabe disso é quem o renderiza. Como é o MESMO
 * componente nos dois lugares, tudo que entra aqui — menu, renomear, arrastar —
 * nasce nos dois de uma vez.
 *
 * Depois de uma mutação recarrega SÓ o diretório afetado. O estado de expansão
 * é do usuário: perdê-lo a cada renomear irrita mais do que a ação ajuda.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileOpError, FsEntry } from '@shared/types'
import { ContextMenu } from './context-menu'
import { FILE_OP_TEXT } from './file-ops-text'
import { FILE_DRAG_TYPE, readFileDrag } from './drag'
import { store, useStore } from './state/store'

interface Props {
  /** Pasta raiz, absoluta. Também é a fronteira do que o main deixa ler. */
  root: string
}

/** O que o git respondeu, já em caminhos absolutos e normalizados. */
interface GitMarks {
  /** Não rastreado ou ignorado — a linha fica esmaecida. */
  unversioned: Set<string>
  /** Rastreado e alterado — ponto na linha. */
  changed: Set<string>
  /** Pastas que contêm alguma alteração — ponto na pasta, mesmo fechada. */
  changedDirs: Set<string>
}

interface DirState {
  entries: FsEntry[]
  truncated: number
  error: string | null
}

const DENIAL_TEXT: Record<string, string> = {
  denied: 'sem permissão para ler esta pasta',
  missing: 'esta pasta não existe mais',
  error: 'não foi possível ler esta pasta'
}

/** Confirmação de exclusão pendente — com a contagem, quando é pasta cheia. */
interface TrashTarget {
  entry: FsEntry
  /** Itens no primeiro nível da pasta. null = arquivo, ou contagem falhou. */
  childCount: number | null
}

export function FileTree({ root }: Props): JSX.Element {
  const { projects } = useStore()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** A entrada inteira, não só o caminho: o botão "novo agente" precisa saber
   *  se o que está selecionado é pasta ou arquivo. */
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [menu, setMenu] = useState<{ entry: FsEntry; x: number; y: number } | null>(null)
  /** Caminho em edição inline. Renomear é uma palavra, não merece diálogo. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [trash, setTrash] = useState<TrashTarget | null>(null)
  /** Pasta sob o cursor durante um arrasto de arquivo. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * O que o git diz sobre os caminhos desta árvore. null = a pasta não é
   * repositório, ou a resposta ainda não chegou: nesse caso nada é marcado, que
   * é melhor do que marcar errado.
   *
   * Quem responde é o git, não um palpite sobre o .gitignore: um arquivo novo é
   * tão não versionado quanto um ignorado, e nenhuma leitura de .gitignore
   * saberia disso.
   */
  const [marks, setMarks] = useState<GitMarks | null>(null)
  const renameInput = useRef<HTMLInputElement>(null)
  /**
   * Tirar o input do DOM dispara `blur`, e o blur também comita. Sem esta
   * trava, Enter renomearia duas vezes — a segunda contra um caminho que já não
   * existe — e Escape comitaria o que devia descartar.
   */
  const renameHandled = useRef(false)

  const project = projects.find((p) => p.path === root) ?? null

  const load = useCallback(
    async (path: string): Promise<void> => {
      const result = await window.atelier.fs.listDir(path)
      setDirs((prev) => ({
        ...prev,
        [path]:
          'error' in result
            ? { entries: [], truncated: 0, error: DENIAL_TEXT[result.error] ?? result.error }
            : { entries: result.entries, truncated: result.truncated, error: null }
      }))
    },
    [root]
  )

  /**
   * Recarrega o diretório do caminho dado (o PAI, quando o caminho é o item que
   * mudou). Diretório que nunca foi aberto é ignorado: relê-lo abriria sozinho
   * um galho que o usuário deixou fechado.
   */
  const reloadDir = (dir: string): void => {
    if (dirs[dir]) void load(dir)
  }

  /**
   * Uma consulta por árvore, não uma por diretório: o git responde pelo
   * repositório inteiro de uma vez, e os caminhos vêm relativos à RAIZ DELE,
   * que pode ser um ancestral da raiz da árvore.
   */
  const loadMarks = useCallback(async (): Promise<void> => {
    if (!root) return
    const result = await window.atelier.git.treeStatus(root)
    if ('error' in result) {
      setMarks(null)
      return
    }
    const base = normalizePath(result.root)
    const absoluto = (p: string): string => `${base}/${normalizePath(p)}`

    // As pastas ANCESTRAIS de cada mudança entram num conjunto próprio: com a
    // árvore fechada, o ponto na pasta é a única pista de que há trabalho lá
    // dentro. Calculado uma vez, não a cada linha desenhada.
    const changed = new Set(result.changed.map(absoluto))
    const changedDirs = new Set<string>()
    for (const path of changed) {
      let dir = parentOf(path)
      while (dir.length > base.length) {
        if (changedDirs.has(dir)) break // este ramo já foi subido
        changedDirs.add(dir)
        dir = parentOf(dir)
      }
    }
    setMarks({ unversioned: new Set(result.unversioned.map(absoluto)), changed, changedDirs })
  }, [root])

  // Trocar a raiz invalida tudo que já foi lido.
  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setSelected(null)
    setMarks(null)
    if (root) {
      void load(root)
      void loadMarks()
    }
  }, [root, load, loadMarks])

  useEffect(() => {
    if (renaming) renameInput.current?.select()
  }, [renaming])

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
    if (root) {
      void load(root)
      void loadMarks()
    }
  }

  // ─── Ações do menu ──────────────────────────────────────────────────────────

  /** Traduz o motivo e devolve `true` quando a operação passou. */
  const report = (result: { error: FileOpError } | { ok: true }): boolean => {
    if ('error' in result) {
      store.showNotice(FILE_OP_TEXT[result.error] ?? FILE_OP_TEXT.error)
      return false
    }
    return true
  }

  const copyToClipboard = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => store.showNotice(`copiado: ${text}`),
      () => store.showNotice('não foi possível copiar')
    )
  }

  const commitRename = async (entry: FsEntry, name: string): Promise<void> => {
    if (renameHandled.current) return
    renameHandled.current = true
    setRenaming(null)
    const trimmed = name.trim()
    // Nome com separador não é renomear, é mover às escondidas — e o main
    // recusaria de todo jeito. Barrar aqui dá a mensagem certa.
    if (!trimmed || trimmed === entry.name) return
    if (/[\\/]/.test(trimmed)) {
      store.showNotice('o nome não pode conter barras')
      return
    }
    const target = parentOf(entry.path) + separatorOf(entry.path) + trimmed
    const result = await window.atelier.fs.rename(entry.path, target)
    if (!report(result)) return
    if (selected?.path === entry.path) setSelected({ ...entry, name: trimmed, path: target })
    reloadDir(parentOf(entry.path))
    // Um editor aberto neste arquivo segue o nome novo, em vez de virar um nó
    // apontando para um caminho que não existe mais.
    store.fileMoved(entry.path, target)
  }

  const duplicate = async (entry: FsEntry): Promise<void> => {
    if (report(await window.atelier.fs.duplicate(entry.path))) reloadDir(parentOf(entry.path))
  }

  /** Abre a confirmação, contando o que vai junto quando o alvo é pasta. */
  const askTrash = async (entry: FsEntry): Promise<void> => {
    if (!entry.isDirectory) {
      setTrash({ entry, childCount: null })
      return
    }
    const listed = await window.atelier.fs.listDir(entry.path)
    setTrash({ entry, childCount: 'error' in listed ? null : listed.entries.length })
  }

  const confirmTrash = async (entry: FsEntry): Promise<void> => {
    setTrash(null)
    if (!report(await window.atelier.fs.trash(entry.path))) return
    if (selected?.path === entry.path) setSelected(null)
    reloadDir(parentOf(entry.path))
  }

  const openFile = (entry: FsEntry): void => {
    void store.openFileInWorkspace(entry.path)
  }

  // ─── Mover por arrasto, dentro da própria árvore ─────────────────────────────

  const dropInto = async (dir: string, data: string): Promise<void> => {
    setDropTarget(null)
    const payload = readFileDrag(data)
    if (!payload) return

    const from = payload.path
    const sourceDir = parentOf(from)
    // Soltar na pasta onde já está não é erro nem operação: é nada.
    if (sourceDir === dir) return
    // Pasta para dentro de si mesma some com a subárvore. O main também recusa;
    // parar aqui evita o aviso desnecessário.
    if (payload.isDirectory && (dir === from || dir.startsWith(from + separatorOf(from)))) {
      store.showNotice('uma pasta não pode entrar dentro de si mesma')
      return
    }

    const target = dir + separatorOf(dir) + payload.name
    if (!report(await window.atelier.fs.rename(from, target))) return
    // Os DOIS lados mudaram: quem perdeu o item e quem ganhou.
    reloadDir(sourceDir)
    reloadDir(dir)
    if (selected?.path === from) setSelected(null)
    store.fileMoved(from, target)
  }

  if (!root) {
    return <div className="file-tree is-empty">Nenhuma pasta definida.</div>
  }

  /**
   * `parentUnversioned` desce por herança: o git colapsa diretório inteiramente
   * ignorado num registro só (`node_modules/`), então os filhos dele não
   * aparecem na resposta — mas são tão não versionados quanto o pai.
   */
  const renderLevel = (path: string, depth: number, parentUnversioned = false): JSX.Element | null => {
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
          const indent = { paddingLeft: depth * 12 + 8 }
          const key = normalizePath(entry.path)
          const isUnversioned = parentUnversioned || (marks?.unversioned.has(key) ?? false)
          // Pasta herda o ponto de quem está dentro; arquivo só responde por si.
          const isChanged =
            !isUnversioned &&
            (entry.isDirectory ? marks?.changedDirs.has(key) : marks?.changed.has(key)) === true

          if (renaming === entry.path) {
            return (
              <div key={entry.path} className="file-tree-row is-renaming" style={indent}>
                <span className="file-tree-caret" />
                <span className="file-tree-icon">{entry.isDirectory ? '📁' : '📄'}</span>
                <input
                  ref={renameInput}
                  className="file-tree-rename"
                  defaultValue={entry.name}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(entry, e.currentTarget.value)
                    if (e.key === 'Escape') {
                      renameHandled.current = true
                      setRenaming(null)
                    }
                    e.stopPropagation()
                  }}
                  onBlur={(e) => void commitRename(entry, e.currentTarget.value)}
                />
              </div>
            )
          }

          return (
            <div key={entry.path}>
              <button
                type="button"
                data-node-interactive
                draggable
                className={[
                  'file-tree-row',
                  isUnversioned ? 'is-unversioned' : '',
                  selected?.path === entry.path ? 'is-selected' : '',
                  dropTarget === entry.path ? 'is-drop-target' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={indent}
                title={entry.path}
                onClick={() => {
                  setSelected(entry)
                  if (entry.isDirectory) toggle(entry.path)
                }}
                onDoubleClick={() => {
                  // Em pasta o duplo clique já foi dois toggles: não faz nada
                  // além disso, que é o comportamento de sempre.
                  if (!entry.isDirectory) openFile(entry)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelected(entry)
                  setMenu({ entry, x: e.clientX, y: e.clientY })
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    FILE_DRAG_TYPE,
                    JSON.stringify({
                      path: entry.path,
                      name: entry.name,
                      isDirectory: entry.isDirectory
                    })
                  )
                  e.dataTransfer.effectAllowed = 'copyMove'
                  setMenu(null)
                }}
                onDragOver={(e) => {
                  if (!entry.isDirectory || !e.dataTransfer.types.includes(FILE_DRAG_TYPE)) return
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  setDropTarget(entry.path)
                }}
                onDragLeave={() => setDropTarget((p) => (p === entry.path ? null : p))}
                onDrop={(e) => {
                  if (!entry.isDirectory) return
                  const data = e.dataTransfer.getData(FILE_DRAG_TYPE)
                  if (!data) return
                  e.preventDefault()
                  e.stopPropagation()
                  void dropInto(entry.path, data)
                }}
              >
                <span className="file-tree-caret">
                  {entry.isDirectory ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <span className="file-tree-icon">{entry.isDirectory ? '📁' : '📄'}</span>
                <span className="file-tree-name">{entry.name}</span>
                {isChanged && (
                  <span
                    className="file-tree-dot"
                    title={entry.isDirectory ? 'Contém alterações não commitadas' : 'Alterado desde o último commit'}
                  />
                )}
              </button>
              {entry.isDirectory && isOpen && renderLevel(entry.path, depth + 1, isUnversioned)}
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
            className="icon-btn ghost-btn"
            title="Novo agente nesta pasta"
            onClick={() => store.openNewTerminal(null, selectedDir(selected, root))}
          >
            ⌘
          </button>
          <button type="button" className="icon-btn ghost-btn" title="Recarregar" onClick={refresh}>
            ⟳
          </button>
          <button
            type="button"
            className="icon-btn ghost-btn"
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

      {menu && (
        <EntryMenu
          entry={menu.entry}
          x={menu.x}
          y={menu.y}
          root={root}
          onClose={() => setMenu(null)}
          onOpen={() => openFile(menu.entry)}
          onRename={() => {
            renameHandled.current = false
            setRenaming(menu.entry.path)
          }}
          onDuplicate={() => void duplicate(menu.entry)}
          onTrash={() => void askTrash(menu.entry)}
          onCopy={copyToClipboard}
        />
      )}

      {trash && (
        <TrashConfirm
          target={trash}
          onCancel={() => setTrash(null)}
          onConfirm={() => void confirmTrash(trash.entry)}
        />
      )}
    </div>
  )
}

// ─── Menu de contexto da linha ────────────────────────────────────────────────

interface MenuProps {
  entry: FsEntry
  x: number
  y: number
  root: string
  onClose: () => void
  onOpen: () => void
  onRename: () => void
  onDuplicate: () => void
  onTrash: () => void
  onCopy: (text: string) => void
}

function EntryMenu({
  entry,
  x,
  y,
  root,
  onClose,
  onOpen,
  onRename,
  onDuplicate,
  onTrash,
  onCopy
}: MenuProps): JSX.Element {
  // Fecha em qualquer clique fora e no Escape — o menu vive num portal, então
  // não há um pai por onde o clique passe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const relative = entry.path.slice(root.length + 1) || entry.name
  const run = (fn: () => void) => (): void => {
    onClose()
    fn()
  }

  return (
    <ContextMenu x={x} y={y}>
      {entry.isDirectory ? (
        <>
          <button type="button" onClick={run(() => store.openNewTerminal(null, entry.path))}>
            Novo agente aqui
          </button>
          <button type="button" onClick={run(() => void store.addFolderTreeToWorkspace(entry.path, entry.name))}>
            Adicionar árvore ao canvas
          </button>
        </>
      ) : (
        <button type="button" onClick={run(onOpen)}>
          Abrir no workspace
        </button>
      )}
      <button type="button" onClick={run(() => void window.atelier.fs.reveal(entry.path))}>
        Revelar no sistema
      </button>
      <div className="context-menu-sep" />
      <button type="button" onClick={run(() => onCopy(entry.path))}>
        Copiar caminho
      </button>
      <button type="button" onClick={run(() => onCopy(relative))}>
        Copiar caminho relativo
      </button>
      <div className="context-menu-sep" />
      <button type="button" onClick={run(onRename)}>
        Renomear…
      </button>
      {!entry.isDirectory && (
        <button type="button" onClick={run(onDuplicate)}>
          Duplicar
        </button>
      )}
      <button type="button" className="is-danger" onClick={run(onTrash)}>
        Mover para a lixeira
      </button>
    </ContextMenu>
  )
}

// ─── Confirmação de exclusão ──────────────────────────────────────────────────

/**
 * Em portal, pelo mesmo motivo do menu: a coluna da rail tem `backdrop-filter` e
 * recortaria um `position: fixed` renderizado lá dentro.
 */
function TrashConfirm({
  target,
  onCancel,
  onConfirm
}: {
  target: TrashTarget
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const { entry, childCount } = target
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal is-compact" role="dialog" aria-label="Mover para a lixeira">
        <h2 className="modal-title">Mover para a lixeira?</h2>
        <p className="trash-name" title={entry.path}>
          {entry.name}
        </p>
        {childCount !== null && childCount > 0 && (
          <p className="trash-warning">
            A pasta não está vazia: {childCount} {childCount === 1 ? 'item vai' : 'itens vão'} junto.
          </p>
        )}
        <p className="trash-hint">Vai para a lixeira do sistema — dá para desfazer por lá.</p>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn is-danger" onClick={onConfirm}>
            Mover para a lixeira
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Caminhos ─────────────────────────────────────────────────────────────────
// O renderer não tem `path`: os caminhos vêm prontos do main, e no Windows
// chegam com `\`. Por isso as duas funções aceitam os dois separadores.

/** Compara caminhos numa forma só: o git responde com `/`, o main com `\` no Windows. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/**
 * O agente nasce na pasta selecionada, ou na raiz. Arquivo selecionado cai na
 * pasta dele — abrir um shell "dentro" de um arquivo não existe.
 */
function selectedDir(selected: FsEntry | null, root: string): string {
  if (!selected) return root
  if (selected.isDirectory) return selected.path
  const parent = parentOf(selected.path)
  return parent.length >= root.length ? parent : root
}
