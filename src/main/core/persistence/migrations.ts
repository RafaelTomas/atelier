/**
 * Migrações de schema (porte de Sources/Workspace/Migrations/).
 *
 * A v1 guardava as conexões dentro de cada nó; a v2 promoveu para arrays no topo
 * do payload. Documentos v2 passam intactos.
 */
import { asRecord, num } from '../coding'
import { Constants } from '../constants'
import { log } from '../logger'

export function migrateWorkspaceDocument(raw: unknown): unknown {
  const doc = asRecord(raw)
  const version = num(doc.schemaVersion, 1)
  if (version >= Constants.schemaVersion) return doc

  log.info('migrations', `migrando workspace v${version} → v${Constants.schemaVersion}`)

  let current = doc
  if (version < 2) current = migrateV1toV2(current)
  return { ...current, schemaVersion: Constants.schemaVersion }
}

function migrateV1toV2(doc: Record<string, unknown>): Record<string, unknown> {
  const payload = asRecord(doc.payload)
  const arrays = [
    'connections',
    'noteConnections',
    'portalConnections',
    'portalToPortalConnections',
    'noteToNoteConnections',
    'crossFloorConnections',
    'floors',
    'drawings'
  ]
  const patched: Record<string, unknown> = { ...payload }
  for (const key of arrays) {
    if (!Array.isArray(patched[key])) patched[key] = []
  }
  return { ...doc, payload: patched }
}
