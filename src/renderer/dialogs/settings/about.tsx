/**
 * Sobre — versão, dados em disco, CLI, integridade e a lista de atalhos.
 *
 * É o único grupo sem nenhum controle que escreve nas preferências: tudo aqui
 * é leitura de diagnóstico, ou uma ação que já existe em outro lugar
 * (`fs:reveal`, `workspace:integrity`, `workspace:save-now`). Por isso não há
 * `store.setPrefs` neste arquivo — a regra "a tela não é dona de estado" se
 * aplica do mesmo jeito, só que aqui o estado é sempre o do disco, nunca um
 * rascunho.
 *
 * `appVersion`, `schemaVersion`, `isOverriddenHome` e o caminho do CLI vêm de
 * um canal novo, `app:about-info` (bridge.ts + preload/index.ts): o
 * `app:boot-info` que já existia não carrega nada disso, e estender o tipo
 * `BootInfo` fica fora do meu arquivo — por isso o canal novo, e não um campo
 * a mais no antigo.
 */
import { useEffect, useState } from 'react'
import { store, useStore } from '../../state/store'
import { SettingsRow, SettingsSection } from '../settings-rows'

interface AboutInfo {
  appVersion: string
  schemaVersion: number
  dataDir: string
  isOverriddenHome: boolean
  cliPath: string
}

type Integrity = { safeMode: boolean; droppedNodes: number; fileSchemaVersion: number } | null

/** Os atalhos globais do canvas — levantados de canvas-view.tsx, não de memória. */
const SHORTCUTS: readonly { keys: string; effect: string }[] = [
  { keys: '⌘, / Ctrl+,', effect: 'Abre ou fecha esta tela de Configurações' },
  { keys: '⌘Z / Ctrl+Z', effect: 'Desfazer' },
  { keys: '⌘⇧Z / Ctrl+Shift+Z', effect: 'Refazer' },
  { keys: '⌘G / Ctrl+G', effect: 'Agrupar a seleção' },
  { keys: '⌘⇧G / Ctrl+Shift+G', effect: 'Desagrupar' },
  { keys: 'Delete / Backspace', effect: 'Apaga os nós, o grupo ou o desenho selecionado' },
  { keys: 'V', effect: 'Ferramenta: selecionar' },
  { keys: 'D', effect: 'Ferramenta: desenhar' },
  { keys: 'P', effect: 'Ferramenta: caneta' },
  { keys: 'M', effect: 'Ferramenta: marcador' },
  { keys: 'E', effect: 'Ferramenta: borracha' },
  { keys: 'Espaço (mantida)', effect: 'Modo mão — arrasta o canvas' },
  { keys: '⌘0 / Ctrl+0', effect: 'Zoom para 100%' },
  { keys: '⌘+ / Ctrl++', effect: 'Zoom mais' },
  { keys: '⌘- / Ctrl+-', effect: 'Zoom menos' },
  { keys: 'Esc', effect: 'Cancela a ferramenta ou o gesto em curso, ou fecha um menu' }
]

/**
 * Rótulo (e, quando é fixo, dica) de cada linha do grupo — a MESMA constante
 * que a busca da tela lê (ver `search-index.ts`).
 *
 * As dicas de "Pasta de dados", "CLI instalado", "Integridade" e "Salvar" são
 * DADO DE DISCO (caminho, resultado da última verificação), não documentação
 * — por isso ficam de fora daqui e continuam escritas direto no JSX: indexá-
 * las faria a busca casar com um caminho de arquivo do usuário, não com uma
 * palavra que descreve o controle.
 */
export const ROWS = {
  aplicativo: { label: 'Aplicativo' },
  schema: { label: 'Schema', hint: 'Versão do formato do workspace.json.' },
  pastaDados: { label: 'Pasta de dados' },
  cli: { label: 'CLI instalado' },
  integridade: { label: 'Integridade' },
  salvar: { label: 'Salvar' }
} satisfies Record<string, { label: string; hint?: string }>

export function AboutSettings(): JSX.Element {
  const { workspace } = useStore()
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [integrity, setIntegrity] = useState<Integrity>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.atelier.aboutInfo().then(setAbout)
  }, [])

  const checkIntegrity = async (): Promise<void> => {
    if (!workspace) return
    setChecking(true)
    try {
      setIntegrity(await window.atelier.workspace.integrity(workspace.id))
    } finally {
      setChecking(false)
    }
  }

  const saveNow = async (): Promise<void> => {
    setSaving(true)
    try {
      const count = await window.atelier.workspace.saveNow()
      setSavedNotice(count > 0 ? `${count} workspace(s) gravado(s).` : 'Nada para gravar — já estava tudo salvo.')
    } finally {
      setSaving(false)
    }
  }

  const copyCliPath = (path: string): void => {
    void navigator.clipboard.writeText(path).then(
      () => store.showNotice('caminho copiado'),
      () => store.showNotice('não foi possível copiar')
    )
  }

  return (
    <>
      {about?.isOverriddenHome && (
        <div className="settings-about-warning" role="alert">
          <strong>Rodando sobre um ATELIER_HOME de desenvolvimento.</strong>
          <span>
            Os dados desta sessão não são os dados reais do usuário — ficam em{' '}
            <code>{about.dataDir}</code>, não em <code>~/.atelier</code>.
          </span>
        </div>
      )}

      <SettingsSection title="Versão">
        <SettingsRow label={ROWS.aplicativo.label}>
          <span className="settings-about-value">{about?.appVersion ?? '—'}</span>
        </SettingsRow>
        <SettingsRow label={ROWS.schema.label} hint={ROWS.schema.hint}>
          <span className="settings-about-value">{about?.schemaVersion ?? '—'}</span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Dados em disco">
        <SettingsRow label={ROWS.pastaDados.label} hint={about?.dataDir}>
          <button
            type="button"
            className="btn"
            disabled={!about}
            onClick={() => about && void window.atelier.fs.reveal(about.dataDir)}
          >
            Revelar
          </button>
        </SettingsRow>

        <SettingsRow label={ROWS.cli.label} hint={about?.cliPath}>
          <button
            type="button"
            className="btn"
            disabled={!about}
            onClick={() => about && copyCliPath(about.cliPath)}
          >
            Copiar caminho
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Manutenção">
        <SettingsRow
          label={ROWS.integridade.label}
          hint={
            integrity
              ? integrity.safeMode
                ? `Modo seguro: ${integrity.droppedNodes} nó(s) descartado(s) no último carregamento.`
                : 'Sem problemas no último carregamento.'
              : 'Relê o workspace ativo do disco e confere o que foi carregado.'
          }
        >
          <button
            type="button"
            className="btn"
            disabled={!workspace || checking}
            onClick={() => void checkIntegrity()}
          >
            {checking ? 'Verificando…' : 'Verificar integridade'}
          </button>
        </SettingsRow>

        <SettingsRow
          label={ROWS.salvar.label}
          hint={savedNotice ?? 'Grava o workspace ativo agora, fora do ciclo automático.'}
        >
          <button type="button" className="btn" disabled={saving} onClick={() => void saveNow()}>
            {saving ? 'Gravando…' : 'Gravar agora'}
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Atalhos de teclado">
        <div className="settings-about-shortcuts">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="settings-about-shortcut">
              <kbd>{s.keys}</kbd>
              <span>{s.effect}</span>
            </div>
          ))}
        </div>
      </SettingsSection>
    </>
  )
}
