/**
 * Diálogo do Scan: escolhe o que varrer.
 *
 * O scan geral varre a home com a poda padrão. Isso é rápido (centenas de
 * diretórios, não centenas de milhares) justamente porque a varredura para no
 * primeiro `.git` e nunca entra em node_modules, ocultos ou outro sistema de
 * arquivos — as regras estão em core/projects/exclusions.ts.
 */
import { useEffect, useState } from 'react'
import { DESCRIBE_PROJECTS_ENABLED } from '../feature-flags'
import { shortenPath } from '../paths'
import { store, useStore } from '../state/store'

type Mode = 'folder' | 'home'

const DEPTHS = [4, 6, 8]

export function ScanDialog(): JSX.Element {
  const { autoDescribe, workspace } = useStore()
  const [mode, setMode] = useState<Mode>('folder')
  const [path, setPath] = useState('')
  const [maxDepth, setMaxDepth] = useState(6)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') store.closeScanDialog()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const browse = async (): Promise<void> => {
    const chosen = await window.atelier.dialog.chooseDirectory(path)
    if (chosen) {
      setPath(chosen)
      setMode('folder')
    }
  }

  const start = async (): Promise<void> => {
    if (mode === 'folder' && !path) {
      setError('escolha uma pasta primeiro')
      return
    }
    const failure = await store.startScan({ mode, path, maxDepth })
    if (failure) setError(failure)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) store.closeScanDialog()
      }}
    >
      <div className="modal" role="dialog" aria-label="Escanear projetos" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Escanear projetos</h2>

        <div className="modal-body">
          <div className="quick-start-row">
            <button
              type="button"
              className={mode === 'folder' ? 'quick-card is-selected' : 'quick-card'}
              onClick={() => setMode('folder')}
            >
              <strong>Pasta específica</strong>
              <span>varre a partir de uma pasta que você escolhe</span>
            </button>
            <button
              type="button"
              className={mode === 'home' ? 'quick-card is-selected' : 'quick-card'}
              onClick={() => setMode('home')}
            >
              <strong>Scan geral</strong>
              <span>varre sua pasta pessoal inteira</span>
            </button>
          </div>

          {mode === 'folder' && (
            <div className="field-row">
              <label className="field-label">Pasta</label>
              <span className="path-display" title={path}>
                {shortenPath(path) || '(nenhuma escolhida)'}
              </span>
              <button type="button" className="btn" onClick={() => void browse()}>
                Procurar…
              </button>
            </div>
          )}

          <div className="field-row">
            <label className="field-label">Profundidade</label>
            <div className="segmented">
              {DEPTHS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={d === maxDepth ? 'segment is-active' : 'segment'}
                  onClick={() => setMaxDepth(d)}
                >
                  {d} níveis
                </button>
              ))}
            </div>
          </div>

          {DESCRIBE_PROJECTS_ENABLED && (
            <label className="check-row is-stacked">
              <input
                type="checkbox"
                checked={autoDescribe}
                disabled={!workspace}
                onChange={(e) => store.setAutoDescribe(e.target.checked)}
              />
              <span>
                <strong>Descrever automaticamente</strong>
                <em>
                  {workspace
                    ? 'ao terminar, um agente Scanner nasce no canvas e escreve a descrição de cada projeto encontrado'
                    : 'precisa de um workspace aberto para receber o agente'}
                </em>
              </span>
            </label>
          )}

          <p className="scan-note">
            Ignoramos <code>node_modules</code>, pastas ocultas, artefatos de build, caches e
            unidades de rede. A varredura para ao encontrar um projeto, então repositórios dentro
            de repositórios não são listados separadamente.
          </p>

          {error && <p className="scan-error">{error}</p>}
        </div>

        <div className="modal-divider" />

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={() => store.closeScanDialog()}>
            Cancelar
          </button>
          <button type="button" className="btn is-primary" onClick={() => void start()}>
            Escanear
          </button>
        </footer>
      </div>
    </div>
  )
}
