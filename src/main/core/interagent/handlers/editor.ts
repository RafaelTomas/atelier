/**
 * `atelier editor <list|open|read|close>` — o arquivo que o usuário está
 * olhando, do lado do agente.
 *
 * Existe por causa de duas coisas que NÃO estão em disco: o buffer com
 * alteração pendente e a seleção. Para tudo o mais o agente já tem ferramenta
 * melhor, e é por isso que aqui não há verbo de escrita (Decisão C do
 * 2026-08-28-PLANO-editor-e-terminal.md): `list` imprime o caminho absoluto, e
 * quem edita é o `Edit`/`Write` do próprio agente, que tem diff, permissão e
 * histórico. O file-watcher recarrega o nó sozinho depois.
 *
 * Escopo de permissão igual ao resto da família: `findConnectedNode(tid, nome,
 * 'codeEditor')` — só o que está cabeado ao terminal chamador.
 */
import type { CanvasNode, UUID } from '@shared/types'
import { editorState } from '../../editor/editor-registry'
import { makeCodeEditorContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { allowedRoots } from '../../projects/allowed-roots'
import { readTextFile } from '../../projects/file-ops'
import { resolveAllowedPath } from '../../projects/fs-access'
import { freeSpotRightOf } from '../../spawn-spot'
import { notifyRenderer } from '../../../ipc/notify'
import { connectedNodes, findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

/** Mesmo tamanho do editor aberto pelo canvas (store.openFileInWorkspace). */
const EDITOR_SIZE = { width: 620, height: 440 }

/** O texto vem do buffer do renderer, não do disco — quem lê tem de saber. */
const DIRTY_HEADER = '# unsaved changes — not on disk'

export async function handleEditor(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'list':
      return listEditors(tid)
    case 'open':
      return openEditor(args, tid)
    case 'read':
      return readEditor(args, tid)
    case 'close':
      return closeEditor(args, tid)
    default:
      return 'error: usage: atelier editor <list|open|read|close> …'
  }
}

function pathOf(node: CanvasNode): string {
  return node.content.type === 'codeEditor' ? node.content.value.filePath : ''
}

/**
 * O que o registro sabe, em uma linha. Sem entrada no registro sai VAZIO, nunca
 * "(saved)": nó fora da tela ou ainda não montado é "não sei", e afirmar que
 * está salvo é o que faria o agente gravar por cima de trabalho não revisto.
 */
function stateSuffix(nodeId: UUID): string {
  const state = editorState(nodeId)
  if (!state) return ''
  const parts: string[] = []
  if (state.dirty) parts.push('unsaved changes')
  if (state.selection) parts.push(`selected lines ${state.selection.from}-${state.selection.to}`)
  else parts.push(`cursor line ${state.cursorLine}`)
  return `  (${parts.join(', ')})`
}

function listEditors(tid: UUID): string {
  const editors = connectedNodes(tid).filter((n) => n.content.type === 'codeEditor')
  if (editors.length === 0) {
    return "No editors connected to this terminal. Open one with 'atelier editor open <path>'."
  }

  const lines = ['Connected editors:']
  for (const node of editors) {
    lines.push(`  ${nodeDisplayName(node.content)}  ${pathOf(node)}${stateSuffix(node.id)}`)
  }
  lines.push('', 'Read them here; edit the files with your own tools.')
  return lines.join('\n')
}

/**
 * Cria o nó do editor já cabeado ao chamador, como `note create` e
 * `portal open`.
 *
 * Duas recusas. A allowlist é a MESMA do renderer (core/projects/allowed-roots)
 * — um segundo conjunto de raízes aqui divergiria, e divergir neste ponto erra
 * para o lado de liberar demais. E caminho já aberto devolve o nó existente em
 * vez de criar um segundo buffer disputando o mesmo disco: é a regra de
 * `openFileInWorkspace` no renderer, e quebrá-la aqui deixaria dois editores
 * gravando um sobre o outro.
 */
async function openEditor(args: string[], tid: UUID): Promise<string> {
  const raw = args[2]
  if (!raw) return 'error: usage: atelier editor open <absolute path>'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const allowed = await resolveAllowedPath(raw, allowedRoots())
  if (!allowed.ok) {
    if (allowed.reason === 'missing') return `error: no such file: ${raw}`
    return [
      `error: '${raw}' is outside the paths this canvas may open.`,
      'The editor can open files under an indexed project, the workspace working',
      'directory, or a file-tree node root. Ask the user to add this folder — as a',
      'project or as a file tree — or open the file yourself with your own tools.'
    ].join('\n')
  }

  // Já aberto: o nó existente é a resposta. Se ainda não estava cabeado a quem
  // pediu, o cabo é adicionado — o agente pediu acesso a um arquivo que ele
  // podia abrir de qualquer forma, e um segundo nó seria o dano.
  const existing = ws.nodes.find(
    (n) => n.content.type === 'codeEditor' && n.content.value.filePath === allowed.path
  )
  if (existing) {
    const already = ws.connectedNodeIds(tid).includes(existing.id)
    if (!already) {
      ws.addConnection(tid, existing.id)
      notifyRenderer('workspace:changed', { workspaceId: ws.id })
    }
    const how = already ? 'already connected to this terminal' : 'now connected to this terminal'
    return `'${nodeDisplayName(existing.content)}' is already open at ${allowed.path} (${how}).`
  }

  const spot = freeSpotRightOf(ws, caller, EDITOR_SIZE)
  const node = makeCanvasNode(
    { ...spot, ...EDITOR_SIZE },
    { type: 'codeEditor', value: makeCodeEditorContent(allowed.path) }
  )
  ws.addNode(node)
  ws.addConnection(tid, node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  return `Opened '${nodeDisplayName(node.content)}' at ${allowed.path}, connected to this terminal.`
}

/** `--selection`, tirada dos argumentos posicionais. */
function takeFlags(args: string[]): { rest: string[]; selection: boolean } {
  const rest: string[] = []
  let selection = false
  for (const arg of args) {
    if (arg === '--selection') selection = true
    else rest.push(arg)
  }
  return { rest, selection }
}

/**
 * O texto: buffer do registro quando sujo, disco quando limpo.
 *
 * A ordem não é otimização, é correção. Um editor com alteração pendente tem em
 * disco a versão MORTA, e devolvê-la faria o agente trabalhar em cima do que o
 * usuário acabou de apagar.
 */
async function readEditor(argv: string[], tid: UUID): Promise<string> {
  const { rest: args, selection: wantSelection } = takeFlags(argv)
  if (args.length < 3) {
    return 'error: usage: atelier editor read "File" [offset] [limit] [--selection]'
  }

  const node = findConnectedNode(tid, args[2], 'codeEditor')
  if (!node) return `error: editor '${args[2]}' not found. Use 'atelier list'.`

  const state = editorState(node.id)
  let text: string
  let header = ''
  if (state?.dirty && state.buffer !== null) {
    text = state.buffer
    header = `${DIRTY_HEADER}\n`
  } else {
    const path = pathOf(node)
    const allowed = await resolveAllowedPath(path, allowedRoots())
    if (!allowed.ok) return `error: cannot read ${path} (${allowed.reason})`
    const result = await readTextFile(allowed.path)
    if ('error' in result) return `error: cannot read ${path} (${result.error})`
    text = result.text
  }

  const lines = text.split('\n')

  if (wantSelection) {
    // Sem seleção NÃO cai para o arquivo inteiro: "explica isto" com recorte
    // inventado é pior do que a recusa, porque o agente não teria como saber.
    if (!state) {
      return `error: nothing selected in '${nodeDisplayName(node.content)}' — the node is not on screen, so the Atelier does not know what is selected. Ask the user to bring it into view and select the lines.`
    }
    if (!state.selection) {
      return `error: nothing selected in '${nodeDisplayName(node.content)}' (cursor is on line ${state.cursorLine}). Ask the user to select the lines they mean.`
    }
    const { from, to } = state.selection
    const cut = lines.slice(from - 1, to).join('\n')
    return `${header}# lines ${from}-${to}, selected by the user\n${cut}`
  }

  // offset/limit em LINHAS e 0-based, igual ao `note read` — não inventar
  // convenção nova para o mesmo argumento.
  const offset = Number(args[3])
  const limit = Number(args[4])
  if (Number.isFinite(offset) && Number.isFinite(limit)) {
    return header + lines.slice(offset, offset + limit).join('\n')
  }
  return header + text
}

/**
 * Remove o nó. Editor sujo é recusa: fechar um buffer não salvo pelo CLI é
 * perda silenciosa de trabalho que ninguém reviu — o mesmo motivo pelo qual o
 * canvas pede confirmação ao usuário.
 */
async function closeEditor(args: string[], tid: UUID): Promise<string> {
  if (args.length < 3) return 'error: usage: atelier editor close "File"'

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const node = findConnectedNode(tid, args[2], 'codeEditor')
  if (!node) return `error: editor '${args[2]}' not found. Use 'atelier list'.`

  const state = editorState(node.id)
  if (state?.dirty) {
    return `error: '${nodeDisplayName(node.content)}' has unsaved changes — closing it here would throw them away. Ask the user to save (or discard) first.`
  }

  const label = nodeDisplayName(node.content)
  ws.removeNode(node.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Closed editor '${label}'.`
}
