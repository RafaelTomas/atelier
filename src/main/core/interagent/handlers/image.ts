/**
 * `atelier image <create|list>` — publica uma imagem como nó no canvas.
 *
 * O agente executa o que quiser (gera um gráfico, tira um screenshot com a
 * ferramenta dele) e entrega o CAMINHO do arquivo aqui; o Atelier copia os
 * bytes para o arquivo gerenciado do nó. O nó nasce já conectado ao terminal
 * chamador, mesmo gesto do `atelier note create` e do `atelier table create`.
 *
 * O transporte do CLI é texto (JSON, teto de 1 MB) — por isso é caminho de
 * arquivo, nunca os bytes inline.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { UUID } from '@shared/types'
import { isSupportedImageName, mimeForImageName, pngDimensions } from '@shared/image'
import { Constants } from '../../constants'
import { makeCanvasNode } from '../../models/workspace'
import { makeImageContent } from '../../models/node-content'
import { persistence } from '../../persistence/persistence-manager'
import { notifyRenderer } from '../../../ipc/notify'
import { connectedNodes, requireTerminalId, workspaceForTerminal } from './context'

const USAGE = 'error: usage: atelier image <create|list> …'

export async function handleImage(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'create':
      return createImage(args, tid)
    case 'list':
      return listImages(tid)
    default:
      return USAGE
  }
}

function takeFlags(args: string[]): { rest: string[]; alt: string | null } {
  const rest: string[] = []
  let alt: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--alt') alt = args[++i] ?? ''
    else rest.push(args[i])
  }
  return { rest, alt }
}

async function createImage(argv: string[], tid: UUID): Promise<string> {
  const { rest, alt } = takeFlags(argv)
  const title = rest[2]
  const path = rest[3]
  if (!title || !path) {
    return 'error: usage: atelier image create "Title" <path> [--alt "description"]'
  }
  if (!isAbsolute(path)) {
    return 'error: use an absolute path to the image file'
  }

  if (!isSupportedImageName(path)) {
    return 'error: unsupported image type. Use .png, .jpg, .jpeg, .gif, .webp, .avif, .svg or .bmp'
  }
  const mime = mimeForImageName(path)

  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    return `error: cannot read '${path}'`
  }
  if (bytes.byteLength === 0) return 'error: file is empty'
  if (bytes.byteLength > Constants.imageMaxBytes) {
    return `error: image is too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, limit ${Constants.imageMaxBytes / 1024 / 1024} MB)`
  }

  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'
  const caller = ws.node(tid)
  if (!caller) return 'error: calling terminal is not on this canvas'

  const dims = pngDimensions(bytes)
  const content = makeImageContent(title, {
    mimeType: mime,
    naturalWidth: dims?.width ?? 0,
    naturalHeight: dims?.height ?? 0,
    alt: alt ?? ''
  })

  const aspect = dims && dims.width > 0 ? dims.height / dims.width : 0.7
  const width = Constants.imageDefaultWidth
  const height = Math.round(width * aspect) + 24

  const node = makeCanvasNode(
    { x: caller.frame.x + caller.frame.width + 60, y: caller.frame.y, width, height },
    { type: 'image', value: content }
  )

  ws.addNode(node)
  ws.addConnection(tid, node.id)
  if (content.fileName) await persistence.writeImage(ws.id, content.fileName, bytes)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })

  return `Created image '${title}' (${(bytes.byteLength / 1024).toFixed(0)} KB), connected to this terminal.`
}

function listImages(tid: UUID): string {
  const images = connectedNodes(tid).filter((n) => n.content.type === 'image')
  if (images.length === 0) {
    return 'No connected images.\nUse `atelier image create "Title" <path>` to add one.'
  }
  const lines = ['Connected images:']
  for (const node of images) {
    if (node.content.type !== 'image') continue
    const c = node.content.value
    const dims = c.naturalWidth > 0 ? `  ${c.naturalWidth}×${c.naturalHeight}` : ''
    lines.push(`  ${c.title}${dims}  (${node.id.slice(0, 8)})`)
  }
  return lines.join('\n')
}
