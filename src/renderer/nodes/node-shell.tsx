/**
 * Casca do nó — porte de NodeShellView.
 *
 * Posiciona em coordenadas de canvas (o contêiner pai é que tem o transform),
 * desenha header, borda de seleção, alça de resize e o ponto de conexão.
 */
import type { AgentRole, AgentStatus, CanvasNode, TerminalTheme, UUID } from '@shared/types'
import { formatTokens } from '@shared/types'
import { FOCUS_Z } from '../canvas/focus-frame'
import { exitFocus } from '../canvas/focus-mode'
import { Icon } from '../node-icons'
import { store } from '../state/store'
import { CodeEditorNode, codeEditorLabel } from './code-editor-node'
import { DataTableNode, dataTableLabel } from './data-table-node'
import { FileTreeNode } from './file-tree-node'
import { ImageNode, imageLabel } from './image-node'
import { NoteNode } from './note-node'
import { TerminalNode } from './terminal-node'
import { TextNode } from './text-node'
import { PortalNode, portalLabel } from './portal-node'
import { PlaceholderNode } from './placeholder-node'
import { SecretVaultNode, secretVaultLabel } from './secret-vault-node'
import { WidgetNode, widgetLabel } from './widget-node'

interface Props {
  node: CanvasNode
  selected: boolean
  workspaceId: UUID
  /** Responsabilidade do terminal, resolvida pelo canvas (null se não tem). */
  role?: AgentRole | null
  /** Temas de terminal do usuário — vêm de cima para não assinar a store por nó. */
  customThemes?: TerminalTheme[]
  /** Linha de status lida da tela do agente. null = ele nunca mostrou nada. */
  status?: AgentStatus | null
  /** Nome do projeto de um widget FIXADO — resolvido pelo canvas (ver lá). */
  projectName?: string | null
  /**
   * Fora do grupo em foco: o nó apaga para o grupo isolado sobressair. Não
   * desmonta nem desabilita nada — é opacidade, e um terminal apagado continua
   * rodando e recebendo o que se digita nele.
   */
  dimmed?: boolean
  /**
   * Dentro de um grupo colapsado. O nó só chega aqui quando algo o mantém
   * MONTADO apesar do colapso — hoje só o portal acordado, que não pode perder
   * o processo no meio de uma leitura do agente. Sai da tela por
   * `visibility`, e não por `display: none`: um `<webview>` sem caixa de
   * layout para de renderizar, e o agente leria uma página congelada.
   */
  hidden?: boolean
  /**
   * Em MODO FOCO. O nó já chega aqui com a moldura ampliada — quem calcula é o
   * canvas, com `focusFrame`. O que muda por aqui é só a casca: ele sobe para
   * cima do véu, perde as alças de redimensionar (não há gesto de arrastar
   * enquanto o foco está aberto) e ganha a pílula de saída.
   */
  focused?: boolean
}

function title(node: CanvasNode, projectName: string | null): string {
  switch (node.content.type) {
    case 'terminal':
      return node.content.value.name
    case 'stickyNote':
      return node.content.value.fileName?.replace(/\.md$/, '') ?? 'Note'
    case 'portal':
      // O host, não o nome: vários portais abertos ficariam todos "Portal".
      return portalLabel(node.content.value)
    case 'fileTree':
      return node.content.value.name
    case 'codeEditor':
      return codeEditorLabel(node.content.value)
    case 'dataTable':
      return dataTableLabel(node.content.value)
    case 'image':
      return imageLabel(node.content.value)
    case 'widget':
      return widgetLabel(node.content.value, projectName ?? undefined)
    case 'secretVault':
      return secretVaultLabel(node.content.value)
    default:
      return node.content.type
  }
}

/**
 * As oito alças: quatro bordas e quatro quinas.
 *
 * Antes existia só a quina inferior direita, o que obrigava a arrastar o nó
 * para perto do canto certo antes de poder encolhê-lo pelo outro lado.
 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/**
 * Sem barra de título: o texto (igual ao app nativo), o BOTÃO e o RELÓGIO.
 *
 * O botão entrou aqui porque um cabeçalho de 28 px em cima de um nó de 88 é um
 * terço de moldura para nada — e porque o nó inteiro é o alvo de clique, o que
 * um header roubaria pela metade. Editar e excluir ele ganha na barra de ações
 * da seleção, como o terminal.
 *
 * O relógio entrou pela mesma aritmética e por uma redundância: o `⇄` e o `×`
 * do cabeçalho são exatamente o que a barra de ações da seleção já oferece
 * (ver node-action-bar), e o mostrador é a única coisa que o nó tem para
 * mostrar. Um cabeçalho aqui gastava um quinto da altura repetindo dois botões
 * que já existem um pixel acima.
 */
function isChromeless(node: CanvasNode): boolean {
  if (node.content.type === 'text') return true
  if (node.content.type !== 'widget') return false
  return node.content.value.kind === 'button' || node.content.value.kind === 'clock'
}

export function NodeShell({
  node,
  selected,
  workspaceId,
  role = null,
  customThemes = [],
  status = null,
  projectName = null,
  dimmed = false,
  hidden = false,
  focused = false
}: Props): JSX.Element {
  const { frame } = node
  const terminal = node.content.type === 'terminal' ? node.content.value : null

  const body = ((): JSX.Element => {
    switch (node.content.type) {
      case 'terminal':
        return (
          <TerminalNode
            node={node}
            content={node.content.value}
            workspaceId={workspaceId}
            customThemes={customThemes}
          />
        )
      case 'stickyNote':
        return <NoteNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'text':
        return <TextNode node={node} content={node.content.value} />
      case 'portal':
        return <PortalNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'fileTree':
        return <FileTreeNode node={node} content={node.content.value} />
      case 'codeEditor':
        return <CodeEditorNode node={node} content={node.content.value} />
      case 'dataTable':
        return <DataTableNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'image':
        return <ImageNode node={node} content={node.content.value} workspaceId={workspaceId} />
      case 'widget':
        return <WidgetNode node={node} content={node.content.value} />
      case 'secretVault':
        return (
          <SecretVaultNode node={node} content={node.content.value} workspaceId={workspaceId} />
        )
      default:
        return <PlaceholderNode type={node.content.type} />
    }
  })()

  return (
    /**
     * Duas camadas, e a razão é o redimensionamento: o CARD recorta o próprio
     * conteúdo (`overflow: hidden`, que é o que arredonda o cabeçalho e segura
     * o terminal dentro da borda), e o que é recortado não é clicável. As alças
     * precisam montar em cima da borda, metade para fora — então elas moram
     * nesta moldura, que tem a mesma geometria e não recorta nada.
     */
    <div
      data-node-id={node.id}
      className={[
        'node-frame',
        dimmed ? 'is-dimmed' : '',
        hidden ? 'is-hidden' : '',
        focused ? 'is-focused' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        // Em foco o nó tem de vencer o véu, que por sua vez vence todo o resto.
        // Os zIndex reais são `maxZ + 1` (ver bringToFront na store) e vivem na
        // casa das dezenas — FOCUS_Z está uma ordem de grandeza acima de
        // qualquer canvas plausível.
        zIndex: focused ? FOCUS_Z : node.zIndex
      }}
    >
      <div
        className={[
          'node',
          `node-${node.content.type}`,
          // O kind do widget vira classe porque `.node-widget` não basta: botão
          // e relógio são os dois chromeless e querem cascas opostas — um card
          // que pareça apertável, e nenhuma casca.
          ...(node.content.type === 'widget' ? [`node-widget-${node.content.value.kind}`] : []),
          selected ? 'is-selected' : '',
          isChromeless(node) ? 'is-chromeless' : ''
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {!isChromeless(node) && (
          <div className="node-header">
            {terminal && (
              <span className="node-icon" style={{ color: terminal.color }}>
                <Icon name={terminal.icon} size={14} />
              </span>
            )}
            <span className="node-title">{title(node, projectName)}</span>
            {terminal?.isArtisan && (
              <span
                className="node-badge is-artisan"
                title="Artesão: delega abrindo agentes no canvas, não subagentes escondidos"
              >
                artesão
              </span>
            )}
            {role && (
              <span className="node-badge" style={{ color: role.color }} title={role.instructions || role.name}>
                {role.name}
              </span>
            )}
            <div className="node-header-actions">
              <button
                type="button"
                className="icon-btn node-btn"
                title="Conectar a outro nó"
                onMouseDown={(e) => {
                  e.stopPropagation()
                  store.startConnecting(node.id)
                }}
              >
                ⇄
              </button>
              <button
                type="button"
                className="icon-btn node-btn"
                title="Remover nó"
                onMouseDown={(e) => {
                  e.stopPropagation()
                  void store.removeNode(node.id)
                }}
              >
                ×
              </button>
            </div>
          </div>
        )}

        <div className="node-body">{body}</div>

        {terminal && status && <AgentStatusFooter status={status} />}
      </div>

      {/* Sem alças em foco: o tamanho ali é calculado a partir da janela, e uma
          alça arrastada escreveria no frame GRAVADO do nó — o usuário sairia do
          foco e encontraria o nó do tamanho da tela. */}
      {!focused &&
        RESIZE_EDGES.map((edge) => (
          <div key={edge} data-resize-handle={edge} />
        ))}

      {/* A pílula de saída, na FAIXA DO VÉU embaixo do nó.
          Duas casas foram tentadas antes, e as duas colidiam com algo: acima da
          moldura ela batia nos semáforos do macOS e no chip do workspace; no
          canto superior direito de dentro do nó ela pousava exatamente sobre o
          `⇄` e o `×` do cabeçalho — dois `×` encostados, e o de fora fazendo
          uma coisa completamente diferente do de dentro.

          A margem do foco (FOCUS_MARGIN) é uma faixa vazia dos quatro lados do
          nó, e é o único lugar da tela que não pertence nem ao nó nem ao cromo
          da janela. Embaixo e no meio, sobre o escuro do véu, ela não tem com o
          que colidir e lê como o que é: controle do MODO, não do nó.

          Existe porque o `Esc` NÃO é caminho garantido: num terminal em foco a
          tecla é do terminal (vim depende disso), e o véu vira uma faixa fina
          quando o nó ocupa quase tudo. */}
      {focused && (
        <button
          type="button"
          className="focus-exit"
          data-node-interactive
          title="Sair do foco"
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={exitFocus}
        >
          <span className="focus-exit-x">×</span>
          <span className="focus-exit-label">Sair do foco</span>
        </button>
      )}
    </div>
  )
}

/** Alto o bastante para o número virar aviso, não decoração. */
const LIMIT_ALERT = 85

/**
 * Rodapé do terminal: o que o agente mostra na própria linha de status —
 * tokens da sessão, contexto usado e as janelas de limite de uso.
 *
 * Nada aqui é calculado pelo Atelier: é leitura da tela. Campo que o agente
 * não imprime simplesmente não aparece, em vez de virar um zero mentiroso.
 */
function AgentStatusFooter({ status }: { status: AgentStatus }): JSX.Element | null {
  const { tokens, contextPct, limits } = status
  if (tokens === null && contextPct === null && limits.length === 0) return null

  return (
    <div className="node-footer" title="Lido da linha de status do próprio agente">
      {tokens !== null && (
        <span className="nf-item">
          <span className="nf-label">tok</span>
          <span className="nf-value">{formatTokens(tokens)}</span>
        </span>
      )}
      {contextPct !== null && (
        <span className="nf-item" title="Contexto usado">
          <span className="nf-label">ctx</span>
          <span className="nf-value">{contextPct}%</span>
        </span>
      )}
      {limits.map((limit) => (
        <span key={limit.window} className="nf-item" title={`Limite de uso na janela de ${limit.window}`}>
          <span className="nf-label">{limit.window}</span>
          <span className={limit.pct >= LIMIT_ALERT ? 'nf-value is-alert' : 'nf-value'}>
            {limit.pct}%
          </span>
        </span>
      ))}
    </div>
  )
}
