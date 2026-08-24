/**
 * Codec de ~/.atelier/roles/{UUID}.json — as "responsabilidades" (agentes).
 *
 * Um arquivo por responsabilidade, no mesmo dialeto Codable do resto do app:
 * UUID em MAIÚSCULAS e data ISO8601 sem milissegundos. Diferente do
 * workspace.json, aqui não há enum com valor associado — é um struct plano,
 * então encode é o próprio objeto.
 */
import type { AgentRole } from '@shared/types'
import { asRecord, decodeDate, normalizeUUID, nowISO, str, uuid } from '../coding'

/** Cor e ícone padrão de uma responsabilidade nova. */
export const ROLE_DEFAULT_ICON = 'sparkle'
export const ROLE_DEFAULT_COLOR = '#007AFF'

export function makeAgentRole(name: string, opts: Partial<AgentRole> = {}): AgentRole {
  const now = nowISO()
  return {
    id: uuid(),
    name,
    icon: ROLE_DEFAULT_ICON,
    color: ROLE_DEFAULT_COLOR,
    instructions: '',
    workspaceId: null,
    createdAt: now,
    lastModifiedAt: now,
    ...opts
  }
}

export function decodeAgentRole(value: unknown): AgentRole {
  const o = asRecord(value)
  return {
    id: normalizeUUID(o.id),
    name: str(o.name, 'Responsabilidade'),
    icon: str(o.icon, ROLE_DEFAULT_ICON),
    color: str(o.color, ROLE_DEFAULT_COLOR),
    instructions: str(o.instructions),
    workspaceId: o.workspaceId ? normalizeUUID(o.workspaceId) : null,
    createdAt: decodeDate(o.createdAt),
    lastModifiedAt: decodeDate(o.lastModifiedAt)
  }
}

export function encodeAgentRole(role: AgentRole): unknown {
  return { ...role }
}

/** Bloco que o agente lê via `atelier role` — instruções + cabeçalho. */
export function roleBriefing(role: AgentRole): string {
  const body = role.instructions.trim()
  return [
    `Responsabilidade: ${role.name}`,
    '',
    body.length > 0 ? body : '(sem instruções — defina no diálogo do terminal)'
  ].join('\n')
}
