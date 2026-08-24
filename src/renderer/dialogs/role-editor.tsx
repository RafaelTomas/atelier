/**
 * Editor de responsabilidade — o "Novo" da aba Agente.
 *
 * Uma responsabilidade é um arquivo em ~/.atelier/roles/. O texto de
 * `instructions` é o que o agente lê quando roda `atelier role` dentro do
 * terminal, então ele é o conteúdo de verdade aqui: o resto é identidade
 * visual (nome, ícone, cor) e escopo (global ou só deste workspace).
 */
import { useState } from 'react'
import type { AgentRole, UUID } from '@shared/types'
import { Icon, ICON_NAMES } from '../node-icons'
import { store } from '../state/store'
import { NODE_COLORS } from '../terminal-presets'

interface Props {
  /** null = criando uma nova. */
  role: AgentRole | null
  workspaceId: UUID | null
  onDone: (saved: AgentRole | null) => void
  onCancel: () => void
}

export function RoleEditor({ role, workspaceId, onDone, onCancel }: Props): JSX.Element {
  const [name, setName] = useState(role?.name ?? '')
  const [icon, setIcon] = useState(role?.icon ?? 'sparkle')
  const [color, setColor] = useState(role?.color ?? NODE_COLORS[0])
  const [instructions, setInstructions] = useState(role?.instructions ?? '')
  const [scopeGlobal, setScopeGlobal] = useState(role ? role.workspaceId === null : false)
  const [busy, setBusy] = useState(false)

  const canSave = name.trim().length > 0 && !busy

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    try {
      const saved = await store.saveRole({
        id: role?.id,
        name: name.trim(),
        icon,
        color,
        instructions,
        workspaceId: scopeGlobal ? null : workspaceId
      })
      onDone(saved)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!role) return
    setBusy(true)
    try {
      await store.removeRole(role.id)
      onDone(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="role-editor">
      <div className="field-row">
        <input
          autoFocus
          className="field-input"
          value={name}
          placeholder="Nome da responsabilidade"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="icon-grid is-compact">
        {ICON_NAMES.map((n) => (
          <button
            key={n}
            type="button"
            className={n === icon ? 'icon-cell is-selected' : 'icon-cell'}
            title={n}
            onClick={() => setIcon(n)}
          >
            <Icon name={n} size={18} />
          </button>
        ))}
      </div>

      <div className="swatch-row">
        {NODE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={c === color ? 'swatch is-selected' : 'swatch'}
            style={{ background: c }}
            title={c}
            onClick={() => setColor(c)}
          />
        ))}
        <label className="swatch is-custom" title="Cor personalizada">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
      </div>

      <textarea
        className="field-textarea"
        rows={6}
        value={instructions}
        placeholder={'O que este agente faz. Ex.:\n\nVocê cuida do frontend. Revise acessibilidade e responsividade antes de aprovar qualquer mudança de UI.'}
        onChange={(e) => setInstructions(e.target.value)}
      />

      <label className="check-row" title="Global aparece em todos os workspaces">
        <input
          type="checkbox"
          checked={scopeGlobal}
          onChange={(e) => setScopeGlobal(e.target.checked)}
        />
        <span>Disponível em todos os workspaces</span>
      </label>

      <div className="role-editor-actions">
        {role && (
          <button type="button" className="btn is-danger" disabled={busy} onClick={() => void remove()}>
            Excluir
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="btn is-primary" disabled={!canSave} onClick={() => void save()}>
          Salvar
        </button>
      </div>
    </div>
  )
}
