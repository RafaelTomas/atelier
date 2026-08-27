/**
 * Coluna Arquivos: a árvore do projeto selecionado.
 *
 * Não duplica a árvore do nó de canvas — é o mesmo componente
 * (`renderer/file-tree.tsx`). A diferença entre os dois lugares é só o que os
 * cerca: aqui, o cabeçalho que diz de quem é a árvore.
 */
import type { UUID } from '@shared/types'
import { IconPin } from '../icons'
import { store, useStore } from '../state/store'
import { FileTree } from '../file-tree'
import { truncateStart } from '../paths'

interface Props {
  /**
   * Projeto a mostrar. `undefined` = segue o `selectedProjectId` global, que é
   * o caso normal. Um id explícito só chega de um widget FIXADO no canvas —
   * a exceção visível, não uma segunda fonte de verdade.
   */
  projectId?: UUID | null
  /** Presente = o painel oferece "fixar no canvas", e avisa quando foi pedido. */
  onPin?: () => void
}

export function FilesPanel({ projectId, onPin }: Props = {}): JSX.Element {
  const { projects, selectedProjectId } = useStore()
  const wanted = projectId === undefined ? selectedProjectId : projectId
  const project = projects.find((p) => p.id === wanted) ?? null

  if (!project) {
    return (
      <div className="project-empty">
        <p>Nenhum projeto selecionado.</p>
        <p className="files-hint">Escolha um projeto para ver os arquivos dele.</p>
        <button type="button" className="btn" onClick={() => store.requestRail('projetos')}>
          Ver projetos
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="panel-header">
        <span className="files-title" title={project.path}>
          {project.name}
        </span>
        {onPin && (
          <div className="panel-header-actions">
            <button
              type="button"
              className="icon-btn ghost-btn rail-pin"
              onClick={onPin}
              title="Fixar esta árvore no canvas"
            >
              <IconPin size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="files-path" title={project.path}>
        {truncateStart(project.path, 34)}
      </div>

      {/* key: trocar de projeto precisa remontar a árvore, não reaproveitar o
          estado de expansão da anterior. */}
      <div className="files-body">
        <FileTree key={project.id} root={project.path} />
      </div>
    </>
  )
}
