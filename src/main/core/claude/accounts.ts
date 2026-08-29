/**
 * Contas do Claude Code — a comutação entre logins dentro do Atelier.
 *
 * O `claude` não tem flag de conta: ele lê tudo de um diretório de configuração,
 * que é `CLAUDE_CONFIG_DIR` ou, na ausência dela, ~/.claude. Uma "conta" aqui é
 * portanto um DIRETÓRIO — `~/.atelier/claude-accounts/<id>/` — com credencial e
 * histórico próprios, e o gesto de trocar de conta é escolher qual diretório
 * entra no ambiente do PTY (ver TerminalManager.buildEnv).
 *
 * A conta padrão é sintética: id 'default', sem diretório. Ela significa "não
 * definir a variável". Apontar `CLAUDE_CONFIG_DIR` para ~/.claude NÃO seria
 * equivalente — o `claude` guarda o config global em `<configHome>/.claude.json`
 * quando a variável existe, mas em `~/.claude.json` quando ela não existe; o
 * usuário cairia num onboarding vazio com as próprias credenciais ao lado.
 *
 * Nada de segredo passa por aqui: quem grava e lê credencial é o próprio
 * `claude`, dentro do diretório. O Atelier só decide qual diretório é o da vez.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ClaudeAccount, ClaudeAccountInfo } from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID } from '@shared/types'
import { nowISO } from '../coding'
import { log } from '../logger'
import { claudeHomeDir, paths } from '../persistence/paths'
import { persistence } from '../persistence/persistence-manager'

/** Rótulo da conta padrão. O usuário não escolheu o nome dela — nós escolhemos. */
const DEFAULT_LABEL = 'Padrão (~/.claude)'

class ClaudeAccountStore {
  private accounts: ClaudeAccount[] = []

  async load(): Promise<void> {
    this.accounts = await persistence.loadClaudeAccounts()
    log.debug('claude-accounts', `${this.accounts.length} conta(s) extra(s) carregada(s)`)
  }

  /** Só as contas com diretório próprio — a padrão não mora em disco. */
  get all(): ClaudeAccount[] {
    return [...this.accounts]
  }

  /**
   * O `CLAUDE_CONFIG_DIR` de uma conta, ou null para a padrão.
   *
   * Id desconhecido também devolve null, e é de propósito: uma conta apagada
   * deixa terminais apontando para ela, e cair na conta padrão é o
   * comportamento de sempre — melhor que recusar o spawn ou inventar outra.
   */
  configDirFor(id: string | null): string | null {
    if (!id || id === DEFAULT_CLAUDE_ACCOUNT_ID) return null
    const account = this.accounts.find((a) => a.id === id)
    if (!account) {
      log.warn('claude-accounts', `conta '${id}' não existe mais; usando a padrão`)
      return null
    }
    return paths.claudeAccountDir(account.id)
  }

  /** Conta com diretório próprio. A padrão devolve false: ela não é uma delas. */
  has(id: string): boolean {
    return this.accounts.some((a) => a.id === id)
  }

  /** Rótulo para mensagem de UI. Conta sumida vira a padrão, como no spawn. */
  labelFor(id: string | null): string {
    if (!id || id === DEFAULT_CLAUDE_ACCOUNT_ID) return DEFAULT_LABEL
    return this.accounts.find((a) => a.id === id)?.label ?? DEFAULT_LABEL
  }

  /** Aceita id ou rótulo (o `atelier recruit --account` recebe o que o agente digitou). */
  resolve(idOrLabel: string): ClaudeAccount | 'default' | null {
    const needle = idOrLabel.trim().toLowerCase()
    if (needle === '' || needle === DEFAULT_CLAUDE_ACCOUNT_ID) return 'default'
    return (
      this.accounts.find((a) => a.id.toLowerCase() === needle) ??
      this.accounts.find((a) => a.label.toLowerCase() === needle) ??
      null
    )
  }

  /**
   * A lista para a UI: a padrão na frente, depois as extras, cada uma com quem
   * está logado nela. Ler o perfil é I/O por conta — são poucas, e a lista só é
   * pedida quando o seletor abre.
   */
  async list(): Promise<ClaudeAccountInfo[]> {
    const home = claudeHomeDir()
    const defaultInfo: ClaudeAccountInfo = {
      id: DEFAULT_CLAUDE_ACCOUNT_ID,
      label: DEFAULT_LABEL,
      createdAt: '',
      configDir: null,
      // Sem CLAUDE_CONFIG_DIR o config global fica no HOME, não dentro do
      // ~/.claude — a credencial é que mora lá.
      ...(await persistence.readClaudeProfile(
        join(homedir(), '.claude.json'),
        join(home, '.credentials.json')
      ))
    }

    const extras = await Promise.all(
      this.accounts.map(async (account) => {
        const dir = paths.claudeAccountDir(account.id)
        return {
          ...account,
          configDir: dir,
          ...(await persistence.readClaudeProfile(
            join(dir, '.claude.json'),
            join(dir, '.credentials.json')
          ))
        }
      })
    )
    return [defaultInfo, ...extras]
  }

  /**
   * Cria o diretório da conta e devolve o que ela ficou sendo, mais os avisos
   * do que não deu para herdar do ~/.claude. Não faz login: quem loga é o
   * `claude` no primeiro terminal aberto nessa conta.
   */
  async create(label: string): Promise<{ account: ClaudeAccount; warnings: string[] }> {
    const account: ClaudeAccount = {
      id: randomUUID(),
      label: label.trim() || 'Conta',
      createdAt: nowISO()
    }
    const warnings = await persistence.createClaudeAccountDir(
      paths.claudeAccountDir(account.id),
      claudeHomeDir()
    )
    this.accounts.push(account)
    await persistence.saveClaudeAccounts(this.accounts)
    log.info('claude-accounts', `conta '${account.label}' criada`)
    return { account, warnings }
  }

  async rename(id: string, label: string): Promise<ClaudeAccount | null> {
    const account = this.accounts.find((a) => a.id === id)
    if (!account) return null
    account.label = label.trim() || account.label
    await persistence.saveClaudeAccounts(this.accounts)
    return account
  }

  /**
   * Apaga a conta. `deleteFiles` leva junto o diretório — com ele vai a
   * credencial, e o login precisa ser refeito. Sem ele, some só da lista e o
   * diretório fica em ~/.atelier/claude-accounts/ para quem quiser voltar.
   *
   * Os terminais que apontavam para ela NÃO são reescritos: eles caem na conta
   * padrão no próximo spawn, pelo mesmo caminho de `configDirFor`.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    if (id === DEFAULT_CLAUDE_ACCOUNT_ID) return
    this.accounts = this.accounts.filter((a) => a.id !== id)
    await persistence.saveClaudeAccounts(this.accounts)
    if (deleteFiles) await persistence.deleteClaudeAccountDir(paths.claudeAccountDir(id))
    log.info('claude-accounts', `conta '${id}' removida (arquivos: ${deleteFiles})`)
  }
}

export const claudeAccounts = new ClaudeAccountStore()
