/**
 * O aviso de projetos novos: o que a varredura de cada boot achou e ainda não
 * está no índice.
 *
 * Card e não modal: a varredura acontece sem ninguém pedir, e interromper o
 * trabalho de quem acabou de abrir o app por causa de uma pasta nova seria
 * cobrar caro por uma informação barata. Ele espera, e some quando respondido.
 *
 * Nada entra no índice por aqui sem clique: `addNew: false` na varredura do
 * boot é a outra metade dessa promessa.
 */
import { useEffect, useState } from 'react'
import { store, useStore } from './state/store'
import { truncateStart } from './paths'

export function ProjectCandidates(): JSX.Element | null {
  const { candidates } = useStore()
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  // Todos marcados quando a lista chega — o caso comum é querer todos.
  useEffect(() => {
    setChosen(new Set(candidates.map((c) => c.path)))
  }, [candidates])

  if (candidates.length === 0) return null

  const toggle = (path: string): void => {
    const next = new Set(chosen)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChosen(next)
  }

  const titulo =
    candidates.length === 1
      ? 'Encontrei um projeto novo'
      : `Encontrei ${candidates.length} projetos novos`

  return (
    <aside className="floating candidates-card" role="dialog" aria-label={titulo}>
      <header className="candidates-head">
        <strong>{titulo}</strong>
        <button
          type="button"
          className="icon-btn ghost-btn"
          title="Depois"
          onClick={() => store.dismissCandidates()}
        >
          ×
        </button>
      </header>

      <ul className="candidates-list">
        {candidates.map((c) => (
          <li key={c.path}>
            <label className="check-row">
              <input type="checkbox" checked={chosen.has(c.path)} onChange={() => toggle(c.path)} />
              <span className="candidate-text">
                <span className="candidate-name">{c.name}</span>
                <span className="candidate-path" title={c.path}>
                  {truncateStart(c.path, 40)}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <footer className="candidates-actions">
        <button
          type="button"
          className="btn"
          title="Não oferecer estes projetos de novo"
          onClick={() => void store.ignoreCandidates()}
        >
          Não, obrigado
        </button>
        <button
          type="button"
          className="btn is-primary"
          disabled={chosen.size === 0}
          onClick={() => void store.acceptCandidates([...chosen])}
        >
          Adicionar {chosen.size > 0 && chosen.size}
        </button>
      </footer>

      <button type="button" className="candidates-off" onClick={() => void store.disableAutoScan()}>
        Desativar varredura automática
      </button>
    </aside>
  )
}
