/**
 * Terminais — CRUD de temas de terminal, e o tema, a fonte e o corpo padrão de
 * um terminal novo.
 *
 * `terminalThemes` nunca teve interface: a única forma de nascer um tema
 * personalizado era o editor inline da aba Aparência do diálogo de terminal
 * (`saveTheme` em new-terminal-dialog.tsx), que cria mas não deixa renomear
 * nem apagar. Aqui é o CRUD completo — os três embutidos (`BUILTIN_THEMES`)
 * aparecem travados, com cadeado, porque não vivem em `preferences.json` e
 * `resolveTheme` os resolve por id fixo.
 *
 * As três chaves de padrão (`terminalThemeId`, `terminalFontFamily`,
 * `terminalFontSize`) só valem para um terminal NOVO: um nó já criado grava a
 * escolha dele em `TerminalDraft.themeId/fontFamily/fontSize` e não muda
 * quando o padrão muda depois — a mesma relação que um `defaultValue` tem com
 * o valor de um campo já preenchido.
 */
import { useEffect, useState } from 'react'
import type { TerminalTheme } from '@shared/types'
import {
  BUILTIN_THEMES,
  DEFAULT_FONT_SIZE,
  FONT_CHOICES,
  resolveTheme,
  SYSTEM_THEME_ID
} from '../../terminal-presets'
import { store, useStore } from '../../state/store'
import { SettingsRow, SettingsSection, SettingsSelect } from '../settings-rows'

/**
 * Rótulo e dica de cada linha do grupo — a MESMA constante que a busca da
 * tela lê (ver `search-index.ts`).
 */
export const ROWS = {
  temas: {
    label: 'Temas de terminal',
    hint: 'Os três embutidos não podem ser editados nem apagados.'
  },
  novoTema: { label: 'Novo tema' },
  temaPadrao: {
    label: 'Tema',
    hint: 'Vale só para o próximo terminal criado — um já existente mantém a escolha dele.'
  },
  fonte: { label: 'Fonte' },
  tamanho: { label: 'Tamanho', hint: 'Entre 8 e 32.' }
} satisfies Record<string, { label: string; hint?: string }>

export function TerminalsSettings(): JSX.Element {
  const { prefs } = useStore()
  const customThemes = prefs?.terminalThemes ?? []
  const themeId = prefs?.terminalThemeId ?? SYSTEM_THEME_ID
  const fontFamily = prefs?.terminalFontFamily ?? FONT_CHOICES[0].value
  const fontSize = prefs?.terminalFontSize ?? DEFAULT_FONT_SIZE

  return (
    <>
      <SettingsSection title="Temas">
        <SettingsRow label={ROWS.temas.label} hint={ROWS.temas.hint}>
          <ThemeList customThemes={customThemes} activeId={themeId} />
        </SettingsRow>
        <NewThemeRow customThemes={customThemes} />
      </SettingsSection>

      <SettingsSection title="Padrão de terminal novo">
        <SettingsSelect
          label={ROWS.temaPadrao.label}
          hint={ROWS.temaPadrao.hint}
          options={[...BUILTIN_THEMES, ...customThemes].map((t) => ({
            value: t.id,
            label: t.name
          }))}
          value={themeId}
          onChange={(value) => void store.setPrefs({ terminalThemeId: value })}
        />
        <SettingsSelect
          label={ROWS.fonte.label}
          options={FONT_CHOICES}
          value={fontFamily}
          onChange={(value) => void store.setPrefs({ terminalFontFamily: value })}
        />
        <FontSizeRow size={fontSize} />
      </SettingsSection>
    </>
  )
}

// ─── Lista de temas ─────────────────────────────────────────────────────────

function ThemeList({
  customThemes,
  activeId
}: {
  customThemes: TerminalTheme[]
  activeId: string
}): JSX.Element {
  return (
    <div className="settings-theme-list">
      {BUILTIN_THEMES.map((theme) => (
        <div key={theme.id} className="settings-theme-item">
          <ThemeSwatch theme={resolveTheme(theme.id, customThemes)} />
          <span className="settings-theme-name">{theme.name}</span>
          <span className="settings-theme-lock" title="Tema embutido, não pode ser alterado">
            🔒
          </span>
        </div>
      ))}
      {customThemes.map((theme) => (
        <CustomThemeItem key={theme.id} theme={theme} customThemes={customThemes} activeId={activeId} />
      ))}
    </div>
  )
}

function ThemeSwatch({ theme }: { theme: TerminalTheme }): JSX.Element {
  return (
    <span
      className="settings-theme-swatch"
      style={{ background: theme.background, color: theme.foreground }}
    >
      Aa
    </span>
  )
}

/**
 * Um tema personalizado: nome (renomeia no blur/Enter), duas amostras de cor
 * que gravam ao soltar o seletor nativo, e apagar.
 */
function CustomThemeItem({
  theme,
  customThemes,
  activeId
}: {
  theme: TerminalTheme
  customThemes: TerminalTheme[]
  activeId: string
}): JSX.Element {
  const [name, setName] = useState(theme.name)
  useEffect(() => setName(theme.name), [theme.name])

  const patch = (p: Partial<TerminalTheme>): void => {
    void store.setPrefs({
      terminalThemes: customThemes.map((t) => (t.id === theme.id ? { ...t, ...p } : t))
    })
  }

  const commitName = (): void => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setName(theme.name)
      return
    }
    if (trimmed !== theme.name) patch({ name: trimmed })
  }

  const remove = (): void => {
    if (!window.confirm(`Apagar o tema "${theme.name}"?`)) return
    // Nenhum nó precisa migrar: `resolveTheme` já cai em 'system' para um id
    // que não existe mais em BUILTIN_THEMES nem em `custom` — ver
    // terminal-presets.ts. Um terminal que apontava para este tema volta ao
    // do sistema sozinho, na próxima renderização.
    void store.setPrefs({ terminalThemes: customThemes.filter((t) => t.id !== theme.id) })
  }

  return (
    <div className="settings-theme-item">
      <ThemeSwatch theme={theme} />
      <input
        className="settings-theme-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <label className="color-field" title="Cor de fundo">
        <input
          type="color"
          value={theme.background}
          onChange={(e) => patch({ background: e.target.value })}
        />
      </label>
      <label className="color-field" title="Cor do texto">
        <input
          type="color"
          value={theme.foreground}
          onChange={(e) => patch({ foreground: e.target.value })}
        />
      </label>
      <button
        type="button"
        className="icon-btn ghost-btn"
        title={theme.id === activeId ? 'Em uso como padrão de terminal novo' : 'Apagar tema'}
        onClick={remove}
      >
        🗑
      </button>
    </div>
  )
}

/** Criar tema: nome, fundo e texto — os mesmos três campos do editor inline do diálogo de terminal. */
function NewThemeRow({ customThemes }: { customThemes: TerminalTheme[] }): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('Personalizado')
  const [bg, setBg] = useState('#101014')
  const [fg, setFg] = useState('#e6e6e6')

  const create = (): void => {
    const theme: TerminalTheme = {
      id: `custom-${Date.now().toString(36)}`,
      name: name.trim() || 'Personalizado',
      background: bg,
      foreground: fg
    }
    void store.setPrefs({ terminalThemes: [...customThemes, theme] })
    setCreating(false)
    setName('Personalizado')
    setBg('#101014')
    setFg('#e6e6e6')
  }

  if (!creating) {
    return (
      <SettingsRow label={ROWS.novoTema.label}>
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          Criar tema…
        </button>
      </SettingsRow>
    )
  }

  return (
    <SettingsRow label="Novo tema">
      <div className="inline-editor">
        <input
          autoFocus
          className="field-input"
          value={name}
          placeholder="Nome do tema"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <label className="color-field">
          Fundo
          <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
        </label>
        <label className="color-field">
          Texto
          <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} />
        </label>
        <button type="button" className="btn" onClick={() => setCreating(false)}>
          Cancelar
        </button>
        <button type="button" className="btn is-primary" onClick={create}>
          Salvar tema
        </button>
      </div>
    </SettingsRow>
  )
}

// ─── Fonte e corpo padrão ────────────────────────────────────────────────────

/**
 * O corpo em número, grampeado em 8..32 — o mesmo teto que `clampFontSize`
 * aplica ao decodificar `preferences.json`, para o campo nunca sugerir um
 * valor que o disco vai rejeitar.
 */
function FontSizeRow({ size }: { size: number }): JSX.Element {
  const [draft, setDraft] = useState(String(size))
  useEffect(() => setDraft(String(size)), [size])

  const commit = (): void => {
    const value = Number(draft)
    if (!Number.isFinite(value)) {
      setDraft(String(size))
      return
    }
    const clamped = Math.round(Math.max(8, Math.min(32, value)))
    setDraft(String(clamped))
    if (clamped !== size) void store.setPrefs({ terminalFontSize: clamped })
  }

  return (
    <SettingsRow label={ROWS.tamanho.label} hint={ROWS.tamanho.hint} htmlFor="settings-terminal-font-size">
      <div className="settings-number">
        <input
          id="settings-terminal-font-size"
          type="number"
          min={8}
          max={32}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="settings-number-unit">pt</span>
      </div>
    </SettingsRow>
  )
}
