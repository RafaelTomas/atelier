/** `atelier note <read|write|edit|create>` — porte de NoteHandler.swift. */
import type { UUID } from '@shared/types'
import { Constants } from '../../constants'
import { makeStickyNoteContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { persistence } from '../../persistence/persistence-manager'
import { freeSpotRightOf } from '../../spawn-spot'
import { takenNoteFiles } from '../../state/note-files'
import { notifyRenderer } from '../../../ipc/notify'
import { findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

export async function handleNote(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const sub = args[1]
  switch (sub) {
    case 'read':
      return readNote(args, tid)
    case 'write':
      return writeNote(args, tid)
    case 'edit':
      return editNote(args, tid)
    case 'create':
      return createNote(args, tid)
    default:
      return 'error: usage: atelier note <read|write|edit|create> …'
  }
}

/** `--name`, tirada dos argumentos posicionais. */
function takeNoteFlags(args: string[]): { rest: string[]; name: string | null } {
  const rest: string[] = []
  let name: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') name = args[++i] ?? ''
    else rest.push(args[i])
  }
  return { rest, name }
}

function noteFileName(content: { type: string; value: unknown }): string | null {
  if (content.type !== 'stickyNote') return null
  return (content.value as { fileName: string | null }).fileName
}

async function readNote(args: string[], tid: UUID): Promise<string> {
  if (args.length < 3) return 'error: usage: atelier note read "Note Name" [offset] [limit]'
  const ws = workspaceForTerminal(tid)
  const node = findConnectedNode(tid, args[2], 'stickyNote')
  if (!ws || !node) return `error: note '${args[2]}' not found. Use 'atelier list'.`

  const file = noteFileName(node.content)
  if (!file) return 'error: note has no backing file'

  const content = await persistence.readNote(ws.id, file)
  const offset = Number(args[3])
  const limit = Number(args[4])
  if (Number.isFinite(offset) && Number.isFinite(limit)) {
    return content.split('\n').slice(offset, offset + limit).join('\n')
  }
  return content
}

async function writeNote(args: string[], tid: UUID): Promise<string> {
  if (args.length < 4) return 'error: usage: atelier note write "Note Name" "content"'
  const ws = workspaceForTerminal(tid)
  const node = findConnectedNode(tid, args[2], 'stickyNote')
  if (!ws || !node) return `error: note '${args[2]}' not found. Use 'atelier list'.`

  const file = noteFileName(node.content)
  if (!file) return 'error: note has no backing file'

  await persistence.writeNote(ws.id, file, args[3])
  notifyRenderer('note:changed', { workspaceId: ws.id, nodeId: node.id })
  return `Wrote ${args[3].length} chars to '${nodeDisplayName(node.content)}'.`
}

async function editNote(args: string[], tid: UUID): Promise<string> {
  if (args.length < 5) return 'error: usage: atelier note edit "Note Name" "old" "new"'
  const ws = workspaceForTerminal(tid)
  const node = findConnectedNode(tid, args[2], 'stickyNote')
  if (!ws || !node) return `error: note '${args[2]}' not found. Use 'atelier list'.`

  const file = noteFileName(node.content)
  if (!file) return 'error: note has no backing file'

  const current = await persistence.readNote(ws.id, file)
  if (!current.includes(args[3])) return `error: text not found in '${args[2]}'`

  const updated = current.replace(args[3], args[4])
  await persistence.writeNote(ws.id, file, updated)
  notifyRenderer('note:changed', { workspaceId: ws.id, nodeId: node.id })
  return `Edited '${nodeDisplayName(node.content)}'.`
}

/**
 * Cria uma nota nova já conectada ao terminal chamador.
 *
 * `--name` existe porque o nome da nota É o nome do arquivo `.md`, e é por ele
 * que todo mundo depois a endereça — o `atelier note read` de outro agente, o
 * cabo que o usuário lê no canvas, o editor externo que ele abre na pasta.
 * Sem a flag, uma nota criada por agente nasce `Note 2` e só o usuário
 * consegue renomeá-la, no cabeçalho do nó; um canvas montado pelo CLI ficava
 * com a parede toda chamada `Note N`.
 */
async function createNote(args: string[], tid: UUID): Promise<string> {
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const { rest, name: wanted } = takeNoteFlags(args)
  const content = makeStickyNoteContent(wanted || 'Note', await takenNoteFiles(ws))
  const name = content.fileName?.replace(/\.md$/, '') ?? 'Note'
  // `freeSpotRightOf`, e não `caller.x + width + 60` cru: a conta crua ignora
  // quem já está naquele ponto, e a nota nascia debaixo do nó anterior — foi o
  // que aconteceu ao montar a faixa central da demo, com a nota em cima do
  // botão. O editor, o portal e o `recruit` já passavam por aqui.
  const size = { width: Constants.noteDefaultWidth, height: Constants.noteDefaultHeight }
  const node = makeCanvasNode(
    { ...freeSpotRightOf(ws, caller, size), ...size },
    { type: 'stickyNote', value: content }
  )

  ws.addNode(node)
  ws.addConnection(tid, node.id)

  if (content.fileName) {
    await persistence.writeNote(ws.id, content.fileName, rest[2] ?? '')
  }
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Created note '${name}' connected to this terminal.`
}
