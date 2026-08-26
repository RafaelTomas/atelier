/**
 * `atelier portal <list|open|go|read|html|shot|close>` — o Portal visto pelo agente.
 *
 * O escopo é o mesmo das notas e dos agentes: só o que está LIGADO POR CABO ao
 * terminal chamador (connectedNodes, em ./context.ts). Um portal no outro canto
 * do canvas não existe para quem não está conectado a ele.
 *
 * `open` é a exceção deliberada: cria um portal novo e já conectado — como o
 * `note create` faz com notas.
 */
import type { UUID } from '@shared/types'
import { normalizeURL } from '@shared/portal-url'
import { notifyRenderer } from '../../../ipc/notify'
import { nodeDisplayName } from '../../models/node-content'
import { portalHTML, portalInfo, portalShot, portalText } from '../../portal/portal-bridge'
import { spawnPortal } from '../../portal/portal-spawn'
import { connectedNodes, findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

const USAGE =
  'error: usage: atelier portal <list|open|go|read|html|shot|close> …'

export async function handlePortal(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'list':
      return listPortals(tid)
    case 'open':
      return openPortal(args, tid)
    case 'go':
      return goPortal(args, tid)
    case 'read':
      return readPortal(args, tid)
    case 'html':
      return htmlPortal(args, tid)
    case 'shot':
      return shotPortal(args, tid)
    case 'close':
      return closePortal(args, tid)
    default:
      return USAGE
  }
}

/** Alvo + erro padrão, repetido em cinco subcomandos. */
function target(tid: UUID, name: string | undefined): { id: UUID; label: string } | string {
  if (!name) return USAGE
  const node = findConnectedNode(tid, name, 'portal')
  if (!node) return `error: portal '${name}' not found. Use 'atelier portal list'.`
  return { id: node.id, label: nodeDisplayName(node.content) }
}

function listPortals(tid: UUID): string {
  const portals = connectedNodes(tid).filter((n) => n.content.type === 'portal')
  if (portals.length === 0) {
    return 'No connected portals.\nUse `atelier portal open <url>` to create one.'
  }
  const lines = ['Connected portals:']
  for (const node of portals) {
    const url = node.content.type === 'portal' ? node.content.value.currentURL : ''
    lines.push(`  ${nodeDisplayName(node.content)}  ${url}  (${node.id.slice(0, 8)})`)
  }
  return lines.join('\n')
}

function openPortal(args: string[], tid: UUID): string {
  if (args.length < 3) return 'error: usage: atelier portal open <url> [name]'
  // A mesma normalização da barra de endereço: `localhost:5173` é o que o
  // agente vai digitar, e tem que funcionar.
  const url = normalizeURL(args[2])
  if (!url) return 'error: empty url'

  const spawned = spawnPortal({ originId: tid, url, name: args[3] })
  if (!spawned) return 'error: calling terminal is not on this canvas'

  const name = args[3] ?? 'Portal'
  return `Opened portal '${name}' at ${url}, connected to this terminal.`
}

async function goPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  if (args.length < 4) return 'error: usage: atelier portal go "Portal" <url>'

  const url = normalizeURL(args[3])
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  // Escreve o conteúdo, não o webview: o nó pode estar desmontado, e ao montar
  // ele já nasce com o src certo — mesmo caminho da barra de endereço.
  ws.updateContent(found.id, (node) => {
    if (node.content.type !== 'portal') return
    node.content.value.currentURL = url
    node.content.value.source = { kind: 'url', url }
  })
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `'${found.label}' navigating to ${url}.`
}

async function readPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found

  try {
    const text = await portalText(found.id)
    const offset = Number(args[3])
    const limit = Number(args[4])
    // offset/limit em LINHAS, igual ao `note read` — não inventar convenção nova
    if (Number.isFinite(offset) && Number.isFinite(limit)) {
      return text.split('\n').slice(offset, offset + limit).join('\n')
    }
    return text
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function htmlPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  try {
    return await portalHTML(found.id, args[3])
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function shotPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  try {
    const file = await portalShot(found.id, ws.id, args[3])
    const info = await portalInfo(found.id)
    // Caminho, não base64: o agente abre a imagem com a ferramenta dele, e o
    // terminal não engasga com um blob de dois megabytes.
    return `Captured '${info.title || found.label}' to ${file}`
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function closePortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  ws.removeNode(found.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Closed portal '${found.label}'.`
}
