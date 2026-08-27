/**
 * Lista de workspaces — o conteúdo que a Sidebar tinha antes de ganhar abas.
 * Extração literal: nenhum comportamento mudou.
 */
import { useEffect, useState } from 'react'
import type { UUID } from '@shared/types'
import { ContextMenu } from '../context-menu'
import { store, useStore } from '../state/store'

interface MenuState {
  id: UUID
  x: number
  y: number
}

export function WorkspacePanel(): JSX.Element {
  const { entries, activeId } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<UUID | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<UUID | null>(null)

  const submit = (): void => {
    const trimmed = name.trim()
    if (trimmed) void store.createWorkspace(trimmed)
    setName('')
    setCreating(false)
  }

  // Um clique/Escape em qualquer lugar fecha o menu, como qualquer menu nativo.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const startRename = (id: UUID, current: string): void => {
    setMenu(null)
    setRenamingId(id)
    setRenameValue(current)
  }

  const commitRename = (): void => {
    if (renamingId) void store.renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
    setRenameValue('')
  }

  const deleting = entries.find((w) => w.id === deletingId) ?? null

  return (
    <>
      <div className="sidebar-header">
        <span>Workspaces</span>
        <div className="sidebar-header-actions">
          <button type="button" className="icon-btn ghost-btn" onClick={() => setCreating(true)} title="Novo workspace">
            +
          </button>
        </div>
      </div>

      <ul className="workspace-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            {renamingId === entry.id ? (
              <input
                autoFocus
                className="workspace-rename"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onBlur={commitRename}
              />
            ) : (
              <button
                type="button"
                className={entry.id === activeId ? 'workspace-item is-active' : 'workspace-item'}
                onClick={() => void store.openWorkspace(entry.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ id: entry.id, x: e.clientX, y: e.clientY })
                }}
              >
                <span className="workspace-dot" data-color={entry.color} />
                {entry.name}
              </button>
            )}
          </li>
        ))}
      </ul>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          <button
            type="button"
            onClick={() =>
              startRename(menu.id, entries.find((w) => w.id === menu.id)?.name ?? '')
            }
          >
            Renomear
          </button>
          {/* Separador acima: o que está embaixo dele apaga arquivos, e um
              clique de escorregão não pode cair nele vindo de "Renomear". */}
          <div className="context-menu-sep" />
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              setDeletingId(menu.id)
              setMenu(null)
            }}
          >
            Excluir…
          </button>
        </ContextMenu>
      )}

      {deleting && (
        <DeleteWorkspaceDialog
          id={deleting.id}
          name={deleting.name}
          onDone={() => setDeletingId(null)}
        />
      )}

      {creating && (
        <div className="sidebar-create">
          <input
            autoFocus
            value={name}
            placeholder="Nome do workspace"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') setCreating(false)
            }}
            onBlur={submit}
          />
        </div>
      )}
    </>
  )
}

/**
 * Confirmação de exclusão — modal, e com o nome digitado.
 *
 * Digitar o nome parece exagero até olhar o que a ação faz: `rm -rf` no
 * diretório inteiro do workspace, com as notas `.md`, as tabelas e as imagens
 * junto. Não há lixeira nem desfazer, e o botão mora num menu de contexto a um
 * item de distância de "Renomear". A digitação é o que separa as duas.
 *
 * O aviso é mais forte em modo seguro: ali o arquivo tem conteúdo que este
 * binário nem soube ler, então nem a lista de nós na tela descreve o que some.
 */
function DeleteWorkspaceDialog({
  id,
  name,
  onDone
}: {
  id: UUID
  name: string
  onDone: () => void
}): JSX.Element {
  const { activeId, integrity } = useStore()
  const [typed, setTyped] = useState('')
  const isActive = id === activeId
  const unreadable = isActive && integrity?.safeMode === true
  const armed = typed.trim() === name

  const confirm = (): void => {
    if (!armed) return
    void store.deleteWorkspace(id)
    onDone()
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDone()
      }}
    >
      <div className="modal is-compact" role="dialog" aria-label={`Excluir ${name}`}>
        <h2 className="modal-title">Excluir “{name}”?</h2>
        <p className="trash-hint">
          A pasta deste workspace some do disco inteira — notas, tabelas e imagens junto. Não há
          como desfazer.
          {isActive && ' Ele está aberto agora: o canvas fica vazio até você abrir outro.'}
        </p>
        {unreadable && (
          <p className="trash-hint">
            Este workspace está em <strong>modo seguro</strong>: parte do conteúdo dele não foi
            reconhecida por esta versão e não aparece na tela. Ela some junto.
          </p>
        )}
        <div className="sidebar-create">
          <input
            autoFocus
            value={typed}
            placeholder={`Digite ${name} para confirmar`}
            aria-label="Confirme digitando o nome do workspace"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              if (e.key === 'Escape') onDone()
            }}
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onDone}>
            Cancelar
          </button>
          <button type="button" className="btn is-danger" disabled={!armed} onClick={confirm}>
            Excluir para sempre
          </button>
        </div>
      </div>
    </div>
  )
}
