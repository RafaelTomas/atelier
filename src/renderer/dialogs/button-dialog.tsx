/**
 * Diálogo do botão — "Novo" ou "Editar", o mesmo formulário nos dois casos.
 *
 * Mesma casca do diálogo de terminal (Esc fecha, rascunho local, nada gravado
 * até confirmar), com duas abas: Ação (o que dispara) e Aparência (como
 * aparece). Não tem terceira aba de agente: o botão não carrega
 * responsabilidade — quem carrega é o terminal onde ele escreve.
 */
import { useEffect, useState } from 'react'
import type { ButtonAction, ButtonConfig, CanvasNode, UUID } from '@shared/types'
import { DEFAULT_BUTTON_COLOR } from '@shared/types'
import { BUTTON_PRESETS } from '../button-presets'
import { Icon, ICON_NAMES } from '../node-icons'
import { shortenPath } from '../paths'
import { NODE_COLORS } from '../terminal-presets'
import { useStore } from '../state/store'

type Tab = 'acao' | 'aparencia'

interface Props {
  /** Rascunho de partida. Presente = modo edição: o Início Rápido some. */
  initial?: ButtonConfig | null
  /** Diretório do workspace, mostrado quando o botão não escolhe outro. */
  defaultWorkingDirectory: string
  onCancel: () => void
  onSubmit: (config: ButtonConfig) => void
}

export function emptyButtonConfig(): ButtonConfig {
  return {
    label: '',
    icon: 'play',
    color: DEFAULT_BUTTON_COLOR,
    action: 'command',
    command: '',
    prompt: '',
    url: '',
    cwd: '',
    target: null,
    confirm: false,
    // Botão feito PELO usuário nasce armado — o aceite existe para o que vem
    // do agente (ver ButtonWidget).
    pending: false,
    proposedBy: null
  }
}

export function ButtonDialog({
  initial = null,
  defaultWorkingDirectory,
  onCancel,
  onSubmit
}: Props): JSX.Element {
  const { workspace, projects, selectedProjectId } = useStore()
  const editing = initial !== null
  // O que o botão vai usar quando não tem diretório próprio — a mesma ordem de
  // `buttonCwd` na store: projeto selecionado, depois workspace. Mostrar o
  // caminho efetivo, e não a palavra "padrão", é o que responde a pergunta que
  // este campo levanta: onde isto vai rodar?
  const fallbackDirectory =
    projects.find((p) => p.id === selectedProjectId)?.path || defaultWorkingDirectory
  const [tab, setTab] = useState<Tab>('acao')
  const [draft, setDraft] = useState<ButtonConfig>(() => initial ?? emptyButtonConfig())
  const [quickId, setQuickId] = useState<string | null>(null)

  const patch = (p: Partial<ButtonConfig>): void => setDraft((d) => ({ ...d, ...p }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const terminals = (workspace?.nodes ?? []).filter(
    (n): n is CanvasNode & { content: { type: 'terminal' } } => n.content.type === 'terminal'
  )

  const applyPreset = (id: string): void => {
    const preset = BUTTON_PRESETS.find((p) => p.id === id)
    if (!preset) return
    setQuickId(id)
    const nameFromPreset = BUTTON_PRESETS.some((p) => p.label === draft.label) || draft.label === ''
    patch({
      action: 'command',
      command: preset.command,
      icon: preset.icon,
      color: preset.color,
      ...(nameFromPreset ? { label: preset.label } : {})
    })
  }

  const submit = (): void => {
    const label = draft.label.trim()
    onSubmit({
      ...draft,
      label: label || BUTTON_PRESETS.find((p) => p.id === quickId)?.label || 'Botão'
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-label={editing ? 'Editar Botão' : 'Novo Botão'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{editing ? 'Editar Botão' : 'Novo Botão'}</h2>

        {!editing && (
          <section className="quick-start">
            <span className="section-label">Início Rápido</span>
            <div className="quick-start-row">
              {BUTTON_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={preset.id === quickId ? 'quick-card is-selected' : 'quick-card'}
                  onClick={() => applyPreset(preset.id)}
                >
                  <Icon name={preset.icon} size={30} />
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="modal-divider" />

        <div className="segmented">
          {(['acao', 'aparencia'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              className={t === tab ? 'segment is-active' : 'segment'}
              onClick={() => setTab(t)}
            >
              {t === 'acao' ? 'Ação' : 'Aparência'}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'acao' ? (
            <ActionTab
              draft={draft}
              patch={patch}
              onSubmit={submit}
              terminals={terminals}
              defaultWorkingDirectory={fallbackDirectory}
            />
          ) : (
            <AppearanceTab draft={draft} patch={patch} />
          )}
        </div>

        <div className="modal-divider" />

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn is-primary" onClick={submit}>
            {editing ? 'Salvar' : 'Criar'}
          </button>
        </footer>
      </div>
    </div>
  )
}

interface TabProps {
  draft: ButtonConfig
  patch: (p: Partial<ButtonConfig>) => void
}

const ACTION_LABELS: Record<ButtonAction, string> = {
  command: 'Comando',
  prompt: 'Prompt',
  url: 'Endereço'
}

function ActionTab({
  draft,
  patch,
  onSubmit,
  terminals,
  defaultWorkingDirectory
}: TabProps & {
  onSubmit: () => void
  terminals: CanvasNode[]
  defaultWorkingDirectory: string
}): JSX.Element {
  const browse = async (): Promise<void> => {
    const chosen = await window.atelier.dialog.chooseDirectory(draft.cwd || defaultWorkingDirectory)
    if (chosen) patch({ cwd: chosen })
  }

  // Prompt só faz sentido para quem escuta: um agente monitorado. Um shell
  // receberia a frase na linha de comando e tentaria executá-la.
  const eligible = terminals.filter(
    (n) => draft.action !== 'prompt' || (n.content.type === 'terminal' && n.content.value.monitorWithOmbro)
  )

  return (
    <div className="tab-pane">
      <input
        autoFocus
        className="field-input is-large"
        value={draft.label}
        placeholder="Rótulo do botão"
        onChange={(e) => patch({ label: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
      />

      <div className="segmented is-small">
        {(['command', 'prompt', 'url'] as ButtonAction[]).map((a) => (
          <button
            key={a}
            type="button"
            className={a === draft.action ? 'segment is-active' : 'segment'}
            onClick={() => patch({ action: a })}
          >
            {ACTION_LABELS[a]}
          </button>
        ))}
      </div>

      {draft.action === 'command' && (
        <div className="field-row">
          <label className="field-label">Comando</label>
          <input
            className="field-input"
            value={draft.command}
            placeholder="ex: npm run dev"
            onChange={(e) => patch({ command: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          />
        </div>
      )}

      {draft.action === 'prompt' && (
        <div className="field-row">
          <label className="field-label">Prompt</label>
          <input
            className="field-input"
            value={draft.prompt}
            placeholder="ex: revise o diff atual"
            onChange={(e) => patch({ prompt: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          />
        </div>
      )}

      {draft.action === 'url' && (
        <div className="field-row">
          <label className="field-label">Endereço</label>
          <input
            className="field-input"
            value={draft.url}
            placeholder="ex: localhost:5173"
            onChange={(e) => patch({ url: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          />
        </div>
      )}

      {/* Comando NÃO oferece escolher terminal: ele sempre nasce num terminal
          novo. Um comando escrito num terminal que já roda outra coisa cai em
          cima do que está lá, e a lista de alvos era o campo mais confuso deste
          diálogo — vários agentes com o mesmo nome, e nenhuma pista de que a
          escolha certa era quase sempre "novo". O que falta escolher aqui é o
          LUGAR, e é isso que ficou. */}
      {draft.action === 'command' && (
        <>
          <div className="field-row">
            <label className="field-label">Onde</label>
            <span className="path-display" title={draft.cwd || defaultWorkingDirectory}>
              {shortenPath(draft.cwd) || shortenPath(defaultWorkingDirectory) || '(sem diretório)'}
            </span>
            <button type="button" className="btn" onClick={() => void browse()}>
              Procurar…
            </button>
            {draft.cwd && (
              <button type="button" className="btn" onClick={() => patch({ cwd: '' })}>
                Padrão
              </button>
            )}
          </div>
          <p className="field-hint">
            {draft.cwd
              ? 'Este botão roda sempre neste diretório, em qualquer canvas.'
              : 'Sem diretório próprio, o comando roda no projeto selecionado — ou na pasta do workspace, quando não há projeto.'}
          </p>
          {/* O diálogo não CRIA botões de comando com alvo, mas o CLI cria
              (`--target`). Esconder isso deixaria um botão escrevendo num
              terminal que o usuário não vê citado em lugar nenhum. */}
          {draft.target && (
            <div className="field-row">
              <label className="field-label">Terminal fixo</label>
              <span className="path-display">
                {(() => {
                  const node = terminals.find((n) => n.id === draft.target)
                  // O alvo pode ter sido excluído do canvas; nesse caso o botão
                  // já cai no terminal novo sozinho, e o campo diz isso.
                  return node ? agentOptionLabel(node, terminals) : '(não está mais no canvas)'
                })()}
              </span>
              <button type="button" className="btn" onClick={() => patch({ target: null })}>
                Usar terminal novo
              </button>
            </div>
          )}
        </>
      )}

      {draft.action === 'prompt' && (
        <>
          <div className="field-row">
            <label className="field-label">Agente</label>
            <select
              className="field-input"
              value={draft.target ?? ''}
              onChange={(e) => patch({ target: (e.target.value || null) as UUID | null })}
            >
              <option value="">(escolha um agente)</option>
              {eligible.map((n) => (
                <option key={n.id} value={n.id}>
                  {agentOptionLabel(n, eligible)}
                </option>
              ))}
            </select>
          </div>
          {eligible.length === 0 && (
            <p className="field-hint">
              Nenhum agente monitorado neste canvas — um prompt precisa de quem o
              escute, então crie o agente antes.
            </p>
          )}
        </>
      )}

      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.confirm}
          onChange={(e) => patch({ confirm: e.target.checked })}
        />
        Pedir confirmação antes de disparar
      </label>
    </div>
  )
}

/**
 * Meia dúzia de "Claude Code" no mesmo canvas é normal, e uma lista com o nome
 * repetido seis vezes não é escolha nenhuma. Só quem repete ganha o sufixo com
 * o começo do id — o mesmo desempate que o CLI usa.
 */
function agentOptionLabel(node: CanvasNode, all: CanvasNode[]): string {
  const name = node.content.type === 'terminal' ? node.content.value.name : node.id
  const repeats = all.filter(
    (n) => n.content.type === 'terminal' && n.content.value.name === name
  ).length
  return repeats > 1 ? `${name} · ${node.id.slice(0, 4)}` : name
}

function AppearanceTab({ draft, patch }: TabProps): JSX.Element {
  return (
    <div className="tab-pane">
      <span className="section-label">Ícone</span>
      <div className="icon-grid">
        {ICON_NAMES.map((n) => (
          <button
            key={n}
            type="button"
            className={n === draft.icon ? 'icon-cell is-selected' : 'icon-cell'}
            title={n}
            onClick={() => patch({ icon: n })}
          >
            <Icon name={n} size={20} />
          </button>
        ))}
      </div>

      <span className="section-label">Cor</span>
      <div className="swatch-row">
        {NODE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={c === draft.color ? 'swatch is-selected' : 'swatch'}
            style={{ background: c }}
            title={c}
            onClick={() => patch({ color: c })}
          />
        ))}
        <label className="swatch is-custom" title="Cor personalizada">
          <input type="color" value={draft.color} onChange={(e) => patch({ color: e.target.value })} />
        </label>
      </div>
    </div>
  )
}
