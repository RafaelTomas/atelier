/**
 * Nó que hospeda um painel do app no canvas.
 *
 * A cascata da rail resolve "olhar rápido". Quem quer a coluna larga e
 * PERMANENTE — o git de um repositório ao lado do agente que mexe nele — fixa
 * o painel aqui, em vez de manter um menu aberto sobre o canvas.
 *
 * Os painéis não foram reescritos: são os mesmos `ProjectPanel` e `GitPanel` da
 * rail. Isso só é possível porque eles já eram componentes
 * independentes da casca — o que o cabeçalho de workspace-panel.tsx chama de
 * "extração literal". O que existe aqui é o wrapper: escopo, cadeado e o vazio
 * de um kind desconhecido.
 */
import type { CanvasNode, WidgetContent } from '@shared/types'
import { isKnownWidgetKind } from '@shared/types'
import { ButtonWidget } from './button-widget'
import { IconLock, IconUnlock } from '../icons'
import { GitPanel } from '../panels/git-panel'
import { ProjectPanel } from '../panels/project-panel'
import { store, useStore } from '../state/store'

/** Kinds cujo conteúdo depende de um projeto — só eles mostram a barra de escopo. */
const SCOPED = new Set(['git'])

export function WidgetNode({
  node,
  content
}: {
  node: CanvasNode
  content: WidgetContent
}): JSX.Element {
  const { projects, selectedProjectId } = useStore()

  // `projectId: null` = segue a seleção global; preenchido = fixado. A fonte
  // única continua sendo `selectedProjectId`; um widget fixado é a exceção
  // EXPLÍCITA, e o cadeado no cabeçalho é o que a torna visível.
  const locked = content.projectId !== null
  const effectiveId = locked ? content.projectId : selectedProjectId
  const project = projects.find((p) => p.id === effectiveId) ?? null

  const toggleLock = (): void => {
    // Destravar deixa o widget seguir a seleção global de novo; travar congela
    // no projeto que ele está mostrando AGORA — não no que estiver selecionado
    // um segundo depois.
    void store.patchContent(node.id, { projectId: locked ? null : effectiveId })
  }

  // O botão sai antes de tudo: ele não tem barra de escopo nem corpo de painel
  // — o nó INTEIRO é o alvo de clique (ver isChromeless em node-shell).
  if (content.kind === 'button') return <ButtonWidget node={node} content={content} />

  if (!isKnownWidgetKind(content.kind)) {
    return (
      <div className="widget-node">
        <div className="widget-unknown">
          <p>Este painel foi criado por uma versão mais nova do Atelier.</p>
          <p>
            <code>{content.kind}</code>
          </p>
          {/* O nó monta inerte de propósito, em vez de sumir: o conteúdo
              continua no arquivo, e o autosave o grava de volta como veio. */}
        </div>
      </div>
    )
  }

  return (
    <div className="widget-node">
      {SCOPED.has(content.kind) && (
        <div className="widget-scope">
          <span className="widget-scope-name" title={project?.path}>
            {project ? project.name : 'nenhum projeto selecionado'}
          </span>
          <button
            type="button"
            className={locked ? 'icon-btn ghost-btn widget-lock is-locked' : 'icon-btn ghost-btn widget-lock'}
            onClick={toggleLock}
            disabled={!locked && !selectedProjectId}
            title={
              locked
                ? 'Fixado neste projeto — clique para seguir a seleção do painel'
                : 'Seguindo a seleção do painel — clique para fixar neste projeto'
            }
          >
            {locked ? <IconLock size={14} /> : <IconUnlock size={14} />}
          </button>
        </div>
      )}

      <div className="widget-body">
        {content.kind === 'projects' && <ProjectPanel />}
        {/* `projectId` explícito só quando FIXADO: passar `selectedProjectId`
            aqui faria o painel ler a seleção por um caminho torto em vez do
            direto, e as duas leituras poderiam divergir. */}
        {content.kind === 'git' && <GitPanel projectId={locked ? content.projectId : undefined} />}
      </div>
    </div>
  )
}

/**
 * Título do nó: o painel mais de quem ele é.
 *
 * O nome do projeto entra só quando o widget está FIXADO. Um widget que segue a
 * seleção global mudaria de título a cada troca de projeto, e um cabeçalho que
 * dança não identifica nada — é o mesmo motivo pelo qual o portal mostra o host
 * e não "Portal".
 */
export function widgetLabel(content: WidgetContent, projectName?: string): string {
  // O botão é chromeless — este título não vai para a tela, mas vale para quem
  // lista nós (o CLI acha o botão pelo rótulo que o usuário escreveu).
  if (content.kind === 'button') return content.view.label || 'Botão'
  const base = LABELS[content.kind] ?? content.kind
  return content.projectId && projectName ? `${base} · ${projectName}` : base
}

const LABELS: Record<string, string> = {
  projects: 'Projetos',
  git: 'Git'
}
