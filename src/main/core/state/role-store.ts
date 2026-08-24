/**
 * Registro em memória das responsabilidades (o que a UI chama de "agentes").
 *
 * Segue o mesmo desenho do AppState: carrega uma vez no boot, mantém o mapa em
 * memória e grava em disco a cada mutação — são poucos arquivos, pequenos, e
 * escrever na hora evita perder uma responsabilidade recém-criada num crash.
 */
import type { AgentRole, UUID } from '@shared/types'
import { nowISO } from '../coding'
import { log } from '../logger'
import { makeAgentRole } from '../models/role'
import { persistence } from '../persistence/persistence-manager'

class RoleStore {
  private roles = new Map<UUID, AgentRole>()

  async load(): Promise<void> {
    this.roles.clear()
    for (const role of await persistence.loadRoles()) this.roles.set(role.id, role)
    log.debug('roles', `${this.roles.size} responsabilidade(s) carregada(s)`)
  }

  get all(): AgentRole[] {
    return [...this.roles.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: UUID | null): AgentRole | null {
    return id ? this.roles.get(id) ?? null : null
  }

  /** Visíveis num workspace: as globais mais as daquele workspace. */
  visibleIn(workspaceId: UUID | null): AgentRole[] {
    return this.all.filter((r) => r.workspaceId === null || r.workspaceId === workspaceId)
  }

  /** Cria quando `id` não existe, atualiza quando existe. */
  async save(patch: Partial<AgentRole> & { name: string }): Promise<AgentRole> {
    const existing = patch.id ? this.roles.get(patch.id) : undefined

    // `id` sai do spread: um `id: undefined` vindo do renderer sobrescreveria o
    // UUID recém-gerado e a responsabilidade nasceria sem identidade.
    const { id: patchId, ...fields } = patch
    const role: AgentRole = existing
      ? {
          ...existing,
          ...fields,
          id: existing.id,
          createdAt: existing.createdAt,
          lastModifiedAt: nowISO()
        }
      : makeAgentRole(patch.name, { ...fields, ...(patchId ? { id: patchId } : {}) })

    this.roles.set(role.id, role)
    await persistence.saveRole(role)
    return role
  }

  async remove(id: UUID): Promise<void> {
    this.roles.delete(id)
    await persistence.deleteRole(id)
  }

  /**
   * Terminais que apontam para uma responsabilidade apagada ficariam com um
   * assignedRoleId órfão — quem chama remove() é responsável por limpar isso.
   */
  has(id: UUID): boolean {
    return this.roles.has(id)
  }
}

export const roles = new RoleStore()
