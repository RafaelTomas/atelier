/**
 * Quais `.md` já estão ocupados num workspace.
 *
 * O arquivo é a identidade da nota em disco: duas notas apontando para o mesmo
 * `.md` gravam uma por cima da outra e, na reabertura, aparecem com o mesmo
 * texto. Conta tanto as notas no canvas quanto os arquivos que sobraram de
 * notas apagadas — reaproveitar um deles faria a nota nova nascer com texto
 * velho.
 */
import { log } from '../logger'
import { uniqueNoteFileName } from '../models/node-content'
import { persistence } from '../persistence/persistence-manager'
import type { WorkspaceManager } from './workspace-manager'

export async function takenNoteFiles(ws: WorkspaceManager): Promise<string[]> {
  const inCanvas = ws.nodes.flatMap((n) =>
    n.content.type === 'stickyNote' && n.content.value.fileName ? [n.content.value.fileName] : []
  )
  return [...inCanvas, ...(await persistence.listNotes(ws.id))]
}

/**
 * Conserta workspaces gravados antes da correção: toda nota criada pela UI
 * nascia com o mesmo `Note.md`, então duas notas dividiam o arquivo e, na
 * reabertura, apareciam com o mesmo texto.
 *
 * Dá arquivo próprio à segunda em diante — com uma cópia do texto que sobrou —
 * para que a partir daqui cada uma siga o seu caminho. O que já foi
 * sobrescrito em disco não tem como voltar.
 */
export async function repairSharedNoteFiles(ws: WorkspaceManager): Promise<boolean> {
  const seen = new Set<string>()
  const onDisk = new Set(await persistence.listNotes(ws.id))
  let changed = false

  for (const node of ws.nodes) {
    if (node.content.type !== 'stickyNote') continue
    const file = node.content.value.fileName
    if (!file) continue

    if (!seen.has(file)) {
      seen.add(file)
      continue
    }

    const base = file.replace(/\.md$/, '')
    const fresh = uniqueNoteFileName(base, [...seen, ...onDisk])
    await persistence.writeNote(ws.id, fresh, await persistence.readNote(ws.id, file))
    node.content.value.fileName = fresh
    seen.add(fresh)
    onDisk.add(fresh)
    changed = true
    log.warn('workspace', `nota duplicada em ${file} separada para ${fresh}`)
  }

  if (changed) ws.markDirty()
  return changed
}
