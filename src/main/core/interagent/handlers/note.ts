/** `atelier note <read|write|edit|create>` — porte de NoteHandler.swift. */
import type { UUID } from '@shared/types'
import { Constants } from '../../constants'
import { makeStickyNoteContent, nodeDisplayName } from '../../models/node-content'
import { makeCanvasNode } from '../../models/workspace'
import { persistence } from '../../persistence/persistence-manager'
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

/** Cria uma nota nova já conectada ao terminal chamador. */
async function createNote(args: string[], tid: UUID): Promise<string> {
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const name = `Note ${ws.nodes.filter((n) => n.content.type === 'stickyNote').length + 1}`
  const content = makeStickyNoteContent(name)
  const node = makeCanvasNode(
    {
      x: caller.frame.x + caller.frame.width + 60,
      y: caller.frame.y,
      width: Constants.noteDefaultWidth,
      height: Constants.noteDefaultHeight
    },
    { type: 'stickyNote', value: content }
  )

  ws.addNode(node)
  ws.addConnection(tid, node.id)

  if (content.fileName) {
    await persistence.writeNote(ws.id, content.fileName, args[2] ?? '')
  }
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Created note '${name}' connected to this terminal.`
}
