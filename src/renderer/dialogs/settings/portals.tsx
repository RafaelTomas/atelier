/**
 * Portais — destino de um popup aberto de dentro de um Portal.
 *
 * Os três modos são de `core/portal/portal-popup.ts`, e estavam inteiramente
 * implementados sem nenhum jeito de escolher entre eles — a chave só mudava
 * editando `preferences.json` à mão. As explicações abaixo descrevem o que
 * cada modo FAZ de verdade, lido de lá:
 *
 * - `node` (padrão): `spawnPortal` cria um nó de Portal novo no canvas.
 * - `same`: `contents.loadURL(url)` no MESMO webview — o portal de origem
 *   navega para o popup, e a página que estava aberta se perde.
 * - `system`: `shell.openExternal(url)` — abre no navegador padrão do sistema,
 *   fora do app.
 *
 * Rádio, e não um `<select>`: são só três opções e cada uma precisa de uma
 * linha de explicação visível, que um `<select>` fechado esconderia até o
 * clique.
 */
import { store, useStore } from '../../state/store'
import { SettingsRow, SettingsSection } from '../settings-rows'
import type { PortalPopupMode } from '@shared/types'

const MODES: readonly { value: PortalPopupMode; label: string; hint: string }[] = [
  {
    value: 'node',
    label: 'Abrir como nó no canvas',
    hint: 'Um Portal novo nasce ao lado do que abriu o popup — o padrão.'
  },
  {
    value: 'same',
    label: 'Navegar no mesmo portal',
    hint: 'O popup substitui a página que estava aberta no Portal de origem, sem criar nó.'
  },
  {
    value: 'system',
    label: 'Abrir no navegador do sistema',
    hint: 'Sai do app inteiramente — abre no navegador padrão do sistema operacional.'
  }
]

/**
 * Rótulo e dica da linha do grupo — a MESMA constante que a busca da tela lê
 * (ver `search-index.ts`).
 */
export const ROWS = {
  destino: {
    label: 'Destino dos popups',
    hint: 'O que fazer quando uma página dentro de um Portal tenta abrir uma janela nova.'
  }
} satisfies Record<string, { label: string; hint?: string }>

export function PortalsSettings(): JSX.Element {
  const { prefs } = useStore()
  const mode = prefs?.portalPopups ?? 'node'

  return (
    <SettingsSection title="Popups">
      <SettingsRow label={ROWS.destino.label} hint={ROWS.destino.hint}>
        <fieldset className="settings-radio-group">
          {MODES.map((option) => (
            <label key={option.value} className="settings-radio-option">
              <input
                type="radio"
                name="portalPopups"
                value={option.value}
                checked={mode === option.value}
                onChange={() => void store.setPrefs({ portalPopups: option.value })}
              />
              <span className="settings-radio-text">
                <span className="settings-radio-label">{option.label}</span>
                <span className="settings-row-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </SettingsRow>
    </SettingsSection>
  )
}
