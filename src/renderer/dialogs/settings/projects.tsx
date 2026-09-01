/**
 * Projetos — varredura no boot, raízes e profundidade, projetos ignorados.
 *
 * `autoScanOnLaunch` já tinha efeito (a varredura do boot lê a mesma chave);
 * o que faltava era um lugar fixo para ligá-la sem passar pelo aviso. O aviso
 * (`project-candidates.tsx`) continua existindo do jeito que está — ele
 * também oferece desligar, e continuar oferecendo é o certo: quem acabou de
 * ver dez projetos indesejados não deveria ter de abrir Configurações para
 * reagir na hora.
 *
 * `scanRoots` e `scanMaxDepth` já decodificavam antes desta tela; o que não
 * existia era quem os LESSE. Agora `scanOnLaunch` e o "Scan geral" do
 * `scan-dialog` partem daqui (ver scan-controller.ts) — gravar sem ler seria
 * pior que não gravar.
 *
 * Projetos ignorados: `excludedPaths` no índice de projetos, não em
 * Preferências — por isso não passa por `setPrefs`, e sim pelos canais
 * `project:list-ignored` / `project:unignore` (novos nesta fase, a única
 * adição de main além da leitura de `scanRoots`/`scanMaxDepth`).
 */
import { useEffect, useState } from 'react'
import { store, useStore } from '../../state/store'
import { shortenPath } from '../../paths'
import { SettingsRow, SettingsSection, SettingsToggle } from '../settings-rows'

const DEPTH_MIN = 1
const DEPTH_MAX = 12

/**
 * Rótulo e dica de cada linha do grupo — a MESMA constante que a busca da
 * tela lê (ver `search-index.ts`).
 */
export const ROWS = {
  varrer: {
    label: 'Varrer ao abrir o app',
    hint: 'Procura projetos novos nas raízes abaixo a cada boot. O aviso que aparece com o que for encontrado sempre oferece desligar isto.'
  },
  raizes: {
    label: 'Raízes',
    hint: 'Onde a varredura procura. Vazio significa a sua pasta pessoal — o comportamento histórico.'
  },
  profundidade: {
    label: 'Profundidade',
    hint: `Entre ${DEPTH_MIN} e ${DEPTH_MAX} níveis, a partir de cada raiz.`
  },
  ignorados: {
    label: 'Projetos recusados',
    hint: 'Pastas que a varredura encontrou e você mandou não oferecer de novo.'
  }
} satisfies Record<string, { label: string; hint?: string }>

export function ProjectsSettings(): JSX.Element {
  const { prefs } = useStore()
  const scanRoots = prefs?.scanRoots ?? []
  const scanMaxDepth = prefs?.scanMaxDepth ?? 6

  const addRoot = async (): Promise<void> => {
    const chosen = await window.atelier.dialog.chooseDirectory()
    if (!chosen || scanRoots.includes(chosen)) return
    void store.setPrefs({ scanRoots: [...scanRoots, chosen] })
  }

  const removeRoot = (root: string): void => {
    void store.setPrefs({ scanRoots: scanRoots.filter((r) => r !== root) })
  }

  return (
    <>
      <SettingsSection title="Varredura">
        <SettingsToggle
          label={ROWS.varrer.label}
          hint={ROWS.varrer.hint}
          value={prefs?.autoScanOnLaunch ?? true}
          onChange={(value) => void store.setAutoScanOnLaunch(value)}
        />

        <SettingsRow label={ROWS.raizes.label} hint={ROWS.raizes.hint}>
          <div className="settings-roots">
            {scanRoots.length === 0 ? (
              <span className="settings-roots-empty">pasta pessoal</span>
            ) : (
              <ul className="settings-roots-list">
                {scanRoots.map((root) => (
                  <li key={root} className="settings-roots-item">
                    <span className="settings-roots-path" title={root}>
                      {shortenPath(root)}
                    </span>
                    <button
                      type="button"
                      className="icon-btn ghost-btn"
                      title="Tirar esta raiz"
                      onClick={() => removeRoot(root)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn" onClick={() => void addRoot()}>
              Adicionar pasta…
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          label={ROWS.profundidade.label}
          hint={ROWS.profundidade.hint}
          htmlFor="settings-scan-depth"
        >
          <div className="settings-number">
            <input
              id="settings-scan-depth"
              type="number"
              min={DEPTH_MIN}
              max={DEPTH_MAX}
              value={scanMaxDepth}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (!Number.isFinite(n)) return
                const clamped = Math.round(Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, n)))
                void store.setPrefs({ scanMaxDepth: clamped })
              }}
            />
            <span className="settings-number-unit">níveis</span>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Ignorados">
        <IgnoredProjectsRow />
      </SettingsSection>
    </>
  )
}

/**
 * Caminhos que o usuário já recusou pelo aviso do boot ("Não, obrigado").
 * Estado local porque `excludedPaths` mora no índice de projetos, não em
 * Preferências — não há como isto vir da store genérica.
 */
function IgnoredProjectsRow(): JSX.Element {
  const [ignored, setIgnored] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.atelier.project.listIgnored().then((paths) => {
      if (!cancelled) setIgnored(paths)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const undo = async (path: string): Promise<void> => {
    // Otimista: some da lista na hora, e o pedido confirma no fundo. Um
    // "desfazer" que espera o IPC pareceria travado por causa de um clique só.
    setIgnored((prev) => (prev ? prev.filter((p) => p !== path) : prev))
    await window.atelier.project.unignore([path])
  }

  return (
    <SettingsRow label={ROWS.ignorados.label} hint={ROWS.ignorados.hint}>
      {ignored === null ? (
        <span className="settings-roots-empty">carregando…</span>
      ) : ignored.length === 0 ? (
        <span className="settings-roots-empty">nenhum</span>
      ) : (
        <ul className="settings-roots-list">
          {ignored.map((path) => (
            <li key={path} className="settings-roots-item">
              <span className="settings-roots-path" title={path}>
                {shortenPath(path)}
              </span>
              <button type="button" className="btn" onClick={() => void undo(path)}>
                Desfazer
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  )
}
