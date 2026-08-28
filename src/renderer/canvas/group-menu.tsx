/**
 * Menu de contexto da faixa de um grupo.
 *
 * Tudo que o grupo faz e que não cabe num atalho mora aqui. A ordem segue o
 * risco: renomear e cor primeiro (reversíveis e frequentes), desagrupar por
 * último, e excluir com os nós depois de uma confirmação — é a única ação da
 * moldura que destrói trabalho.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NodeGroup, Point } from '@shared/types'
import { ContextMenu } from '../context-menu'
import { SURFACE_COLORS } from '../nodes/typography'
import { store } from '../state/store'
import { viewport } from './viewport'

interface Props {
  group: NodeGroup
  screen: Point
  onClose: () => void
  onRename: () => void
}

export function GroupMenu({ group, screen, onClose, onRename }: Props): JSX.Element {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (confirming) return
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // mousedown, não click: o menu some antes de o canvas processar o arrasto
    // que começa embaixo dele — o mesmo padrão dos outros menus do canvas.
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, confirming])

  if (confirming) {
    return (
      <DeleteConfirm
        group={group}
        onCancel={() => {
          setConfirming(false)
          onClose()
        }}
        onConfirm={() => {
          setConfirming(false)
          onClose()
          void store.removeGroup(group.id, { withNodes: true })
        }}
      />
    )
  }

  const run = (fn: () => void): void => {
    onClose()
    fn()
  }

  return (
    <ContextMenu x={screen.x} y={screen.y}>
      <button type="button" onClick={onRename}>
        Renomear
      </button>

      {/* A mesma paleta das notas: inventar um vocabulário de cor só para
          grupos faria a pessoa aprender duas listas para a mesma ideia. */}
      <div className="group-swatches">
        {SURFACE_COLORS.map((swatch) => (
          <button
            key={swatch.value}
            type="button"
            className={swatch.value === group.color ? 'swatch is-active' : 'swatch'}
            style={{ background: swatch.value }}
            title={swatch.label}
            aria-label={swatch.label}
            onClick={() => run(() => void store.setGroupColor(group.id, swatch.value))}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => run(() => void store.fitGroupToContent(group.id))}
        // Sem membros não há conteúdo para ajustar — o item ficaria mudo.
        disabled={group.nodeIds.length === 0}
      >
        Ajustar ao conteúdo
      </button>

      <button type="button" onClick={() => run(() => viewport.fit(group.frame))}>
        Enquadrar
      </button>

      <button
        type="button"
        onClick={() => run(() => void store.setGroupCollapsed(group.id, !group.isCollapsed))}
      >
        {group.isCollapsed ? 'Expandir' : 'Colapsar'}
      </button>

      <button type="button" onClick={() => run(() => store.isolateGroup(group.id))}>
        Isolar <span className="dock-menu-hint">Esc sai</span>
      </button>

      <div className="dock-menu-sep" />

      <button type="button" onClick={() => run(() => void store.removeGroup(group.id))}>
        Desagrupar <span className="dock-menu-hint">a moldura some, os nós ficam</span>
      </button>

      <button
        type="button"
        className="is-danger"
        // Não fecha o menu: troca por uma confirmação. Apagar N nós de uma vez
        // é a única ação daqui que não tem desfazer.
        onClick={() => setConfirming(true)}
        disabled={group.nodeIds.length === 0}
      >
        Excluir com os nós
      </button>
    </ContextMenu>
  )
}

/** Em portal, como as outras confirmações do app. */
function DeleteConfirm({
  group,
  onCancel,
  onConfirm
}: {
  group: NodeGroup
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

  const count = group.nodeIds.length
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal is-compact" role="dialog" aria-label="Excluir grupo com os nós">
        <h2 className="modal-title">Excluir “{group.title}” com os nós?</h2>
        <p className="trash-warning">
          {count} {count === 1 ? 'nó vai' : 'nós vão'} junto — terminais são encerrados e notas
          deixam de aparecer no canvas.
        </p>
        <p className="trash-hint">
          Para ficar só com os nós, use Desagrupar: a moldura some e nada mais muda.
        </p>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn is-danger" onClick={onConfirm}>
            Excluir com os nós
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
