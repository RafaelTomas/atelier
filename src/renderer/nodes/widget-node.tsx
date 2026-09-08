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
import { clockModeLabel, readClockConfig } from '@shared/clock'
import { ButtonWidget } from './button-widget'
import { ClockWidget } from './clock-widget'
import { IconLock, IconUnlock } from '../icons'
import { GitPanel } from '../panels/git-panel'
import type { MonitorBlocks } from '../panels/monitor-panel'
import { MonitorPanel } from '../panels/monitor-panel'
import { TodoPanel } from '../panels/todo-panel'
import { ProjectPanel } from '../panels/project-panel'
import { store, useStore } from '../state/store'

/** Kinds cujo conteúdo depende de um projeto — só eles mostram a barra de escopo.
 *
 *  O monitor NÃO entra: ele mede a máquina e os agentes do canvas, não um
 *  repositório, e a barra de cadeado só ofereceria uma escolha sem efeito. */
const SCOPED = new Set(['git'])

/** Períodos aceitos em `view.interval`. Um valor fora disto cai no padrão. */
const INTERVALS = new Set([1000, 2000, 5000])

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
        {content.kind === 'todo' && (
          <TodoPanel
            nodeId={node.id}
            file={content.view.file ?? ''}
            // Só 'list' é explícito; qualquer outra coisa (inclusive um modo
            // gravado por uma versão mais nova) cai no kanban, que é o padrão.
            mode={content.view.mode === 'list' ? 'list' : 'kanban'}
            onChangeMode={(mode) =>
              void store.patchContent(node.id, { view: { ...content.view, mode } })
            }
          />
        )}
        {/* O relógio não observa repositório nenhum — como o monitor, entra sem
            barra de escopo de projeto e traz a própria cabeça de abas. */}
        {content.kind === 'clock' && <ClockWidget node={node} content={content} />}
        {content.kind === 'monitor' && (
          <MonitorPanel
            blocks={readBlocks(content.view.blocks)}
            intervalMs={readInterval(content.view.interval)}
            diskPath={content.view.disk ?? ''}
            // `view` é o lugar CERTO para isto: blocos, período e volume são
            // configuração e mudam quando o usuário decide. As AMOSTRAS é que
            // nunca entram ali — sessenta gravações por minuto de dado
            // descartável (ver o comentário do campo em shared/types.ts).
            onChange={(patch) =>
              void store.patchContent(node.id, { view: { ...content.view, ...patch } })
            }
          />
        )}
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
  // O quadro mostra o TÍTULO dele: dois quadros chamados "Tarefas" não se
  // distinguem no cabeçalho nem no `atelier list`, e é por esse nome que o
  // agente os endereça.
  if (content.kind === 'todo') return content.view.title || 'Tarefas'
  // O relógio mostra o rótulo que recebeu na criação (`atelier clock create
  // "Deploy diário"`) e, sem rótulo, o nome do MODO ativo. A ordem tem de ser a
  // MESMA do `widgetTitle` do main (models/node-content.ts): é por este nome
  // que o CLI acha o nó, e um cabeçalho que dissesse "Alarme" enquanto o
  // `atelier clock set "Deploy diário"` responde por outro nome deixaria o
  // usuário sem saber qual dos dois é o certo.
  if (content.kind === 'clock') {
    return content.view.name || clockModeLabel(readClockConfig(content.view).mode)
  }
  const base = LABELS[content.kind] ?? content.kind
  return content.projectId && projectName ? `${base} · ${projectName}` : base
}

const LABELS: Record<string, string> = {
  projects: 'Projetos',
  git: 'Git',
  monitor: 'Monitor'
}

/**
 * `view` é `[String: String]` — é o que o Swift lê sem caso especial. Estas duas
 * funções são o único lugar que sabe disso do lado do monitor, como
 * `readButtonConfig` é para o botão.
 *
 * Um valor que este binário não reconhece cai no padrão em vez de quebrar: o
 * `view` pode ter sido gravado por uma versão mais nova, e o widget continua
 * legível — o valor original permanece no arquivo e volta intacto no save.
 */
function readBlocks(raw: string | undefined): MonitorBlocks {
  return raw === 'pc' || raw === 'ai' || raw === 'accounts' || raw === 'both' ? raw : 'both'
}

function readInterval(raw: string | undefined): number {
  const n = Number(raw)
  return INTERVALS.has(n) ? n : 2000
}
