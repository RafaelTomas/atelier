/**
 * O chip do canto superior esquerdo — nome do workspace aberto e, agora, a
 * porta para trocar de workspace.
 *
 * Antes eram duas peças na mesma linha: um ☰ que abria a sidebar e um chip
 * inerte que só exibia o nome. Duas peças para um alvo só, e a que respondia ao
 * clique não era a que dizia onde você está. O ☰ deixou de existir: quem mostra
 * o workspace é quem troca de workspace.
 *
 * O popover hospeda o `WorkspacePanel` inteiro — a mesma lista, criação,
 * renomear e excluir da antiga aba. Nenhum comportamento foi reescrito aqui.
 *
 * E é o ÚNICO lugar dele: ao contrário de Projetos e Git, este painel não tem
 * um "fixar no canvas". Trocar de workspace troca o canvas inteiro, então um
 * nó com esta lista dentro se apagaria no primeiro uso — o gesto que ele
 * oferece destrói o lugar onde ele está.
 */
import { useEffect, useRef, useState } from 'react'
import { IconChevronDown } from './icons'
import { WorkspacePanel } from './panels/workspace-panel'
import { useStore } from './state/store'

export function WorkspaceChip(): JSX.Element {
  const { workspace } = useStore()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  // Mesmo padrão da dock: `mousedown` e não `click`, para o popover sumir antes
  // de o canvas processar o arrasto que começa embaixo dele.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="workspace-chip-host" ref={hostRef}>
      <button
        type="button"
        className={open ? 'floating canvas-chip is-open' : 'floating canvas-chip'}
        // O caminho de trabalho continua a um hover de distância, como era no
        // chip inerte — é a única pista de QUAL "Atelier" está aberto quando há
        // dois workspaces de mesmo nome.
        title={workspace?.workingDirectory || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Sem workspace o chip mostra '—' e continua clicável: é justamente aí
            que abrir a lista é a única coisa útil a fazer. */}
        <span className="canvas-chip-name">{workspace?.name ?? '—'}</span>
        <IconChevronDown size={10} />
      </button>

      {open && (
        <div className="workspace-popover" role="menu" aria-label="Workspaces">
          <WorkspacePanel onOpened={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
