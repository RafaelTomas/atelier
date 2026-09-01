/**
 * Aparência — o primeiro grupo da tela, e o que prova o caminho inteiro.
 *
 * Tudo aqui já tinha efeito no app antes desta tela existir; nenhuma linha
 * oferece uma preferência que não seja aplicada em algum lugar. Duas ficaram de
 * fora por isso mesmo:
 *
 * - `fontSize` e `fontFamily` são gravados e HOJE não são lidos por nada da
 *   interface. Entram na fase 3, restritos ao terminal, onde o `resolveTheme`
 *   já os consome. Um seletor de fonte que não muda fonte nenhuma é pior que
 *   fonte nenhuma para escolher.
 * - `language`, pela mesma razão: não há string traduzida para ele escolher.
 *
 * Nenhum controle guarda estado. Tema, desenho, cor e espessura da corda e
 * largura da rail passam pelos verbos que a store já tinha — os MESMOS que os
 * controles de contexto chamam —, e não pelo `setPrefs` genérico: essas quatro
 * têm estado derivado (o `data-theme` do `<html>`, a variável `--rope`, a
 * `--rail-panel-width`) que só aqueles verbos mantêm em dia. É o que faz mudar
 * o tema por aqui acender o ✓ no menu ◑ do canvas no mesmo instante.
 */
import { useEffect, useState } from 'react'
import { ROPE_THICKNESS_MAX, ROPE_THICKNESS_MIN } from '@shared/types'
import { ROPE_COLORS, ROPE_STYLES } from '../../canvas/rope-shapes'
import { RopeStylePreview } from '../../canvas/rope-style-preview'
import { RAIL_WIDTH } from '../../rail'
import { store, useStore } from '../../state/store'
import { SettingsRow, SettingsSection, SettingsSelect } from '../settings-rows'
import type { ThemeMode } from '../../theme'

const THEMES: readonly { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' }
]

/** Os três modos que o `CanvasBackground` sabe desenhar — ver canvas/background.tsx. */
type BackgroundMode = 'grid' | 'dots' | 'plain'

const BACKGROUNDS: readonly { value: BackgroundMode; label: string }[] = [
  { value: 'grid', label: 'Grade' },
  { value: 'dots', label: 'Pontos' },
  { value: 'plain', label: 'Liso' }
]

/**
 * Rótulo e dica de cada linha do grupo — a MESMA constante que a busca da tela
 * lê (ver `search-index.ts`). O JSX abaixo referencia `ROWS.x.label`/`.hint`
 * em vez de repetir as strings, para que editar uma linha aqui não possa
 * deixar a busca desatualizada: os dois leem do mesmo lugar.
 */
export const ROWS = {
  tema: { label: 'Tema', hint: 'Sistema acompanha o claro/escuro do sistema operacional.' },
  fundo: {
    label: 'Fundo do canvas',
    hint: 'A grade some sozinha quando o zoom fica pequeno demais para ela.'
  },
  desenho: {
    label: 'Desenho',
    hint: 'O mesmo seletor que fica ao lado dos controles de vista, no canto do canvas.'
  },
  cor: { label: 'Cor', hint: '“Padrão do tema” deixa o cinza acompanhar o claro e o escuro.' },
  espessura: { label: 'Espessura' },
  railWidth: {
    label: 'Largura da coluna',
    hint: `Entre ${RAIL_WIDTH.min} e ${RAIL_WIDTH.max} px. Também se ajusta arrastando a borda da rail.`
  }
} satisfies Record<string, { label: string; hint?: string }>

/** Chave ausente ou com lixo dentro cai na grade, que é o fundo histórico. */
function backgroundOf(value: string | undefined): BackgroundMode {
  return value === 'dots' || value === 'plain' ? value : 'grid'
}

export function AppearanceSettings(): JSX.Element {
  const { prefs, theme, ropeStyle, ropeThickness, ropeColor } = useStore()

  return (
    <>
      <SettingsSection title="Tema">
        <SettingsSelect
          label={ROWS.tema.label}
          hint={ROWS.tema.hint}
          options={THEMES}
          value={theme}
          onChange={(value) => store.setTheme(value)}
        />
        <SettingsSelect
          label={ROWS.fundo.label}
          hint={ROWS.fundo.hint}
          options={BACKGROUNDS}
          value={backgroundOf(prefs?.canvasBackground)}
          onChange={(value) => void store.setPrefs({ canvasBackground: value })}
        />
      </SettingsSection>

      <SettingsSection title="Conexões">
        <SettingsRow label={ROWS.desenho.label} hint={ROWS.desenho.hint}>
          <div className="settings-rope-grid">
            {ROPE_STYLES.map((style) => (
              <button
                key={style.id}
                type="button"
                className={
                  style.id === ropeStyle ? 'settings-rope-option is-on' : 'settings-rope-option'
                }
                aria-pressed={style.id === ropeStyle}
                onClick={() => store.setRopeStyle(style.id)}
              >
                <RopeStylePreview id={style.id} />
                <span>{style.label}</span>
              </button>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow label={ROWS.cor.label} hint={ROWS.cor.hint}>
          <div className="settings-rope-colors">
            {/* `--rope-theme`, e não `--rope`: escolher uma cor sobrescreve
                `--rope` inline no :root, e esta amostra passaria a exibir a cor
                escolhida em vez do cinza do tema que ela oferece. */}
            <button
              type="button"
              className={
                ropeColor === null ? 'settings-rope-swatch is-on' : 'settings-rope-swatch'
              }
              style={{ background: 'var(--rope-theme)' }}
              title="Padrão do tema"
              aria-label="Padrão do tema"
              aria-pressed={ropeColor === null}
              onClick={() => store.setRopeColor(null)}
            />
            {ROPE_COLORS.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className={
                  ropeColor === swatch.value
                    ? 'settings-rope-swatch is-on'
                    : 'settings-rope-swatch'
                }
                style={{ background: swatch.value }}
                title={swatch.label}
                aria-label={swatch.label}
                aria-pressed={ropeColor === swatch.value}
                onClick={() => store.setRopeColor(swatch.value)}
              />
            ))}
          </div>
        </SettingsRow>

        <SettingsRow label={ROWS.espessura.label}>
          <div className="settings-slider">
            <input
              type="range"
              min={ROPE_THICKNESS_MIN}
              max={ROPE_THICKNESS_MAX}
              step={0.05}
              value={ropeThickness}
              aria-label="Espessura das conexões"
              /* Ao vivo enquanto arrasta; grava uma vez, quando solta — a mesma
                 divisão do seletor do canvas, e pela mesma razão: gravar a cada
                 pixel escreveria preferences.json dezenas de vezes por gesto. */
              onChange={(e) => store.previewRopeThickness(Number(e.target.value))}
              onPointerUp={() => store.commitRopeThickness()}
              onKeyUp={() => store.commitRopeThickness()}
            />
            <output>{ropeThickness.toFixed(2).replace(/0$/, '')}×</output>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Rail">
        <RailWidthRow width={prefs?.sidebarWidth ?? RAIL_WIDTH.default} />
      </SettingsSection>
    </>
  )
}

/**
 * A largura da rail em NÚMERO — a mesma medida que hoje só se muda arrastando a
 * borda dela.
 *
 * É a única linha do grupo com estado local, e ele não é o valor: é o TEXTO que
 * está sendo digitado. Um campo numérico controlado direto pela store não
 * deixaria apagar o conteúdo para digitar outro número (o vazio viraria 0, e o
 * 0 voltaria para o piso no mesmo caractere). Grava no `blur` e no Enter, como
 * o plano manda.
 */
function RailWidthRow({ width }: { width: number }): JSX.Element {
  const [draft, setDraft] = useState(String(width))

  // Arrastar a borda da rail muda `prefs.sidebarWidth` por fora: o campo tem de
  // acompanhar, senão a tela mostraria o número velho de uma coluna que já está
  // noutra largura.
  useEffect(() => setDraft(String(width)), [width])

  const commit = (): void => {
    const value = Number(draft)
    if (!Number.isFinite(value)) {
      setDraft(String(width))
      return
    }
    // O teto RELATIVO (uma fração da janela) fica com a rail, que é quem sabe o
    // tamanho dela — ver clampWidth em rail.tsx. Aqui vale o teto absoluto.
    const clamped = Math.round(Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, value)))
    setDraft(String(clamped))
    if (clamped !== width) void store.setRailWidth(clamped)
  }

  return (
    <SettingsRow label={ROWS.railWidth.label} hint={ROWS.railWidth.hint} htmlFor="settings-rail-width">
      <div className="settings-number">
        <input
          id="settings-rail-width"
          type="number"
          min={RAIL_WIDTH.min}
          max={RAIL_WIDTH.max}
          step={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          /* Enter grava; Esc não é tratado aqui de propósito — na tela inteira
             ele significa FECHAR, e um campo que roubasse a tecla para
             desfazer o que se digitou daria dois sentidos ao mesmo gesto. Sair
             da tela sem confirmar já descarta o rascunho: ele morre com o
             componente. */
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="settings-number-unit">px</span>
      </div>
    </SettingsRow>
  )
}
