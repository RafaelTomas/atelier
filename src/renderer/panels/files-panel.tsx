/**
 * Aba Arquivos: a árvore do projeto selecionado na aba Projetos.
 *
 * Não duplica a árvore do nó de canvas — é o mesmo componente
 * (`renderer/file-tree.tsx`). A diferença entre os dois lugares é só o que os
 * cerca: aqui, o cabeçalho que diz de quem é a árvore e como trocar de projeto.
 */
import { store, useStore } from '../state/store'
import { FileTree } from '../file-tree'
import { truncateStart } from '../paths'

export function FilesPanel(): JSX.Element {
  const { projects, selectedProjectId } = useStore()
  const project = projects.find((p) => p.id === selectedProjectId) ?? null

  if (!project) {
    return (
      <div className="project-empty">
        <p>Nenhum projeto selecionado.</p>
        <p className="files-hint">Escolha um projeto para ver os arquivos dele.</p>
        <button type="button" className="btn" onClick={() => store.setSidebarTab('projetos')}>
          Ver projetos
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="sidebar-header">
        <span className="files-title" title={project.path}>
          {project.name}
        </span>
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
