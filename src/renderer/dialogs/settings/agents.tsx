/**
 * Agentes e Contas — a fase que justifica o projeto inteiro.
 *
 * Antes desta tela, o ÚNICO caminho até as contas do Claude (criar, renomear,
 * apagar com os arquivos) era o popover da tira do monitor — que o próprio
 * usuário pode ter desligado em `monitorDockVisible`. Uma preferência podia
 * esconder o acesso a outra. Este grupo não substitui a tira (ela continua
 * valendo por ser mais rápida durante o trabalho); ele garante que o caminho
 * exista mesmo quando ela está fora.
 *
 * A linha de conta (`AccountLine`) é a MESMA que a tira desenha — ver
 * `panels/monitor-parts.tsx`, para onde ela foi extraída nesta fase. Duas
 * linhas que discordassem de quando uma conta está "sem login" seriam piores
 * que uma só; aqui ela só ganha um slot extra de botões (renomear, remover)
 * que a tira não usa.
 *
 * Responsabilidades reaproveita o `RoleEditor` já escrito para o diálogo de
 * terminal — é o ÚNICO ponto do plano em que um modal abre sobre outro. A
 * alternativa (editor inline nesta página) foi descartada por duplicar o
 * editor que já existe. Ver `RoleEditorOverlay` abaixo para como o Esc fica
 * restrito ao modal de cima.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AccountRow, AccountUsage } from '@shared/agent-usage'
import { groupByAccount, mergeReading } from '@shared/agent-usage'
import type { AgentRole, ClaudeAccountInfo } from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID } from '@shared/types'
import { AccountLine, CodexAccountLine } from '../../panels/monitor-parts'
import { IconPencil, IconPlus, IconReload, IconTrash } from '../../icons'
import { Icon, isIconName } from '../../node-icons'
import { store, useStore } from '../../state/store'
import { RoleEditor } from '../role-editor'
import { SettingsRow, SettingsSection } from '../settings-rows'

/**
 * Rótulo e dica de cada linha do grupo — a MESMA constante que a busca da
 * tela lê (ver `search-index.ts`).
 */
export const ROWS = {
  contas: {
    label: 'Contas',
    hint: 'Cada conta é um diretório de configuração próprio. O login acontece no terminal, com /login — criar aqui não autentica nada.'
  },
  codex: {
    label: 'Conta',
    hint: 'Estado da conta e do uso — a mesma leitura da tira do monitor.'
  },
  responsabilidades: {
    label: 'Agentes',
    hint: 'O que um terminal lê ao rodar `atelier role`. Global aparece em todos os workspaces.'
  }
} satisfies Record<string, { label: string; hint?: string }>

export function AgentsSettings(): JSX.Element {
  const [editingRole, setEditingRole] = useState<AgentRole | null | undefined>(null)

  return (
    <>
      <ClaudeAccountsSection />
      <CodexSection />
      <RolesSection editingRole={editingRole} onEditRole={setEditingRole} />
    </>
  )
}

// ─── Contas do Claude ───────────────────────────────────────────────────────

function ClaudeAccountsSection(): JSX.Element {
  const { workspace, claudeAccounts, claudeAccountUsage, terminalStatus, terminalUsage } = useStore()
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  // A MESMA conta do bloco de Perfis do monitor (ver monitor-panel.tsx):
  // terminal por terminal, resolvido para a conta em que ele roda, agrupado
  // pela conta — a leitura guardada é o piso para quem não tem terminal
  // aberto agora. Duplicar essa regra em vez de importar `AccountsBlock`
  // inteiro é o preço de a tela de Configurações não ser dona de nó de
  // workspace nenhum; o CÁLCULO (`groupByAccount`) é o mesmo, só a lista de
  // contas de entrada muda.
  const usage = useMemo(() => {
    const known = new Set(claudeAccounts.map((a) => a.id))
    const resolve = (id: string | null): string =>
      id && known.has(id) ? id : DEFAULT_CLAUDE_ACCOUNT_ID
    const rows: AccountRow[] = []
    for (const node of workspace?.nodes ?? []) {
      if (node.content.type !== 'terminal') continue
      rows.push({
        accountId: resolve(node.content.value.claudeAccountId),
        reading: mergeReading(terminalUsage[node.id], terminalStatus[node.id])
      })
    }
    return new Map(groupByAccount(rows, claudeAccountUsage).map((a) => [a.accountId, a]))
  }, [workspace, claudeAccounts, claudeAccountUsage, terminalStatus, terminalUsage])

  const create = async (): Promise<void> => {
    const name = newLabel.trim()
    if (!name) return
    await store.createClaudeAccount(name)
    setNewLabel('')
    setAdding(false)
  }

  return (
    <SettingsSection title="Contas do Claude">
      <SettingsRow label={ROWS.contas.label} hint={ROWS.contas.hint}>
        <div className="settings-accounts">
          <div className="settings-accounts-header">
            <button
              type="button"
              className="icon-btn ghost-btn"
              title="Reler contas"
              onClick={() => void store.refreshClaudeAccounts()}
            >
              <IconReload size={12} />
            </button>
          </div>

          <ul className="monitor-accounts settings-account-list">
            {claudeAccounts.map((account) => (
              <ClaudeAccountRow key={account.id} account={account} usage={usage.get(account.id)} />
            ))}
          </ul>

          {adding ? (
            <div className="monitor-account-add">
              <input
                autoFocus
                className="monitor-input"
                placeholder="Nome da conta (ex: Trabalho)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create()
                  if (e.key === 'Escape') setAdding(false)
                  e.stopPropagation()
                }}
              />
              <button type="button" className="btn is-primary" onClick={() => void create()}>
                Criar
              </button>
              <button type="button" className="btn" onClick={() => setAdding(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <IconPlus size={12} /> Adicionar conta…
            </button>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

/**
 * Uma conta: a linha compartilhada com a tira, mais renomear e remover — os
 * dois gestos que a tira nunca ofereceu, e a razão desta seção existir.
 *
 * A conta padrão (`~/.claude`) não tem diretório próprio — `rename`/`remove`
 * no main a ignoram — então os dois botões nem aparecem nela: um botão que
 * não faz nada é pior que a ausência dele.
 */
function ClaudeAccountRow({
  account,
  usage
}: {
  account: ClaudeAccountInfo
  usage?: AccountUsage
}): JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [label, setLabel] = useState(account.label)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)

  useEffect(() => setLabel(account.label), [account.label])

  const isDefault = account.id === DEFAULT_CLAUDE_ACCOUNT_ID

  const commitRename = (): void => {
    const trimmed = label.trim()
    setRenaming(false)
    if (trimmed === '' || trimmed === account.label) {
      setLabel(account.label)
      return
    }
    void store.renameClaudeAccount(account.id, trimmed)
  }

  const remove = async (): Promise<void> => {
    await store.removeClaudeAccount(account.id, deleteFiles)
    setConfirmingRemove(false)
    setDeleteFiles(false)
  }

  if (renaming) {
    return (
      <li className="monitor-account">
        <input
          autoFocus
          className="settings-account-rename"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setLabel(account.label)
              setRenaming(false)
            }
            e.stopPropagation()
          }}
        />
      </li>
    )
  }

  return (
    <>
      <AccountLine
        account={account}
        usage={usage}
        actions={
          !isDefault && (
            <span className="settings-account-actions">
              <button
                type="button"
                className="icon-btn ghost-btn"
                title="Renomear conta"
                onClick={() => setRenaming(true)}
              >
                <IconPencil size={12} />
              </button>
              <button
                type="button"
                className="icon-btn ghost-btn"
                title="Remover conta"
                onClick={() => setConfirmingRemove((v) => !v)}
              >
                <IconTrash size={12} />
              </button>
            </span>
          )
        }
      />

      {confirmingRemove && (
        <li className="settings-account-confirm">
          <label className="check-row">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
            />
            <span>Apagar também os arquivos (credencial e histórico desta conta)</span>
          </label>
          <span className="settings-account-confirm-actions">
            <button type="button" className="btn" onClick={() => setConfirmingRemove(false)}>
              Cancelar
            </button>
            <button type="button" className="btn is-danger" onClick={() => void remove()}>
              Remover conta
            </button>
          </span>
        </li>
      )}
    </>
  )
}

// ─── Codex ──────────────────────────────────────────────────────────────────

/** Só leitura — o Codex não tem múltiplas contas no Atelier, é o login do processo. */
function CodexSection(): JSX.Element {
  const { codexAccountUsage } = useStore()

  useEffect(() => {
    void store.subscribeCodexAccount()
    return () => {
      void store.unsubscribeCodexAccount()
    }
  }, [])

  return (
    <SettingsSection title="Codex">
      <SettingsRow label={ROWS.codex.label} hint={ROWS.codex.hint}>
        <div className="settings-accounts">
          {codexAccountUsage.available ? (
            <ul className="monitor-accounts">
              <CodexAccountLine usage={codexAccountUsage} />
            </ul>
          ) : (
            <span className="settings-soon">nenhum agente Codex leu esta conta ainda</span>
          )}
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Reler o estado da conta Codex"
            onClick={() => void store.refreshCodexAccount()}
          >
            <IconReload size={12} />
          </button>
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}

// ─── Responsabilidades ──────────────────────────────────────────────────────

function RolesSection({
  editingRole,
  onEditRole
}: {
  /** `undefined` = criando uma nova; `null` = nenhum editor aberto. */
  editingRole: AgentRole | null | undefined
  onEditRole: (role: AgentRole | null | undefined) => void
}): JSX.Element {
  const { roles, workspace } = useStore()
  const workspaceId = workspace?.id ?? null

  const visible = useMemo(
    () => roles.filter((r) => r.workspaceId === null || r.workspaceId === workspaceId),
    [roles, workspaceId]
  )

  return (
    <SettingsSection title="Responsabilidades">
      <SettingsRow label={ROWS.responsabilidades.label} hint={ROWS.responsabilidades.hint}>
        <div className="settings-roles">
          {visible.length === 0 ? (
            <p className="monitor-empty">nenhuma responsabilidade ainda</p>
          ) : (
            <ul className="settings-role-list">
              {visible.map((role) => (
                <li key={role.id} className="settings-role-item">
                  <span className="settings-role-swatch" style={{ background: role.color }}>
                    <Icon name={isIconName(role.icon) ? role.icon : 'sparkle'} size={16} />
                  </span>
                  <span className="settings-role-name">{role.name}</span>
                  <span className="settings-role-scope">
                    {role.workspaceId === null ? 'Global' : 'Este workspace'}
                  </span>
                  <button type="button" className="btn" onClick={() => onEditRole(role)}>
                    Editar
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn" onClick={() => onEditRole(undefined)}>
            <IconPlus size={12} /> Nova responsabilidade…
          </button>
        </div>
      </SettingsRow>

      {editingRole !== null && (
        <RoleEditorOverlay
          role={editingRole ?? null}
          workspaceId={workspaceId}
          onDone={() => onEditRole(null)}
          onCancel={() => onEditRole(null)}
        />
      )}
    </SettingsSection>
  )
}

/**
 * O `RoleEditor` num modal PRÓPRIO, por cima do modal de Configurações.
 *
 * `settings-dialog.tsx` escuta Esc em CAPTURA no `window` para fechar a tela
 * inteira, e não tem (nem deveria ter) conhecimento de que um grupo seu abriu
 * outro modal por cima. Quem sabe disso é este componente, e é ele que vence
 * a corrida pelo Esc: registra o PRÓPRIO ouvinte de captura no mesmo `window`
 * — e o React sempre efetiva os efeitos dos filhos antes dos pais dentro do
 * mesmo commit. Este componente só existe dentro da árvore de Configurações,
 * então toda vez que os dois passam a existir juntos (a tela abre já neste
 * grupo, ou o usuário troca de grupo para este), o ouvinte DELE entra na
 * lista antes do de `settings-dialog.tsx`. `stopImmediatePropagation` faz o
 * resto: impede o ouvinte de Configurações de rodar depois do nosso no mesmo
 * evento, então só o editor fecha.
 */
function RoleEditorOverlay({
  role,
  workspaceId,
  onDone,
  onCancel
}: {
  role: AgentRole | null
  workspaceId: string | null
  onDone: (saved: AgentRole | null) => void
  onCancel: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div
      className="modal-backdrop settings-role-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="modal settings-role-modal"
        role="dialog"
        aria-label={role ? 'Editar Responsabilidade' : 'Nova Responsabilidade'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{role ? 'Editar Responsabilidade' : 'Nova Responsabilidade'}</h2>
        <div className="modal-body">
          <RoleEditor role={role} workspaceId={workspaceId} onDone={onDone} onCancel={onCancel} />
        </div>
      </div>
    </div>
  )
}
