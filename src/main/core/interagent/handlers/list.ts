/**
 * `atelier list` — agentes, notas e portais conectados ao chamador.
 *
 * Uma leitura mais completa já está em disco antes deste comando rodar: o
 * caminho em `ATELIER_BRIEF` (variável de ambiente, gravada no boot do PTY —
 * ver terminal/terminal-manager.ts) tem o mesmo inventário com o verbo que
 * abre cada recurso, prontos para ler sem rodar nada.
 */
import type { CanvasNode, TodoBoard, UUID } from '@shared/types'
import { editorState } from '../../editor/editor-registry'
import { nodeDisplayName } from '../../models/node-content'
import { paths } from '../../persistence/paths'
import { roles } from '../../state/role-store'
import { briefFilePath, terminals } from '../../terminal/terminal-manager'
import { readBoard } from '../../todo/todo-store'
import { artisanBanner } from '../artisan-doctrine'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

/**
 * O cabeçalho do Artesão, quando o chamador é um.
 *
 * É aqui, e não só nos hooks, porque `list` é o único caminho que TODO agente
 * atravessa antes de delegar — inclusive um Codex, que não tem `SessionStart`
 * nem hook de ferramenta. Ver artisan-doctrine.ts.
 */
function artisanHeader(tid: UUID): string[] {
  const ws = workspaceForTerminal(tid)
  const node = ws?.node(tid)
  if (!node || node.content.type !== 'terminal' || !node.content.value.isArtisan) return []
  return [artisanBanner(), '']
}

/**
 * A linha que aponta para a leitura mais completa: `$ATELIER_BRIEF` (gravado
 * no boot do PTY, ver terminal/terminal-manager.ts) tem o mesmo inventário com
 * o verbo que abre cada recurso, sem precisar rodar `list` de novo. Uma linha
 * só — quem quer o texto lê o arquivo, não este cabeçalho.
 *
 * O caminho é recalculado pela mesma fórmula de `briefFilePath`, e não lido
 * de `process.env`: quem responde `list` é o processo MAIN, que nunca herdou
 * o ambiente do PTY que fez a pergunta.
 */
function briefHint(tid: UUID): string[] {
  return [`(Full brief with open verbs already in $ATELIER_BRIEF: ${briefFilePath(tid)})`, '']
}

/**
 * O quadro daquele nó, lido do disco. `null` quando o arquivo não existe ou está
 * corrompido — e aí a linha diz `(unreadable)` em vez de mentir um zero.
 */
async function boardOf(node: CanvasNode): Promise<TodoBoard | null> {
  if (node.content.type !== 'widget') return null
  const file = node.content.value.view.file
  const ws = workspaceForTerminal(null)
  if (!file || !ws) return null
  return readBoard(paths.todoFile(ws.id, file))
}

export async function handleList(_args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const header = [...artisanHeader(tid), ...briefHint(tid)]

  const nodes = connectedNodes(tid)
  if (nodes.length === 0) {
    // O cabeçalho vale MAIS aqui, não menos: um Artesão sem ninguém cabeado é
    // exatamente quem está prestes a recrutar o primeiro.
    return [
      ...header,
      'No connected agents, notes or portals.',
      'Connect this terminal to another node on the canvas first.'
    ].join('\n')
  }

  const lines: string[] = [...header]

  const agents = nodes.filter((n) => n.content.type === 'terminal')
  if (agents.length > 0) {
    lines.push('Connected agents:')
    for (const node of agents) {
      const session = terminals.get(node.id)
      const status = session ? (session.exited ? 'exited' : terminals.isIdle(node.id) ? 'idle' : 'working') : 'not started'
      // A responsabilidade entra aqui para o chamador saber a quem pedir o quê
      const role = node.content.type === 'terminal' ? roles.get(node.content.value.assignedRoleId) : null
      const suffix = role ? `  role: ${role.name}` : ''
      lines.push(`  ${nodeDisplayName(node.content)}  [${status}]  (${node.id.slice(0, 8)})${suffix}`)
    }
  }

  const notes = nodes.filter((n) => n.content.type === 'stickyNote')
  if (notes.length > 0) {
    lines.push('', 'Connected notes:')
    for (const node of notes) lines.push(`  ${nodeDisplayName(node.content)}`)
  }

  const portals = nodes.filter((n) => n.content.type === 'portal')
  if (portals.length > 0) {
    lines.push('', 'Connected portals:')
    for (const node of portals) {
      const portal = node.content.type === 'portal' ? node.content.value : null
      lines.push(`  ${nodeDisplayName(node.content)}  ${portal?.currentURL ?? ''}`)
    }
  }

  const tables = nodes.filter((n) => n.content.type === 'dataTable')
  if (tables.length > 0) {
    lines.push('', 'Connected tables:')
    for (const node of tables) {
      const t = node.content.type === 'dataTable' ? node.content.value : null
      const dims = t ? `${t.rowCount} rows × ${t.columnCount} cols` : ''
      lines.push(`  ${nodeDisplayName(node.content)}  ${dims}${t?.truncated ? ' (truncated)' : ''}`)
    }
  }

  // Quadros de TODO. O que sai aqui é a CONTAGEM POR COLUNA, e não os cartões:
  // o `atelier list` responde "com o que estou cabeado", e quem quer o conteúdo
  // chama `atelier todo list`. Um quadro de trinta cartões despejado aqui
  // afogaria o resto da resposta.
  const boards = nodes.filter(
    (n) => n.content.type === 'widget' && n.content.value.kind === 'todo'
  )
  if (boards.length > 0) {
    lines.push('', 'Connected boards:')
    for (const node of boards) {
      const view = node.content.type === 'widget' ? node.content.value.view : {}
      const board = await boardOf(node)
      const counts = board
        ? board.columns
            .map((c) => `${c.id} ${board.items.filter((i) => i.status === c.id).length}`)
            .join('  ')
        : '(unreadable)'
      lines.push(`  ${view.title || 'Tarefas'}  ${counts}`)
    }
    lines.push("  Read and write them with 'atelier todo …'.")
  }

  // Editores: o CAMINHO ABSOLUTO é o dado que serve para algo — é o que
  // destrava as ferramentas de arquivo do próprio agente, que são melhores para
  // editar do que qualquer verbo que caberia neste CLI (ver Decisão C do
  // 2026-08-28-PLANO-editor-e-terminal.md). O `(unsaved changes)` vem do
  // registro alimentado pelo renderer; sem registro (nó fora da tela, ainda não
  // montado) sai SEM sufixo, que é o estado honesto: não sei.
  const editors = nodes.filter((n) => n.content.type === 'codeEditor')
  if (editors.length > 0) {
    lines.push('', 'Connected editors:')
    for (const node of editors) {
      const path = node.content.type === 'codeEditor' ? node.content.value.filePath : ''
      const state = editorState(node.id)
      const suffix = state?.dirty ? '  (unsaved changes)' : ''
      lines.push(`  ${nodeDisplayName(node.content)}  ${path}${suffix}`)
    }
    lines.push("  Read them with 'atelier editor read'; edit the file with your own tools.")
  }

  // Cofres: NOME e contagem, nunca as chaves e muito menos os valores. Quem
  // precisa das chaves pede `atelier vault list`, que é onde o aviso sobre o
  // que fazer com um segredo também mora.
  const vaults = nodes.filter((n) => n.content.type === 'secretVault')
  if (vaults.length > 0) {
    lines.push('', 'Connected vaults:')
    for (const node of vaults) {
      const v = node.content.type === 'secretVault' ? node.content.value : null
      const count = v?.keys.length ?? 0
      const state = v?.locked ? '  (locked)' : ''
      lines.push(`  ${nodeDisplayName(node.content)}  ${count} key${count === 1 ? '' : 's'}${state}`)
    }
    lines.push("  Use 'atelier vault list' for the key names.")
  }

  return lines.join('\n')
}
