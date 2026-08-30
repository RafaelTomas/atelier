/**
 * Porte de Sources/Workspace/PersistenceManager.swift.
 *
 * Regra herdada do app nativo: TODA I/O de arquivo do app passa por aqui.
 * `fs` direto fora desta classe é violação de arquitetura.
 *
 * Escrita atômica: grava `.tmp` no mesmo diretório, faz fsync e renomeia.
 * `fs.rename` é atômico no mesmo sistema de arquivos e, no Windows, o Node usa
 * MoveFileEx com MOVEFILE_REPLACE_EXISTING — substitui sem erro.
 */
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { VaultFile } from '@shared/vault'
import { decodeVaultFile, emptyVaultFile } from '@shared/vault'
import { decodeStoredCodexUsage } from '@shared/agent-usage'
import type {
  AgentRole,
  AppStateData,
  ClaudeAccount,
  Preferences,
  ProjectIndex,
  StoredCodexUsage,
  StoredAccountUsage,
  UUID,
  WorkspaceManifest,
  WorkspacePayload
} from '@shared/types'
import { asRecord, num } from '../coding'
import { Constants } from '../constants'
import { log } from '../logger'
import {
  decodeAppStateData,
  decodeManifest,
  decodePreferences,
  makeAppStateData,
  makeManifest,
  makePreferences
} from '../models/app-state'
import {
  decodeProjectIndex,
  encodeProjectIndex,
  makeProjectIndex
} from '../models/project'
import { decodeAgentRole, encodeAgentRole } from '../models/role'
import { decodeWorkspaceDocument, encodeWorkspaceDocument } from '../models/workspace'
import { decryptFromBase64, encryptToBase64, vaultEncryptionAvailable } from '../vault/crypto'
import { migrateWorkspaceDocument } from './migrations'
import { paths } from './paths'

const isDev = process.env.NODE_ENV === 'development'

/**
 * O que uma conta nova do Claude herda do ~/.claude do usuário, por symlink.
 *
 * A lista é curta de propósito: é configuração, não identidade. Entra o que o
 * usuário espera reencontrar em qualquer conta (permissões, skills, plugins,
 * comandos, subagentes); fica de fora tudo que amarra o diretório a UMA conta —
 * `.credentials.json`, `.claude.json`, `projects/`, `sessions/`,
 * `history.jsonl`, `shell-snapshots/`, `telemetry/`, `cache/`. Ligar qualquer
 * um desses derrubaria o ponto inteiro do recurso: as duas contas voltariam a
 * disputar as mesmas credenciais.
 */
const CLAUDE_INHERITED_ENTRIES = [
  'settings.json',
  'skills',
  'plugins',
  'commands',
  'agents'
] as const

/** O workspace lido e o que o decoder observou no caminho. */
export interface LoadedWorkspace {
  payload: WorkspacePayload
  /** A versão gravada no arquivo, antes da migração. */
  fileSchemaVersion: number
  droppedNodes: number
}

class PersistenceManager {
  // ─── Infra ──────────────────────────────────────────────────────────────────

  private stringify(value: unknown): string {
    // Em dev, pretty + chaves ordenadas, para o diff contra os arquivos do app Swift
    return isDev ? JSON.stringify(value, sortedReplacer, 2) : JSON.stringify(value)
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync() // garante que os bytes chegaram ao disco antes do rename
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, filePath)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  /**
   * Escrita atômica de binário — mesma dança `.tmp` + fsync + rename da
   * `atomicWrite`, sem `encoding`. Para os bytes dos nós de imagem.
   */
  private async atomicWriteBinary(filePath: string, data: Buffer): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, filePath)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  private async readJSON(filePath: string): Promise<unknown | null> {
    try {
      const text = await readFile(filePath, 'utf8')
      return JSON.parse(text)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.error('persistence', `falha lendo ${filePath}`, err)
      return null
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  // ─── Diretórios ─────────────────────────────────────────────────────────────

  async ensureDirectories(): Promise<void> {
    for (const dir of [paths.root(), paths.workspacesDir(), paths.rolesDir(), paths.runDir()]) {
      await mkdir(dir, { recursive: true })
    }
  }

  async ensureWorkspaceDirectories(id: UUID): Promise<void> {
    for (const dir of [
      paths.workspaceDir(id),
      paths.notesDir(id),
      paths.tablesDir(id),
      paths.imagesDir(id),
      paths.todosDir(id),
      paths.terminalsDir(id),
      paths.vaultsDir(id),
      paths.snapshotsDir(id)
    ]) {
      await mkdir(dir, { recursive: true })
    }
  }

  // ─── manifest.json ──────────────────────────────────────────────────────────

  async loadManifest(): Promise<WorkspaceManifest> {
    const raw = await this.readJSON(paths.manifest())
    return raw ? decodeManifest(raw) : makeManifest()
  }

  async saveManifest(manifest: WorkspaceManifest): Promise<void> {
    await this.atomicWrite(paths.manifest(), this.stringify(manifest))
  }

  // ─── app-state.json ─────────────────────────────────────────────────────────

  async loadAppState(): Promise<AppStateData> {
    const raw = await this.readJSON(paths.appState())
    return raw ? decodeAppStateData(raw) : makeAppStateData()
  }

  async saveAppState(state: AppStateData): Promise<void> {
    await this.atomicWrite(paths.appState(), this.stringify(state))
  }

  // ─── preferences.json ───────────────────────────────────────────────────────

  async loadPreferences(): Promise<Preferences> {
    const raw = await this.readJSON(paths.preferences())
    return raw ? decodePreferences(raw) : makePreferences()
  }

  async savePreferences(prefs: Preferences): Promise<void> {
    await this.atomicWrite(paths.preferences(), this.stringify(prefs))
  }

  // ─── workspace.json ─────────────────────────────────────────────────────────

  /**
   * Lê o workspace com o que o decoder tem a dizer sobre ele: a versão que
   * estava no arquivo e quantos nós não sobreviveram à leitura.
   *
   * Quem abre precisa dos dois: a versão decide se cabe um backup no primeiro
   * save, e a contagem decide se o workspace entra em modo seguro em vez de
   * regravar o arquivo sem os nós que não foram entendidos.
   */
  async loadWorkspaceDocument(id: UUID): Promise<LoadedWorkspace | null> {
    const raw = await this.readJSON(paths.workspaceFile(id))
    if (!raw) return null
    const fileSchemaVersion = num(asRecord(raw).schemaVersion, 1)
    const migrated = migrateWorkspaceDocument(raw)
    const { payload, droppedNodes } = decodeWorkspaceDocument(migrated)
    if (droppedNodes > 0) {
      log.warn(
        'persistence',
        `workspace ${id}: ${droppedNodes} nó(s) não reconhecido(s) — gravação bloqueada`
      )
    }
    return { payload, fileSchemaVersion, droppedNodes }
  }

  async loadWorkspace(id: UUID): Promise<WorkspacePayload | null> {
    return (await this.loadWorkspaceDocument(id))?.payload ?? null
  }

  /**
   * `backupFrom` é a versão que está no arquivo em disco. Quando ela é menor
   * que a do app, o original é copiado para `workspace.v{n}.backup.json` ANTES
   * da primeira gravação na versão nova.
   *
   * Custa uma escrita, uma vez na vida do arquivo, e é a única rede para quem
   * precisar voltar ao app nativo ou a um build anterior: uma vez regravado em
   * v3, o arquivo não volta sozinho para v2.
   */
  async saveWorkspace(payload: WorkspacePayload, backupFrom?: number): Promise<void> {
    await this.ensureWorkspaceDirectories(payload.id)
    const file = paths.workspaceFile(payload.id)

    if (typeof backupFrom === 'number' && backupFrom < Constants.schemaVersion) {
      const backup = join(paths.workspaceDir(payload.id), `workspace.v${backupFrom}.backup.json`)
      // Nunca sobrescreve um backup existente: o valor dele é ser o arquivo
      // como estava ANTES da subida, não a última cópia.
      if ((await this.exists(file)) && !(await this.exists(backup))) {
        try {
          await copyFile(file, backup)
          log.info('persistence', `backup v${backupFrom} gravado em ${backup}`)
        } catch (err) {
          log.error('persistence', 'falha gravando backup da versão anterior', err)
        }
      }
    }

    await this.atomicWrite(file, this.stringify(encodeWorkspaceDocument(payload)))
  }

  async deleteWorkspace(id: UUID): Promise<void> {
    await rm(paths.workspaceDir(id), { recursive: true, force: true })
  }

  // ─── Responsabilidades (roles/*.json) ───────────────────────────────────────
  // Um arquivo por responsabilidade: criar, editar ou apagar uma não reescreve
  // as outras, e dá para versionar ou editar à mão fora do app.

  async loadRoles(): Promise<AgentRole[]> {
    let files: string[]
    try {
      files = await readdir(paths.rolesDir())
    } catch {
      return []
    }

    const roles: AgentRole[] = []
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const raw = await this.readJSON(join(paths.rolesDir(), file))
      if (raw) roles.push(decodeAgentRole(raw))
    }
    return roles
  }

  async saveRole(role: AgentRole): Promise<void> {
    await mkdir(paths.rolesDir(), { recursive: true })
    await this.atomicWrite(paths.roleFile(role.id), this.stringify(encodeAgentRole(role)))
  }

  async deleteRole(id: UUID): Promise<void> {
    await rm(paths.roleFile(id), { force: true })
  }

  // ─── Contas do Claude (claude-accounts.json + claude-accounts/<id>/) ────────
  // Arquivo raiz próprio, e NÃO uma chave em preferences.json: aquele arquivo é
  // compartilhado com o app nativo Swift, que regravaria o preferences sem a
  // chave que ele não conhece — e as contas sumiriam no primeiro save de lá.

  async loadClaudeAccounts(): Promise<ClaudeAccount[]> {
    const raw = await this.readJSON(paths.claudeAccounts())
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => asRecord(item))
      .filter((o) => typeof o.id === 'string' && o.id.length > 0)
      .map((o) => ({
        id: String(o.id),
        label: typeof o.label === 'string' && o.label ? o.label : String(o.id),
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString()
      }))
  }

  async saveClaudeAccounts(accounts: ClaudeAccount[]): Promise<void> {
    await this.atomicWrite(paths.claudeAccounts(), this.stringify(accounts))
  }

  /**
   * A última leitura de limites de cada conta (claude-usage.json).
   *
   * Leitura defensiva como a das contas: o arquivo é telemetria, e um campo
   * torto nele não pode derrubar o boot. Entrada sem `accountId` ou sem janela
   * nenhuma é descartada — ela não descreveria conta alguma.
   */
  async loadClaudeUsage(): Promise<StoredAccountUsage[]> {
    const raw = await this.readJSON(paths.claudeUsage())
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => asRecord(item))
      .filter((o) => typeof o.accountId === 'string' && o.accountId.length > 0)
      .map((o) => ({
        accountId: String(o.accountId),
        at: typeof o.at === 'string' ? o.at : '',
        limits: (Array.isArray(o.limits) ? o.limits : [])
          .map((l) => asRecord(l))
          .filter((l) => typeof l.window === 'string' && num(l.pct) !== null)
          .map((l) => ({
            window: String(l.window),
            pct: num(l.pct) ?? 0,
            resetsAt: num(l.resetsAt)
          }))
      }))
      .filter((entry) => entry.limits.length > 0)
  }

  async saveClaudeUsage(entries: StoredAccountUsage[]): Promise<void> {
    await this.atomicWrite(paths.claudeUsage(), this.stringify(entries))
  }

  async loadCodexUsage(): Promise<StoredCodexUsage | null> {
    return decodeStoredCodexUsage(await this.readJSON(paths.codexUsage()))
  }

  async saveCodexUsage(entry: StoredCodexUsage): Promise<void> {
    await this.atomicWrite(paths.codexUsage(), this.stringify(entry))
  }

  /**
   * Cria o diretório de uma conta e liga o que ela HERDA do ~/.claude do
   * usuário: settings, skills, plugins, comandos e subagentes. O que não é
   * ligado — credenciais, sessões, histórico, projetos — é justamente o que
   * precisa ficar separado para duas contas coexistirem.
   *
   * Symlink, não cópia: settings e skills continuam sendo UM lugar só, então
   * editar a skill no ~/.claude vale para todas as contas. No Windows o link
   * simbólico exige privilégio; quando falha, copia e devolve o aviso, porque a
   * diferença é visível para o usuário (a cópia congela no tempo).
   */
  async createClaudeAccountDir(dir: string, inheritFrom: string): Promise<string[]> {
    await mkdir(dir, { recursive: true })
    const warnings: string[] = []
    for (const entry of CLAUDE_INHERITED_ENTRIES) {
      const source = join(inheritFrom, entry)
      const target = join(dir, entry)
      let isDir: boolean
      try {
        isDir = (await stat(source)).isDirectory()
      } catch {
        continue // o usuário não tem esse arquivo/pasta; não há o que herdar
      }
      if (await this.exists(target)) continue
      try {
        await symlink(source, target, isDir ? 'junction' : 'file')
      } catch {
        try {
          await cp(source, target, { recursive: true })
          warnings.push(`'${entry}' foi copiado em vez de ligado (o sistema recusou o link)`)
        } catch (err) {
          log.warn('claude-accounts', `não deu para herdar '${entry}'`, err)
          warnings.push(`'${entry}' não pôde ser herdado do ~/.claude`)
        }
      }
    }
    return warnings
  }

  async deleteClaudeAccountDir(dir: string): Promise<void> {
    // `rm` não segue symlink: apaga o link, nunca o ~/.claude do outro lado.
    await rm(dir, { recursive: true, force: true })
  }

  /**
   * O que o `claude` já gravou naquele diretório: quem está logado e se há
   * credencial. `configFile` é o `.claude.json` do CLAUDE_CONFIG_DIR — na conta
   * padrão ele mora no home, e não dentro do ~/.claude (ver claudeAccountInfo).
   */
  async readClaudeProfile(
    configFile: string,
    credentialsFile: string
  ): Promise<{ email: string | null; plan: string | null; authenticated: boolean }> {
    const raw = asRecord(await this.readJSON(configFile))
    const account = asRecord(raw.oauthAccount)
    return {
      email: typeof account.emailAddress === 'string' ? account.emailAddress : null,
      plan: typeof account.organizationType === 'string' ? account.organizationType : null,
      authenticated: await this.exists(credentialsFile)
    }
  }

  // ─── Índice de projetos (projects.json) ─────────────────────────────────────
  // Arquivo raiz próprio, com schema próprio: o índice é global, não pertence a
  // nenhum workspace, e não tem contraparte no app Swift — por isso fica fora
  // do workspace.json e das migrações dele.

  async loadProjectIndex(): Promise<ProjectIndex> {
    const raw = await this.readJSON(paths.projects())
    return raw ? decodeProjectIndex(raw) : makeProjectIndex()
  }

  async saveProjectIndex(index: ProjectIndex): Promise<void> {
    await this.atomicWrite(paths.projects(), this.stringify(encodeProjectIndex(index)))
  }

  // ─── Notas (.md) ────────────────────────────────────────────────────────────

  /** Nomes dos `.md` já em disco — usados para não reaproveitar arquivo órfão. */
  async listNotes(workspaceId: UUID): Promise<string[]> {
    try {
      return (await readdir(paths.notesDir(workspaceId))).filter((f) => f.endsWith('.md'))
    } catch {
      return []
    }
  }

  async readNote(workspaceId: UUID, fileName: string): Promise<string> {
    try {
      return await readFile(join(paths.notesDir(workspaceId), fileName), 'utf8')
    } catch {
      return ''
    }
  }

  async writeNote(workspaceId: UUID, fileName: string, content: string): Promise<void> {
    await mkdir(paths.notesDir(workspaceId), { recursive: true })
    await this.atomicWrite(join(paths.notesDir(workspaceId), fileName), content)
  }

  // ─── Tabelas de resultado (.json) ───────────────────────────────────────────
  // Espelham readNote/writeNote: colunas e linhas de um nó dataTable vivem num
  // arquivo gerenciado, e só a identidade fica no workspace.json.

  async readTable(workspaceId: UUID, fileName: string): Promise<unknown | null> {
    return this.readJSON(join(paths.tablesDir(workspaceId), fileName))
  }

  async writeTable(workspaceId: UUID, fileName: string, value: unknown): Promise<void> {
    await mkdir(paths.tablesDir(workspaceId), { recursive: true })
    await this.atomicWrite(join(paths.tablesDir(workspaceId), fileName), this.stringify(value))
  }

  // ─── Imagens (bytes dos nós de imagem) ─────────────────────────────────────
  // Um arquivo por nó em `images/<id>.<ext>`, só a identidade no workspace.json —
  // mesma divisão da nota e da tabela.

  /** `fileName` já vem sanitizado pelo bridge (sem `..` nem separador). */
  async readImage(workspaceId: UUID, fileName: string): Promise<Buffer | null> {
    try {
      return await readFile(join(paths.imagesDir(workspaceId), fileName))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.error('persistence', `falha lendo imagem ${fileName}`, err)
      return null
    }
  }

  async writeImage(workspaceId: UUID, fileName: string, data: Buffer): Promise<void> {
    await mkdir(paths.imagesDir(workspaceId), { recursive: true })
    await this.atomicWriteBinary(join(paths.imagesDir(workspaceId), fileName), data)
  }

  async deleteImage(workspaceId: UUID, fileName: string): Promise<void> {
    await rm(join(paths.imagesDir(workspaceId), fileName), { force: true })
  }

  // ─── Cofres (.vault cifrado) ───────────────────────────────────────────────
  // Mesma divisão da nota, da tabela e da imagem — um arquivo por nó, só a
  // identidade no workspace.json —, com uma diferença que muda tudo: o que vai
  // para o disco é o `safeStorage.encryptString` do JSON, em base64, nunca o
  // JSON cru. Sem chaveiro do SO não se lê nem se grava: o cofre fica bloqueado,
  // e o nó mostra esse estado em vez de o Atelier cair para texto em claro.

  /** Dá para cifrar neste sistema? false = todo cofre está bloqueado. */
  vaultAvailable(): boolean {
    return vaultEncryptionAvailable()
  }

  /**
   * O cofre decifrado.
   *
   * Distinção que importa a quem chama: cofre que ainda não existe volta VAZIO
   * (é o estado de um nó recém-criado), enquanto cofre ilegível — chaveiro
   * ausente, blob de outro sistema — volta null, e null é o que acende o estado
   * bloqueado na UI. Confundir os dois faria a UI oferecer "adicionar chave"
   * num cofre cujo conteúdo ela não conseguiu ler, e o primeiro save apagaria
   * o que estava lá.
   */
  async readVault(workspaceId: UUID, vaultId: UUID): Promise<VaultFile | null> {
    if (!vaultEncryptionAvailable()) return null
    const file = paths.vaultFile(workspaceId, vaultId)
    let base64: string
    try {
      base64 = await readFile(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return emptyVaultFile()
      log.error('persistence', `falha lendo o cofre ${vaultId}`, err)
      return null
    }
    const plain = decryptFromBase64(base64.trim())
    if (plain === null) return null
    let decoded: VaultFile | null
    try {
      decoded = decodeVaultFile(JSON.parse(plain))
    } catch (err) {
      log.error('persistence', `cofre ${vaultId} decifrou mas não é JSON`, err)
      return null
    }
    // Cofre de uma versão mais nova que esta: mesmo caminho do chaveiro
    // ausente — bloqueado na UI, e nada é regravado por cima.
    if (!decoded) {
      log.error('persistence', `cofre ${vaultId} é de uma versão mais nova — não será tocado`)
      return null
    }
    return decoded
  }

  /** true = gravou. false = sem chaveiro; NADA foi escrito, nem em claro. */
  async writeVault(workspaceId: UUID, vaultId: UUID, file: VaultFile): Promise<boolean> {
    const base64 = encryptToBase64(JSON.stringify(file))
    if (base64 === null) return false
    await mkdir(paths.vaultsDir(workspaceId), { recursive: true })
    await this.atomicWrite(paths.vaultFile(workspaceId, vaultId), base64)
    return true
  }

  async deleteVault(workspaceId: UUID, vaultId: UUID): Promise<void> {
    await rm(paths.vaultFile(workspaceId, vaultId), { force: true })
  }

  /**
   * Uma linha na trilha de auditoria dos cofres. Append simples, como o
   * scrollback: alta frequência não é o caso aqui, mas escrita atômica de um
   * arquivo que só cresce seria trocar o arquivo inteiro a cada acesso.
   *
   * O arquivo é EM CLARO, de propósito — ele precisa ser legível sem chaveiro,
   * para responder "quem leu o quê" mesmo num sistema onde o cofre não abre. É
   * por isso que quem chama nunca escreve valor aqui.
   */
  async appendVaultAccess(workspaceId: UUID, line: string): Promise<void> {
    await mkdir(paths.vaultsDir(workspaceId), { recursive: true })
    await writeFile(paths.vaultAccessLog(workspaceId), line, { flag: 'a', encoding: 'utf8' })
  }

  /** As últimas linhas da trilha, mais novas primeiro. Vazio se não há arquivo. */
  async readVaultAccess(workspaceId: UUID, limit = 20): Promise<string[]> {
    try {
      const text = await readFile(paths.vaultAccessLog(workspaceId), 'utf8')
      return text.split('\n').filter(Boolean).reverse().slice(0, limit)
    } catch {
      return []
    }
  }

  // ─── Área temporária ──────────────────────────────────────────────────────
  // Imagem colada dentro de um terminal vira arquivo aqui, e o caminho é
  // "digitado" no PTY para o agente ler. Efêmero: limpo no boot por idade.

  async writeTempImage(fileName: string, data: Buffer): Promise<string> {
    const dir = paths.tmpDir()
    await mkdir(dir, { recursive: true })
    const file = join(dir, fileName)
    await this.atomicWriteBinary(file, data)
    return file
  }

  /** Apaga o que passou de `maxAgeMs` em `tmpDir`. Chamado no boot, sem bloquear. */
  async cleanTempDir(maxAgeMs: number): Promise<void> {
    let files: string[]
    try {
      files = await readdir(paths.tmpDir())
    } catch {
      return
    }
    const cutoff = Date.now() - maxAgeMs
    for (const name of files) {
      const file = join(paths.tmpDir(), name)
      try {
        const info = await stat(file)
        if (info.mtimeMs < cutoff) await rm(file, { force: true })
      } catch {
        /* corrida com outra limpeza — ignora */
      }
    }
  }

  // ─── Scrollback ─────────────────────────────────────────────────────────────
  // Não usa escrita atômica: é append de alta frequência (mesma exceção do app nativo).

  async appendScrollback(workspaceId: UUID, terminalId: UUID, chunk: string): Promise<void> {
    const file = paths.scrollback(workspaceId, terminalId)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, chunk, { flag: 'a', encoding: 'utf8' })
  }

  async readScrollback(workspaceId: UUID, terminalId: UUID): Promise<string> {
    try {
      return await readFile(paths.scrollback(workspaceId, terminalId), 'utf8')
    } catch {
      return ''
    }
  }
}

/** Ordena chaves na saída para diff estável contra os arquivos do app Swift. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (value as Record<string, unknown>)[k]
        return acc
      }, {})
  }
  return value
}

export const persistence = new PersistenceManager()
