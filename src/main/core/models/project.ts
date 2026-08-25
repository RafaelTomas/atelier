/**
 * Codec do índice de projetos (~/.atelier/projects.json).
 *
 * O modelo aqui é o de role.ts, não o de node-content.ts: struct plano, sem
 * enum com valor associado. Este arquivo não tem contraparte no app Swift — é
 * dele que vem a liberdade de ter schema próprio — mas mantemos o mesmo
 * dialeto (UUID maiúsculo, ISO8601 sem milissegundos) para que os arquivos de
 * ~/.atelier sejam legíveis com as mesmas regras.
 *
 * Todo decode é defensivo com default: é isso que faz um campo novo dispensar
 * migração — um projects.json escrito por uma versão anterior simplesmente
 * ganha os defaults ao ser lido.
 */
import type { DiscoveredProject, Project, ProjectIndex } from '@shared/types'
import { Constants } from '../constants'
import {
  asRecord,
  bool,
  decodeDate,
  decodeOptionalDate,
  nowISO,
  normalizeUUID,
  num,
  optStr,
  str,
  uuid
} from '../coding'

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function makeProject(found: DiscoveredProject, opts: Partial<Project> = {}): Project {
  const now = nowISO()
  return {
    id: uuid(),
    path: found.path,
    name: found.name,
    hasCustomName: false,
    kind: found.kind,
    language: found.language,
    gitRemote: found.gitRemote,
    gitBranch: found.gitBranch,
    isFavorite: false,
    isArchived: false,
    isMissing: false,
    tags: [],
    // O que o scanner leu do README/package.json entra como descrição inicial;
    // o nó Scanner sobrescreve depois com algo melhor, se rodar.
    description: found.summary,
    stack: found.stack,
    role: null,
    enrichedAt: null,
    lastSeenAt: now,
    lastOpenedAt: null,
    createdAt: now,
    lastModifiedAt: now,
    ...opts
  }
}

export function decodeProject(value: unknown): Project {
  const o = asRecord(value)
  return {
    id: normalizeUUID(o.id),
    path: str(o.path),
    name: str(o.name, 'Projeto'),
    hasCustomName: bool(o.hasCustomName),
    kind: str(o.kind, 'git'),
    language: optStr(o.language),
    gitRemote: optStr(o.gitRemote),
    gitBranch: optStr(o.gitBranch),
    isFavorite: bool(o.isFavorite),
    isArchived: bool(o.isArchived),
    isMissing: bool(o.isMissing),
    tags: strArray(o.tags),
    description: optStr(o.description),
    stack: strArray(o.stack),
    role: optStr(o.role),
    enrichedAt: decodeOptionalDate(o.enrichedAt),
    lastSeenAt: decodeDate(o.lastSeenAt),
    lastOpenedAt: decodeOptionalDate(o.lastOpenedAt),
    createdAt: decodeDate(o.createdAt),
    lastModifiedAt: decodeDate(o.lastModifiedAt)
  }
}

export function encodeProject(project: Project): Record<string, unknown> {
  return { ...project }
}

export function makeProjectIndex(): ProjectIndex {
  return {
    schemaVersion: Constants.projectIndexSchemaVersion,
    type: 'projectIndex',
    projects: [],
    lastScanAt: null,
    scanRoots: [],
    excludedPaths: []
  }
}

export function decodeProjectIndex(value: unknown): ProjectIndex {
  const o = asRecord(value)
  const list = Array.isArray(o.projects) ? o.projects : []
  return {
    schemaVersion: num(o.schemaVersion, Constants.projectIndexSchemaVersion),
    type: 'projectIndex',
    // Um projeto sem caminho não tem identidade e não abre nada: descartar é
    // mais honesto que deixá-lo aparecer no painel e falhar no clique.
    projects: list.map(decodeProject).filter((p) => p.path.length > 0),
    lastScanAt: decodeOptionalDate(o.lastScanAt),
    scanRoots: strArray(o.scanRoots),
    excludedPaths: strArray(o.excludedPaths)
  }
}

export function encodeProjectIndex(index: ProjectIndex): Record<string, unknown> {
  return {
    schemaVersion: Constants.projectIndexSchemaVersion,
    type: 'projectIndex',
    projects: index.projects.map(encodeProject),
    lastScanAt: index.lastScanAt,
    scanRoots: index.scanRoots,
    excludedPaths: index.excludedPaths
  }
}
