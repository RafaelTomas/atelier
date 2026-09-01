/**
 * Registro em memória do índice de projetos.
 *
 * Segue o desenho do RoleStore: carrega uma vez no boot, mantém o mapa em
 * memória e grava a cada mutação. A diferença é o merge: aqui a fonte da
 * verdade é dividida entre o disco (que o scanner relê a cada varredura) e o
 * usuário/agente (que ninguém pode sobrescrever). Toda a regra dessa divisão
 * está em mergeScan, e é o que faz um re-scan não apagar favoritos nem as
 * descrições que o nó Scanner levou minutos para escrever.
 */
import { resolve, sep } from 'node:path'
import type { DiscoveredProject, Project, ProjectIndex, UUID } from '@shared/types'
import { nowISO } from '../coding'
import { log } from '../logger'
import { makeProject, makeProjectIndex } from '../models/project'
import { persistence } from '../persistence/persistence-manager'

export interface MergeScope {
  /** Raízes efetivamente varridas — só o que está sob elas pode ser arquivado. */
  roots: string[]
  /**
   * O scan terminou de verdade? Um scan cancelado ou estourado não provou
   * ausência de nada, então não pode arquivar.
   */
  archiveMissing: boolean
  /**
   * Projeto novo entra direto? A varredura do boot passa `false`: ela atualiza
   * o que já é conhecido e ARQUIVA o que sumiu, mas nada entra no índice sem o
   * usuário dizer que sim. Um scan pedido à mão passa `true` — quem clicou já
   * disse sim.
   */
  addNew?: boolean
}

export interface MergeSummary {
  added: number
  updated: number
  archived: number
}

/**
 * macOS e Windows têm sistemas de arquivo insensíveis a maiúsculas: sem isto,
 * o mesmo projeto entra duas vezes se o usuário escolher a pasta com outra
 * caixa.
 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

function normalizePath(path: string): string {
  const abs = resolve(path)
  return CASE_INSENSITIVE ? abs.toLowerCase() : abs
}

class ProjectStore {
  private index: ProjectIndex = makeProjectIndex()
  /** path normalizado → id. Evita varrer a lista a cada lookup do merge. */
  private byPathKey = new Map<string, UUID>()

  async load(): Promise<void> {
    this.index = await persistence.loadProjectIndex()
    this.reindex()
    log.debug('projects', `${this.index.projects.length} projeto(s) no índice`)
  }

  private reindex(): void {
    this.byPathKey.clear()
    for (const p of this.index.projects) this.byPathKey.set(normalizePath(p.path), p.id)
  }

  get all(): Project[] {
    return [...this.index.projects].sort((a, b) => a.name.localeCompare(b.name))
  }

  get snapshot(): ProjectIndex {
    return this.index
  }

  get(id: UUID): Project | null {
    return this.index.projects.find((p) => p.id === id) ?? null
  }

  byPath(path: string): Project | null {
    const id = this.byPathKey.get(normalizePath(path))
    return id ? this.get(id) : null
  }

  /**
   * Busca por nome, na mesma escada do findConnectedNode do CLI: exato,
   * depois substring, depois prefixo do caminho. É o que o agente Scanner usa
   * para dizer de que projeto está falando.
   */
  byName(query: string): Project | null {
    return this.resolveMany(query)[0] ?? null
  }

  /**
   * Todos os candidatos do degrau mais forte que casou — o caminho exato
   * primeiro, porque é o único identificador que não repete.
   *
   * Devolver a lista inteira, e não o primeiro, é o que deixa o CLI recusar um
   * "backend" ambíguo em vez de descrever calado o projeto errado.
   */
  resolveMany(query: string): Project[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const list = this.index.projects
    const tiers = [
      list.filter((p) => normalizePath(p.path) === normalizePath(query)),
      list.filter((p) => p.name.toLowerCase() === q),
      list.filter((p) => p.name.toLowerCase().includes(q)),
      list.filter((p) => p.path.toLowerCase().includes(q))
    ]
    return tiers.find((t) => t.length > 0) ?? []
  }

  search(query: string): Project[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.all
    return this.all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.kind.toLowerCase().includes(q) ||
        p.stack.some((s) => s.toLowerCase().includes(q))
    )
  }

  /** Projetos ainda sem descrição de agente — a fila de trabalho do Scanner. */
  get pending(): Project[] {
    return this.all.filter((p) => !p.isArchived && p.enrichedAt === null)
  }

  async mergeScan(found: DiscoveredProject[], scope: MergeScope): Promise<MergeSummary> {
    const now = nowISO()
    const summary: MergeSummary = { added: 0, updated: 0, archived: 0 }
    const seenKeys = new Set<string>()

    for (const disc of found) {
      const key = normalizePath(disc.path)
      seenKeys.add(key)
      const existingId = this.byPathKey.get(key)

      if (!existingId) {
        if (scope.addNew === false) {
          // Não entrou no índice, então também não conta como "visto": deixar
          // de fora de seenKeys é irrelevante aqui (nada a arquivar), mas o
          // candidato precisa continuar aparecendo para quem perguntar.
          continue
        }
        this.index.projects.push(makeProject(disc))
        summary.added++
        continue
      }

      this.overwriteFromDisk(existingId, disc, now)
      summary.updated++
    }

    if (scope.archiveMissing) {
      const roots = scope.roots.map(normalizePath)
      for (const p of this.index.projects) {
        const key = normalizePath(p.path)
        if (seenKeys.has(key) || p.isArchived) continue
        // Só arquiva o que estava sob uma raiz efetivamente varrida: um projeto
        // em disco externo desmontado não pode ser marcado por um scan que nem
        // olhou para lá.
        const wasInScope = roots.some((r) => key === r || key.startsWith(r + sep))
        if (!wasInScope) continue
        p.isArchived = true
        p.isMissing = true
        p.lastModifiedAt = now
        summary.archived++
      }
    }

    this.index.lastScanAt = now
    this.index.scanRoots = scope.roots
    this.reindex()
    await persistence.saveProjectIndex(this.index)
    log.info(
      'projects',
      `merge: +${summary.added} ~${summary.updated} arquivados ${summary.archived}`
    )
    return summary
  }

  /**
   * Sobrescreve o que o disco manda e preserva o que é do usuário e do agente.
   * É a regra do merge, isolada porque a adição avulsa precisa exatamente dela
   * — e só dela, sem tocar em lastScanAt nem em scanRoots.
   */
  private overwriteFromDisk(id: UUID, disc: DiscoveredProject, now: string): void {
    const i = this.index.projects.findIndex((p) => p.id === id)
    const prev = this.index.projects[i]
    this.index.projects[i] = {
      ...prev,
      // Derivados do disco: acabaram de ser relidos, são a verdade.
      kind: disc.kind,
      language: disc.language,
      gitBranch: disc.gitBranch,
      gitRemote: disc.gitRemote,
      // Nome só cede se o usuário nunca o editou.
      name: prev.hasCustomName ? prev.name : disc.name,
      // A descrição lida do disco só preenche vazio: nunca sobrescreve o que o
      // agente escreveu (que é justamente o caro de reproduzir).
      description: prev.description ?? disc.summary,
      stack: prev.enrichedAt ? prev.stack : disc.stack,
      isMissing: false,
      isArchived: false,
      lastSeenAt: now,
      lastModifiedAt: now
    }
  }

  /**
   * Um projeto escolhido à mão pelo usuário.
   *
   * Não é um scan de uma pasta só: um scan registra o que varreu (`scanRoots`,
   * `lastScanAt`) e ganha o direito de arquivar o que não achou. Aqui nada
   * disso vale — é uma adição pontual, e adicionar a mesma pasta duas vezes
   * atualiza a entrada em vez de duplicá-la.
   */
  async add(disc: DiscoveredProject): Promise<Project> {
    const now = nowISO()
    const existingId = this.byPathKey.get(normalizePath(disc.path))
    if (existingId) this.overwriteFromDisk(existingId, disc, now)
    else this.index.projects.push(makeProject(disc))
    this.reindex()
    await persistence.saveProjectIndex(this.index)
    return this.byPath(disc.path) as Project
  }

  /** Caminhos que o usuário recusou — a varredura do boot para de oferecê-los. */
  get ignoredPaths(): string[] {
    return this.index.excludedPaths
  }

  isIgnored(path: string): boolean {
    const key = normalizePath(path)
    return this.index.excludedPaths.some((p) => normalizePath(p) === key)
  }

  async ignore(paths: string[]): Promise<void> {
    for (const path of paths) if (!this.isIgnored(path)) this.index.excludedPaths.push(path)
    await persistence.saveProjectIndex(this.index)
    log.info('projects', `${paths.length} caminho(s) não serão mais oferecidos`)
  }

  /** Desfaz um `ignore`: a próxima varredura volta a oferecer o caminho. */
  async unignore(paths: string[]): Promise<void> {
    const gone = new Set(paths.map(normalizePath))
    this.index.excludedPaths = this.index.excludedPaths.filter((p) => !gone.has(normalizePath(p)))
    await persistence.saveProjectIndex(this.index)
    log.info('projects', `${paths.length} caminho(s) voltam a ser oferecidos`)
  }

  async patch(id: UUID, patch: Partial<Project>): Promise<Project | null> {
    const i = this.index.projects.findIndex((p) => p.id === id)
    if (i < 0) return null
    // id, path e createdAt são identidade: um patch nunca os move.
    const { id: _id, path: _path, createdAt: _createdAt, ...fields } = patch
    this.index.projects[i] = {
      ...this.index.projects[i],
      ...fields,
      lastModifiedAt: nowISO()
    }
    this.reindex()
    await persistence.saveProjectIndex(this.index)
    return this.index.projects[i]
  }

  /** Enriquecimento vindo do agente — só os três campos, nunca a identidade. */
  async describe(
    id: UUID,
    data: { description: string; stack?: string[]; role?: string | null }
  ): Promise<Project | null> {
    return this.patch(id, {
      description: data.description.slice(0, 500),
      ...(data.stack ? { stack: data.stack.slice(0, 12) } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      enrichedAt: nowISO()
    })
  }

  async touchOpened(id: UUID): Promise<void> {
    await this.patch(id, { lastOpenedAt: nowISO() })
  }

  async remove(id: UUID): Promise<void> {
    this.index.projects = this.index.projects.filter((p) => p.id !== id)
    this.reindex()
    await persistence.saveProjectIndex(this.index)
  }
}

export const projectIndex = new ProjectStore()
