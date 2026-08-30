/**
 * Diálogo de terminal — "Novo" ou "Editar", o mesmo formulário nos dois casos.
 *
 * Três abas sobre o mesmo rascunho: Detalhes (o que roda), Aparência (como
 * aparece) e Agente (qual responsabilidade ele carrega). Nada é gravado até o
 * botão de confirmar — a única exceção é a responsabilidade, que é um arquivo
 * próprio em ~/.atelier/roles/ e é salva assim que o usuário confirma no editor.
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  AgentRole,
  ClaudeSessionSummary,
  TerminalDraft,
  TerminalTheme,
  UUID
} from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID } from '@shared/types'
import type { QuickStart } from '@shared/terminal-presets'
import {
  ARTISAN_COLOR,
  ARTISAN_ICON,
  ARTISAN_NAME,
  isArtisanCapable,
  isClaudeCommandLine
} from '@shared/terminal-presets'
import { ADD_ACCOUNT, accountLabel, isClaudeCommand } from '../claude-accounts'
import { Icon, ICON_NAMES } from '../node-icons'
import { shortenPath } from '../paths'
import { store, useStore } from '../state/store'
import {
  BUILTIN_THEMES,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  FONT_CHOICES,
  NODE_COLORS,
  QUICK_STARTS,
  SYSTEM_THEME_ID,
  fontLabel,
  resolveTheme
} from '../terminal-presets'
import { RoleEditor } from './role-editor'

type Tab = 'detalhes' | 'aparencia' | 'agente'
type RoleFilter = 'todos' | 'global' | 'workspace'

interface Props {
  /** Diretório padrão do workspace, usado quando o usuário não escolhe outro. */
  defaultWorkingDirectory: string
  /**
   * Rascunho de partida. Presente = modo edição: o Início Rápido some (não faz
   * sentido resetar um terminal que já roda) e o botão vira Salvar.
   */
  initial?: TerminalDraft | null
  onCancel: () => void
  onCreate: (draft: TerminalDraft) => void
}

function emptyDraft(workingDirectory: string): TerminalDraft {
  return {
    name: '',
    command: '',
    agentType: 'generic_shell',
    workingDirectory,
    icon: 'terminal',
    color: NODE_COLORS[0],
    // Fora do diálogo: monitorar fica sempre ligado (é o que faz `atelier ask`
    // saber quando o agente ficou ocioso) e maestro nasce desligado.
    monitorWithOmbro: true,
    isManager: false,
    themeId: SYSTEM_THEME_ID,
    fontFamily: null,
    fontSize: null,
    assignedRoleId: null,
    claudeAccountId: null,
    resumeSessionId: null,
    // Artesão nasce desligado: delegar em nós do canvas é uma decisão do
    // usuário sobre aquele agente, não o padrão de todo terminal.
    isArtisan: false
  }
}

export function NewTerminalDialog({
  defaultWorkingDirectory,
  initial = null,
  onCancel,
  onCreate
}: Props): JSX.Element {
  const { roles, prefs, workspace } = useStore()
  const editing = initial !== null
  const [tab, setTab] = useState<Tab>('detalhes')
  const [draft, setDraft] = useState<TerminalDraft>(
    () => initial ?? emptyDraft(defaultWorkingDirectory)
  )
  /** Preset escolhido só para destacar o cartão — o rascunho é a fonte da verdade. */
  const [quickId, setQuickId] = useState<string | null>(null)

  const patch = (p: Partial<TerminalDraft>): void => setDraft((d) => ({ ...d, ...p }))

  /**
   * Artesão vale em qualquer agente de IA; trocar o comando para um shell puro
   * DESMARCA, em vez de deixar a marca lá sem efeito.
   *
   * É o mesmo gesto do `assignedRoleId` quando a responsabilidade é apagada, e
   * pela mesma razão: um campo ligado que não liga nada mente para quem o leu no
   * diálogo — e aqui a mentira ainda ganharia um badge no cabeçalho do nó.
   */
  const artisanCapable = isArtisanCapable(draft)
  useEffect(() => {
    if (!artisanCapable && draft.isArtisan) patch({ isArtisan: false })
  }, [artisanCapable, draft.isArtisan])

  /** O preset por trás do rascunho — some no modo edição, onde `quickId` é null. */
  const presetOfDraft = (): QuickStart | null =>
    QUICK_STARTS.find((q) => q.id === quickId) ??
    QUICK_STARTS.find((q) => q.agentType === draft.agentType && q.command !== '') ??
    null

  /**
   * Marcar Artesão veste o nó: nome de partida, martelo e verde.
   *
   * PARTIDA, não imposição — um nome que o usuário digitou não é sobrescrito, e
   * a aba Aparência continua mandando depois. Desmarcar só desfaz o que esta
   * caixa pôs: se o ícone ainda é o martelo, ele volta para o do preset; se o
   * usuário trocou para outro, fica o dele.
   */
  const toggleArtisan = (on: boolean): void => {
    const preset = presetOfDraft()
    if (on) {
      const nameIsGeneric = draft.name.trim() === '' || QUICK_STARTS.some((q) => q.label === draft.name)
      patch({
        isArtisan: true,
        icon: ARTISAN_ICON,
        color: ARTISAN_COLOR,
        ...(nameIsGeneric ? { name: ARTISAN_NAME } : {})
      })
      return
    }
    patch({
      isArtisan: false,
      ...(draft.icon === ARTISAN_ICON ? { icon: preset?.icon ?? 'terminal' } : {}),
      ...(draft.color === ARTISAN_COLOR ? { color: preset?.color ?? NODE_COLORS[0] } : {}),
      ...(draft.name === ARTISAN_NAME ? { name: preset?.label ?? '' } : {})
    })
  }

  // Esc fecha, como qualquer folha do macOS
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

  const applyQuickStart = (id: string): void => {
    const preset = QUICK_STARTS.find((q) => q.id === id)
    if (!preset) return
    setQuickId(id)
    // O nome só é sobrescrito enquanto o usuário não digitou o dele
    const nameFromPreset = QUICK_STARTS.some((q) => q.label === draft.name) || draft.name === ''
    // Um Artesão já escolhido mantém a roupa dele: trocar o preset troca QUAL
    // agente roda, não o que o nó é. Sem isto, escolher "Codex" depois de marcar
    // a caixa devolveria o ícone do Codex e o nó perderia o martelo verde.
    const dress = draft.isArtisan
      ? { icon: ARTISAN_ICON, color: ARTISAN_COLOR }
      : { icon: preset.icon, color: preset.color }
    patch({
      command: preset.command,
      agentType: preset.agentType,
      ...dress,
      ...(nameFromPreset && !draft.isArtisan ? { name: preset.label } : {})
    })
  }

  const submit = (): void => {
    const name = draft.name.trim()
    onCreate({
      ...draft,
      name: name.length > 0 ? name : QUICK_STARTS.find((q) => q.id === quickId)?.label ?? 'Terminal'
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-label={editing ? 'Editar Terminal' : 'Novo Terminal'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{editing ? 'Editar Terminal' : 'Novo Terminal'}</h2>

        {!editing && (
        <section className="quick-start">
          <span className="section-label">Início Rápido</span>
          <div className="quick-start-row">
            {QUICK_STARTS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={preset.id === quickId ? 'quick-card is-selected' : 'quick-card'}
                onClick={() => applyQuickStart(preset.id)}
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
          {(['detalhes', 'aparencia', 'agente'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              className={t === tab ? 'segment is-active' : 'segment'}
              onClick={() => setTab(t)}
            >
              {t === 'detalhes' ? 'Detalhes' : t === 'aparencia' ? 'Aparência' : 'Agente'}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'detalhes' && (
            <DetailsTab
              draft={draft}
              patch={patch}
              onSubmit={submit}
              editing={editing}
              defaultWorkingDirectory={defaultWorkingDirectory}
              artisanCapable={artisanCapable}
              artisanStrong={isClaudeCommandLine(draft.command)}
              onToggleArtisan={toggleArtisan}
            />
          )}
          {tab === 'aparencia' && (
            <AppearanceTab draft={draft} patch={patch} customThemes={prefs?.terminalThemes ?? []} />
          )}
          {tab === 'agente' && (
            <AgentTab
              draft={draft}
              patch={patch}
              roles={roles}
              workspaceId={workspace?.id ?? null}
              workspaceName={workspace?.name ?? 'Workspace'}
            />
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

// ─── Detalhes ─────────────────────────────────────────────────────────────────

interface TabProps {
  draft: TerminalDraft
  patch: (p: Partial<TerminalDraft>) => void
}

function DetailsTab({
  draft,
  patch,
  onSubmit,
  editing = false,
  defaultWorkingDirectory,
  artisanCapable,
  artisanStrong,
  onToggleArtisan
}: TabProps & {
  onSubmit: () => void
  editing?: boolean
  defaultWorkingDirectory: string
  /** É um agente de IA? Shell puro não tem a quem instruir. */
  artisanCapable: boolean
  /** Dá para BLOQUEAR o subagente, ou só instruir? Só o Claude Code tem hook. */
  artisanStrong: boolean
  onToggleArtisan: (on: boolean) => void
}): JSX.Element {
  const browse = async (): Promise<void> => {
    const chosen = await window.atelier.dialog.chooseDirectory(draft.workingDirectory)
    if (chosen) patch({ workingDirectory: chosen })
  }

  return (
    <div className="tab-pane">
      <input
        autoFocus
        className="field-input is-large"
        value={draft.name}
        placeholder="Nome do Terminal"
        onChange={(e) => patch({ name: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
      />

      <div className="field-row">
        <label className="field-label">Comando</label>
        <input
          className="field-input"
          value={draft.command}
          placeholder="ex: claude, codex, ou deixe vazio para shell"
          onChange={(e) => patch({ command: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
      </div>

      <label className="check-row is-stacked">
        <input
          type="checkbox"
          checked={draft.isArtisan}
          disabled={!artisanCapable}
          onChange={(e) => onToggleArtisan(e.target.checked)}
        />
        <span>
          <strong>Artesão</strong>
          <em>
            {!artisanCapable
              ? 'precisa de um agente de IA no comando — um shell puro não tem a quem instruir'
              : artisanStrong
                ? 'delega abrindo agentes no canvas; aqui o subagente interno fica bloqueado'
                : 'delega abrindo agentes no canvas; fora do Claude Code a regra é instruída, não bloqueada'}
          </em>
        </span>
      </label>

      <ClaudeAccountField draft={draft} patch={patch} />

      <ResumeSessionField
        draft={draft}
        patch={patch}
        cwd={draft.workingDirectory || defaultWorkingDirectory}
      />

      <div className="field-row">
        <label className="field-label">Diretório de Trabalho</label>
        <span className="path-display" title={draft.workingDirectory}>
          {shortenPath(draft.workingDirectory) || '(diretório do workspace)'}
        </span>
        <button type="button" className="btn" onClick={() => void browse()}>
          Procurar…
        </button>
      </div>

      {editing && (
        <p className="field-hint">
          Nome, ícone, cor e responsabilidade valem na hora. Comando e diretório
          só valem no próximo boot do processo — use o ↻ do terminal.
        </p>
      )}
    </div>
  )
}

/**
 * Seletor de conta do Claude. Só aparece para terminal que roda `claude`: para
 * um shell ou para o Codex a linha seria ruído, porque `CLAUDE_CONFIG_DIR` não
 * significa nada para eles.
 *
 * "Adicionar conta…" cria só o DIRETÓRIO da conta. O login não acontece aqui —
 * acontece no terminal, quando o `claude` subir naquela conta e pedir /login.
 * É por isso que a conta recém-criada aparece marcada como não autenticada em
 * vez de o diálogo tentar autenticá-la.
 */
function ClaudeAccountField({ draft, patch }: TabProps): JSX.Element | null {
  const { claudeAccounts } = useStore()
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  if (!isClaudeCommand(draft)) return null

  const create = async (): Promise<void> => {
    const id = await store.createClaudeAccount(newLabel)
    setAdding(false)
    setNewLabel('')
    if (id) patch({ claudeAccountId: id })
  }

  return (
    <>
      <div className="field-row">
        <label className="field-label">Conta Claude</label>
        <select
          className="field-input"
          value={draft.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT_ID}
          onChange={(e) => {
            if (e.target.value === ADD_ACCOUNT) {
              setAdding(true)
              return
            }
            patch({
              claudeAccountId:
                e.target.value === DEFAULT_CLAUDE_ACCOUNT_ID ? null : e.target.value
            })
          }}
        >
          {claudeAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(a)}
            </option>
          ))}
          <option value={ADD_ACCOUNT}>Adicionar conta…</option>
        </select>
      </div>

      {adding && (
        <div className="inline-editor">
          <input
            autoFocus
            className="field-input"
            value={newLabel}
            placeholder="Nome da conta (ex: Trabalho)"
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button type="button" className="btn is-primary" onClick={() => void create()}>
            Criar
          </button>
          <button type="button" className="btn" onClick={() => setAdding(false)}>
            Cancelar
          </button>
          <p className="field-hint">
            A conta nasce sem login: abra um terminal nela e o próprio Claude
            pede o /login. Settings, skills e plugins do seu ~/.claude são
            reaproveitados.
          </p>
        </div>
      )}
    </>
  )
}

/**
 * Select "Retomar sessão" — as conversas anteriores do Claude Code neste
 * diretório. Só aparece para terminal `claude` (é o único CLI cuja gramática de
 * `--resume` conhecemos) e só quando há ao menos uma sessão: um select com uma
 * opção só seria ruído.
 *
 * A escolha é um HINT de boot, não estado durável — o main a consome no
 * primeiro spawn e a transforma na sessão gravada do nó. Por isso, em modo
 * edição, o valor volta a "Nova sessão" assim que o terminal reinicia.
 *
 * A lista recarrega quando o diretório ou a conta mudam: são elas que decidem
 * em qual pasta de `projects/` procurar.
 */
function ResumeSessionField({
  draft,
  patch,
  cwd
}: TabProps & { cwd: string }): JSX.Element | null {
  const claudeCmd = isClaudeCommand(draft)
  const [sessions, setSessions] = useState<ClaudeSessionSummary[] | null>(null)

  useEffect(() => {
    if (!claudeCmd || cwd.trim() === '') {
      setSessions(null)
      return
    }
    let alive = true
    setSessions(null)
    void window.atelier.terminal
      .resumableSessions(cwd, draft.claudeAccountId)
      .then((list) => alive && setSessions(list))
      .catch(() => alive && setSessions([]))
    return () => {
      alive = false
    }
  }, [claudeCmd, cwd, draft.claudeAccountId])

  if (!claudeCmd || !sessions || sessions.length === 0) return null

  return (
    <div className="field-row">
      <label className="field-label">Retomar sessão</label>
      <select
        className="field-input"
        value={draft.resumeSessionId ?? ''}
        onChange={(e) => patch({ resumeSessionId: (e.target.value as UUID) || null })}
      >
        <option value="">Nova sessão</option>
        {sessions.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {sessionOptionLabel(s)}
          </option>
        ))}
      </select>
    </div>
  )
}

/** "28/08 · corrige o crash no resume" — data curta, e o resto é a 1ª mensagem. */
function sessionOptionLabel(s: ClaudeSessionSummary): string {
  const when = new Date(s.modifiedAt)
  const date = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })
  return s.label ? `${date} · ${s.label}` : date || s.sessionId.slice(0, 8)
}

/** ~/Projetos/x em vez do caminho absoluto inteiro, como no app nativo. */

// ─── Aparência ────────────────────────────────────────────────────────────────

function AppearanceTab({
  draft,
  patch,
  customThemes
}: TabProps & { customThemes: TerminalTheme[] }): JSX.Element {
  const [editingTheme, setEditingTheme] = useState(false)
  const [themeName, setThemeName] = useState('Personalizado')
  const [themeBg, setThemeBg] = useState('#101014')
  const [themeFg, setThemeFg] = useState('#e6e6e6')
  const [pickingFont, setPickingFont] = useState(false)

  const preview = resolveTheme(draft.themeId, customThemes)

  const saveTheme = async (): Promise<void> => {
    const theme: TerminalTheme = {
      id: `custom-${Date.now().toString(36)}`,
      name: themeName.trim() || 'Personalizado',
      background: themeBg,
      foreground: themeFg
    }
    await store.patchPrefs({ terminalThemes: [...customThemes, theme] })
    patch({ themeId: theme.id })
    setEditingTheme(false)
  }

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
          <input
            type="color"
            value={draft.color}
            onChange={(e) => patch({ color: e.target.value })}
          />
        </label>
      </div>

      <span className="section-label">Tema</span>
      <div className="theme-row">
        {[...BUILTIN_THEMES, ...customThemes].map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={theme.id === (draft.themeId ?? SYSTEM_THEME_ID) ? 'theme-card is-selected' : 'theme-card'}
            onClick={() => patch({ themeId: theme.id })}
          >
            <span
              className="theme-preview"
              style={{
                background: resolveTheme(theme.id, customThemes).background,
                color: resolveTheme(theme.id, customThemes).foreground
              }}
            >
              ~/dev
              <br />$ ▮
            </span>
            <span>{theme.name}</span>
          </button>
        ))}
        <button type="button" className="theme-card is-add" onClick={() => setEditingTheme(true)}>
          <span className="theme-preview is-add">+</span>
          <span>Personalizado</span>
        </button>
      </div>

      {editingTheme && (
        <div className="inline-editor">
          <input
            className="field-input"
            value={themeName}
            placeholder="Nome do tema"
            onChange={(e) => setThemeName(e.target.value)}
          />
          <label className="color-field">
            Fundo
            <input type="color" value={themeBg} onChange={(e) => setThemeBg(e.target.value)} />
          </label>
          <label className="color-field">
            Texto
            <input type="color" value={themeFg} onChange={(e) => setThemeFg(e.target.value)} />
          </label>
          <button type="button" className="btn" onClick={() => setEditingTheme(false)}>
            Cancelar
          </button>
          <button type="button" className="btn is-primary" onClick={() => void saveTheme()}>
            Salvar tema
          </button>
        </div>
      )}

      <span className="section-label">Fonte</span>
      <div className="font-row">
        <span className="font-name">{fontLabel(draft.fontFamily)}</span>
        <span className="font-size">{draft.fontSize ?? DEFAULT_FONT_SIZE}pt</span>
        <button
          type="button"
          className="icon-btn ghost-btn"
          title="Voltar ao padrão"
          onClick={() => patch({ fontFamily: null, fontSize: null })}
        >
          ↺
        </button>
        <button type="button" className="btn" onClick={() => setPickingFont((v) => !v)}>
          Selecionar…
        </button>
      </div>

      {pickingFont && (
        <div className="inline-editor">
          <select
            className="field-input"
            value={draft.fontFamily ?? DEFAULT_FONT_FAMILY}
            onChange={(e) =>
              patch({ fontFamily: e.target.value === DEFAULT_FONT_FAMILY ? null : e.target.value })
            }
          >
            {FONT_CHOICES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <input
            className="field-input is-narrow"
            type="number"
            min={8}
            max={32}
            value={draft.fontSize ?? DEFAULT_FONT_SIZE}
            onChange={(e) => patch({ fontSize: Number(e.target.value) })}
          />
        </div>
      )}

      <div
        className="font-preview"
        style={{
          fontFamily: draft.fontFamily ?? DEFAULT_FONT_FAMILY,
          fontSize: draft.fontSize ?? DEFAULT_FONT_SIZE,
          background: preview.background,
          color: preview.foreground
        }}
      >
        abc 012 →|←
      </div>
    </div>
  )
}

// ─── Agente ───────────────────────────────────────────────────────────────────

function AgentTab({
  draft,
  patch,
  roles,
  workspaceId,
  workspaceName
}: TabProps & {
  roles: AgentRole[]
  workspaceId: UUID | null
  workspaceName: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RoleFilter>('todos')
  /** null = não estamos editando; undefined = criando uma nova. */
  const [editing, setEditing] = useState<AgentRole | null | undefined>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return roles
      .filter((r) => r.workspaceId === null || r.workspaceId === workspaceId)
      .filter((r) =>
        filter === 'global' ? r.workspaceId === null : filter === 'workspace' ? r.workspaceId === workspaceId : true
      )
      .filter((r) => needle === '' || r.name.toLowerCase().includes(needle))
  }, [roles, query, filter, workspaceId])

  if (editing !== null) {
    return (
      <div className="tab-pane">
        <RoleEditor
          role={editing ?? null}
          workspaceId={workspaceId}
          onCancel={() => setEditing(null)}
          onDone={(saved) => {
            setEditing(null)
            if (saved) patch({ assignedRoleId: saved.id })
            // Responsabilidade apagada: o rascunho não pode ficar apontando para ela
            else if (editing && draft.assignedRoleId === editing.id) patch({ assignedRoleId: null })
          }}
        />
      </div>
    )
  }

  return (
    <div className="tab-pane">
      <p className="tab-hint">Atribua uma responsabilidade para definir o foco deste agente.</p>

      <input
        className="field-input"
        value={query}
        placeholder="Buscar…"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="segmented is-small">
        {(['todos', 'global', 'workspace'] as RoleFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={f === filter ? 'segment is-active' : 'segment'}
            onClick={() => setFilter(f)}
          >
            {f === 'todos' ? 'Todos' : f === 'global' ? 'Global' : workspaceName}
          </button>
        ))}
      </div>

      <div className="role-grid">
        <button type="button" className="role-card is-add" onClick={() => setEditing(undefined)}>
          <span className="role-plus">+</span>
          <span>Novo</span>
        </button>

        {visible.map((role) => (
          <div
            key={role.id}
            className={role.id === draft.assignedRoleId ? 'role-card is-selected' : 'role-card'}
            onClick={() =>
              patch({ assignedRoleId: role.id === draft.assignedRoleId ? null : role.id })
            }
            title={role.instructions || 'Sem instruções'}
          >
            <span className="role-icon" style={{ color: role.color }}>
              <Icon name={role.icon} size={26} />
            </span>
            <span>{role.name}</span>
            <button
              type="button"
              className="role-edit"
              title="Editar responsabilidade"
              onClick={(e) => {
                e.stopPropagation()
                setEditing(role)
              }}
            >
              ✎
            </button>
          </div>
        ))}
      </div>

      <div className="role-grid-footer">
        <button
          type="button"
          className="btn"
          disabled={draft.assignedRoleId === null}
          onClick={() => patch({ assignedRoleId: null })}
        >
          Remover responsabilidade
        </button>
      </div>
    </div>
  )
}
