/**
 * Barra de ações do nó selecionado — terminal ou botão.
 *
 * Mesma mecânica da FormatBar: vive FORA do contêiner transformado do canvas,
 * em coordenadas de tela, e é reposicionada no callback do viewport — assim não
 * escala com o zoom nem re-renderiza a árvore de nós a cada pan.
 */
import { useEffect, useRef, useState } from 'react'
import type { CanvasNode } from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID } from '@shared/types'
import { viewport } from '../canvas/viewport'
import { accountLabel, isClaudeCommand } from '../claude-accounts'
import { ContextMenu } from '../context-menu'
import { IconChevronDown, IconConnect, IconPencil, IconReload, IconTrash } from '../icons'
import { store, useStore } from '../state/store'

const BAR_GAP = 12 // px de tela entre o topo do nó e a barra

interface Props {
  node: CanvasNode
}

export function NodeActionBar({ node }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Ligar e recarregar são gestos de TERMINAL: um botão não é conectável (o
  // formato não tem array para o par botão↔terminal) e não tem processo para
  // reiniciar. Mostrá-los desabilitados só ensinaria o usuário a ignorá-los.
  const isTerminal = node.content.type === 'terminal'
  const label = isTerminal ? 'terminal' : 'botão'

  useEffect(() => {
    const place = (): void => {
      const el = ref.current
      if (!el) return
      const { frame } = node
      const topLeft = viewport.toScreen({ x: frame.x, y: frame.y })
      el.style.left = `${topLeft.x + (frame.width * viewport.zoom) / 2}px`
      el.style.top = `${topLeft.y - BAR_GAP}px`
    }
    place()
    return viewport.subscribe(place)
  }, [node.frame.x, node.frame.y, node.frame.width])

  return (
    <div
      ref={ref}
      className="node-action-bar"
      // O canvas trata mousedown na fase de bolha; sem parar aqui, clicar num
      // botão também iniciaria seleção ou arrasto no nó de baixo.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {isTerminal && (
        <button
          type="button"
          className="icon-btn action-btn"
          title="Ligar a outro nó"
          onClick={() => store.startConnecting(node.id)}
        >
          <IconConnect size={16} />
        </button>
      )}
      <button
        type="button"
        className="icon-btn action-btn"
        title={`Editar ${label}`}
        onClick={() => store.openNodeEditor(node.id)}
      >
        <IconPencil size={16} />
      </button>
      {isTerminal && (
        <button
          type="button"
          className="icon-btn action-btn"
          title="Recarregar — mata o processo e sobe outro"
          onClick={() => void store.restartTerminal(node.id)}
        >
          <IconReload size={16} />
        </button>
      )}
      <ClaudeAccountButton node={node} />
      <span className="action-sep" />
      <button
        type="button"
        className="icon-btn action-btn is-danger"
        title={`Excluir ${label}`}
        onClick={() => void store.removeNode(node.id)}
      >
        <IconTrash size={16} />
      </button>
    </div>
  )
}

/**
 * Troca rápida de conta do Claude, ao lado do ↻ porque é o que ela faz: a
 * conta entra no ambiente do processo, então mudar de conta é reiniciar ESTE
 * terminal. O rótulo fica visível na barra — sem ele o usuário não teria como
 * saber em qual conta o agente está rodando sem abrir o diálogo.
 *
 * A lista é relida ao abrir o menu: o login feito no terminal ao lado (ou uma
 * conta criada em outro diálogo) precisa aparecer aqui sem recarregar o app.
 */
function ClaudeAccountButton({ node }: Props): JSX.Element | null {
  const { claudeAccounts } = useStore()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  if (node.content.type !== 'terminal' || !isClaudeCommand(node.content.value)) return null
  const current = node.content.value.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT_ID
  const label = claudeAccounts.find((a) => a.id === current)?.label ?? 'Padrão'

  const open = (): void => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    void store.refreshClaudeAccounts()
    setMenu({ x: rect.right, y: rect.bottom + 4 })
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn action-btn is-account"
        title={`Conta do Claude: ${label} — trocar reinicia este terminal`}
        onClick={() => (menu ? setMenu(null) : open())}
      >
        <span className="account-name">{label}</span>
        <IconChevronDown />
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} align="right">
          <span className="context-menu-label">Conta do Claude</span>
          {claudeAccounts.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={a.id === current}
              onClick={() => {
                setMenu(null)
                void store.setTerminalAccount(node.id, a.id)
              }}
            >
              {accountLabel(a)}
            </button>
          ))}
          <div className="context-menu-sep" />
          <button type="button" onClick={() => { setMenu(null); store.openEditTerminal(node.id) }}>
            Gerenciar contas… <span className="dock-menu-hint">no diálogo do terminal</span>
          </button>
        </ContextMenu>
      )}
    </>
  )
}
