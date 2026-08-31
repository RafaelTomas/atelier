/**
 * Barra de ações do nó selecionado — terminal, botão ou relógio.
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
import { readClockConfig } from '@shared/clock'
import { CLOCK_COLORS } from './clock-widget'
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
  // O relógio entra aqui pela mesma razão do botão: duração, formato de hora e
  // as durações do pomodoro não cabem no nó, e o lápis é o caminho que o botão
  // já ensinou.
  //
  // E ele ganha o ⇄ também, o que o botão não tem: o cabo `clockAction` TEM
  // direção, e sai do relógio. Oferecer o gesto na ponta que produz o evento é
  // o que faz "ao terminar → este botão" ser lido na ordem em que acontece.
  const isClock =
    node.content.type === 'widget' && node.content.value.kind === 'clock'
  const label = isTerminal ? 'terminal' : isClock ? 'relógio' : 'botão'

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
      {(isTerminal || isClock) && (
        <button
          type="button"
          className="icon-btn action-btn"
          title={isClock ? 'Ligar a um botão — ele roda quando o tempo acabar' : 'Ligar a outro nó'}
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
      {isTerminal && <SessionButton node={node} />}
      {isClock && <ClockColorButton node={node} />}
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
 * A cor do LED do relógio.
 *
 * Mora na barra de ações, e não no diálogo do lápis, porque é uma escolha de
 * APARÊNCIA e de um clique: o diálogo edita durações — números que precisam ser
 * digitados, conferidos e cancelados —, e enterrar uma troca de cor atrás dele
 * pediria três gestos para uma decisão que se toma olhando.
 *
 * O botão não usa ícone de paleta: ele MOSTRA a cor atual, como o botão ao lado
 * mostra o nome da conta do Claude. Um ícone genérico diria que existe cor para
 * escolher; a bolinha diz qual está escolhida.
 */
function ClockColorButton({ node }: Props): JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  if (node.content.type !== 'widget' || node.content.value.kind !== 'clock') return null
  const color = readClockConfig(node.content.value.view).color
  const label = CLOCK_COLORS.find((c) => c.value === color)?.label ?? 'Personalizada'

  const open = (): void => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenu({ x: rect.right, y: rect.bottom + 4 })
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn action-btn"
        title={`Cor do mostrador: ${label}`}
        onClick={() => (menu ? setMenu(null) : open())}
      >
        <span className="clock-color-dot" style={{ background: color }} />
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} align="right">
          <span className="context-menu-label">Cor do mostrador</span>
          {/* A mesma linha de amostras do menu de grupo e da caneta: inventar um
              terceiro jeito de escolher cor faria aprender três gramáticas para
              a mesma ideia. */}
          <div className="group-swatches">
            {CLOCK_COLORS.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className={swatch.value === color ? 'swatch is-active' : 'swatch'}
                style={{ background: swatch.value }}
                title={swatch.label}
                aria-label={swatch.label}
                onClick={() => {
                  setMenu(null)
                  void store.setClockColor(node.id, swatch.value)
                }}
              />
            ))}
          </div>
        </ContextMenu>
      )}
    </>
  )
}

/**
 * O ↻ com as duas maneiras de reiniciar um agente.
 *
 * Antes era um botão só, e ele fazia a única coisa possível: matar o processo e
 * subir outro, virgem. Com o id da sessão gravado por nó (ver
 * core/terminal/session-store.ts), reiniciar passou a ter DUAS respostas
 * legítimas, e nenhuma delas é o padrão óbvio da outra:
 *
 *  - **Sessão nova** é o gesto de desistir do estado atual — o que o ↻ sempre
 *    significou. Continua sendo o clique direto, e apaga o id.
 *  - **Retomar sessão** ressuscita a conversa. Só aparece quando existe um id
 *    gravado, e diz QUAL sessão vai voltar: uma ação que traz de volta um
 *    contexto sem dizer qual é pior que nenhuma ação.
 *
 * A sessão é consultada ao ABRIR o menu, não a cada render: é um round-trip por
 * nó, e o dado só interessa no instante em que alguém vai escolher.
 */
function SessionButton({ node }: Props): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [session, setSession] = useState<{ sessionId: string; startedAt: string } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const open = (): void => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    setSession(null)
    void store.terminalSession(node.id).then(setSession)
    setMenu({ x: rect.right, y: rect.bottom + 4 })
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="icon-btn action-btn"
        title="Reiniciar o agente — sessão nova ou retomando a anterior"
        onClick={() => (menu ? setMenu(null) : open())}
      >
        <IconReload size={16} />
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} align="right">
          <span className="context-menu-label">Reiniciar agente</span>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void store.restartTerminal(node.id)
            }}
          >
            Sessão nova <span className="dock-menu-hint">descarta o contexto atual</span>
          </button>
          {/* Ausente, e não desabilitado, quando não há o que retomar: um item
              permanentemente cinza só ensina o usuário a ignorar o menu. */}
          {session && (
            <button
              type="button"
              onClick={() => {
                setMenu(null)
                void store.resumeTerminal(node.id)
              }}
            >
              Retomar sessão{' '}
              <span className="dock-menu-hint">
                {session.sessionId.slice(0, 8)}
                {session.startedAt ? ` · ${session.startedAt.slice(0, 10)}` : ''}
              </span>
            </button>
          )}
        </ContextMenu>
      )}
    </>
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
