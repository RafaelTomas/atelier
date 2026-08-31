import type { CodexAccountUsage, StoredCodexUsage } from '@shared/types'
import { fromCodexRateLimits, mergeCodexAccount } from '@shared/agent-usage'
import { notifyRenderer } from '../../ipc/notify'
import { log } from '../logger'
import { persistence } from '../persistence/persistence-manager'
import { CodexJsonRpcClient, codexInitializeParams, spawnCodexAppServer } from './codex-protocol'
import { hasCodexAccount } from './codex-presence'
import { CodexRolloutWatcher } from './codex-rollout'

const SAVE_DEBOUNCE_MS = 5000

/**
 * Quanto tempo esperar antes de tentar o App Server de novo depois que ele
 * falhou. Existe conta no disco mas o `codex` não sobe (não instalado, PATH
 * diferente do da sessão gráfica): sem esta trava, cada painel que abre paga um
 * spawn e escreve mais um stack trace de ENOENT no log.
 */
const RETRY_AFTER_MS = 60_000

function empty(
  source: CodexAccountUsage['source'] = 'none',
  available = false
): CodexAccountUsage {
  return {
    authMode: null,
    planType: null,
    limits: [],
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    rateLimitReachedType: null,
    resetCreditsAvailable: null,
    tokenUsage: null,
    at: new Date().toISOString(),
    source,
    available
  }
}

export class CodexTelemetryService {
  private refs = 0
  private client: CodexJsonRpcClient | null = null
  private account: CodexAccountUsage = empty()
  private saveTimer: NodeJS.Timeout | null = null
  private rollout = new CodexRolloutWatcher()
  /** null = ainda não perguntamos ao disco. */
  private hasAccount: boolean | null = null
  private lastFailureAt = 0

  get current(): CodexAccountUsage {
    return this.account
  }

  async loadStored(): Promise<void> {
    // A pergunta vem antes da leitura guardada de propósito: quem desfez o
    // login no Codex não quer ver o plano e os tokens da conta antiga
    // ressuscitarem no monitor a cada boot.
    if (!(await this.detectAccount())) return
    const stored = await persistence.loadCodexUsage()
    if (!stored) return
    this.account = {
      ...empty('stored', true),
      planType: stored.planType,
      limits: stored.limits,
      credits: stored.credits,
      individualLimit: stored.individualLimit,
      spendControlReached: stored.spendControlReached,
      rateLimitReachedType: stored.rateLimitReachedType,
      tokenUsage: stored.tokenUsage,
      at: stored.at
    }
  }

  /**
   * Assinar custa um observador de arquivo, e é isso que torna a assinatura
   * barata a ponto de a tira da borda poder mantê-la a sessão inteira.
   *
   * O App Server só é levantado se o disco não tiver nada a dizer — conta
   * recém-criada, ou quem ainda não rodou um turno hoje. Quem usa o Codex
   * normalmente nunca paga por um subprocesso aqui.
   */
  async subscribe(): Promise<CodexAccountUsage> {
    this.refs += 1
    if (!(await this.detectAccount())) return this.account
    await this.startRollout()
    if (this.account.source !== 'live') await this.ensureStarted()
    return this.account
  }

  async unsubscribe(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs === 0) this.stop()
  }

  async refreshAccount(): Promise<CodexAccountUsage> {
    // O ↻ é o gesto de quem acabou de fazer `codex login` na outra janela:
    // relê o disco e derruba o backoff, em vez de repetir a resposta velha.
    this.hasAccount = null
    this.lastFailureAt = 0
    await this.startRollout()
    await this.ensureStarted()
    if (!this.client) return this.account
    await this.readAccount()
    return this.account
  }

  async accountUsage(): Promise<unknown | null> {
    await this.ensureStarted()
    if (!this.client) return null
    try {
      return await this.client.request('account/usage/read', {})
    } catch (err) {
      log.warn('codex', 'account/usage/read falhou', err)
      return null
    }
  }

  async shutdown(): Promise<void> {
    await this.flush()
    this.stop()
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return
    // Sem conta cadastrada não há o que perguntar — e `detectAccount` já
    // deixou a leitura zerada para o monitor.
    if (!(await this.detectAccount())) return
    if (Date.now() - this.lastFailureAt < RETRY_AFTER_MS) return
    try {
      this.client = spawnCodexAppServer()
      this.client.on('notification', (method: string, params: unknown) => {
        if (method === 'account/rateLimits/updated') void this.readAccount()
        if (method === 'account/updated') this.mergeAccount(params)
      })
      await this.client.initialize(codexInitializeParams())

      await this.readAccount()
    } catch (err) {
      log.warn('codex', 'Codex App Server indisponivel', err)
      this.lastFailureAt = Date.now()
      this.client?.close()
      this.client = null
      if (this.account.source !== 'stored') this.account = empty('none', true)
    }
  }

  /**
   * Existe conta do Codex no disco? Memoizado porque `ensureStarted` roda a
   * cada assinatura de painel; `refreshAccount` limpa a memória para que um
   * login feito com o Atelier aberto seja notado.
   */
  private async detectAccount(): Promise<boolean> {
    if (this.hasAccount === null) {
      this.hasAccount = await hasCodexAccount()
      if (!this.hasAccount) {
        this.stop()
        this.account = empty('none', false)
      }
    }
    return this.hasAccount
  }

  private stop(): void {
    this.rollout.stop()
    this.client?.close()
    this.client = null
  }

  /**
   * O disco como fonte CONTÍNUA. Não há relógio nenhum: quem avisa é a
   * escrita do próprio `codex`, no instante em que ele termina um turno.
   */
  private async startRollout(): Promise<void> {
    this.rollout.onReading = (reading) => {
      const merged = mergeCodexAccount(this.account, reading.account)
      this.account = {
        ...merged,
        limits: fromCodexRateLimits(reading.limits),
        at: reading.at,
        source: 'live',
        available: true
      }
      this.persistSoon()
      notifyRenderer('codex:account', this.account)
    }
    await this.rollout.start()
  }

  private async readAccount(): Promise<void> {
    if (!this.client) return
    try {
      const [account, limits, tokenUsage] = await Promise.all([
        // O App Server declara params como um objeto obrigatório até nas
        // leituras sem argumentos. Omiti-lo faz o serde rejeitar a chamada
        // inteira com `Invalid request: missing field params`.
        this.client.request('account/read', {}).catch(() => null),
        this.client.request('account/rateLimits/read', {}).catch(() => null),
        this.client.request('account/usage/read', {}).catch(() => null)
      ])
      const merged = mergeCodexAccount(
        mergeCodexAccount(mergeCodexAccount(this.account, account), limits),
        tokenUsage
      )
      this.account = {
        ...merged,
        limits: limits === null ? merged.limits : fromCodexRateLimits(limits),
        at: new Date().toISOString(),
        source: 'live',
        available: true
      }
      this.persistSoon()
      notifyRenderer('codex:account', this.account)
    } catch (err) {
      log.warn('codex', 'falha lendo conta Codex', err)
    }
  }

  private mergeAccount(payload: unknown): void {
    this.account = {
      ...mergeCodexAccount(this.account, payload),
      at: new Date().toISOString(),
      source: this.account.source === 'none' ? 'live' : this.account.source,
      available: true
    }
    this.persistSoon()
    notifyRenderer('codex:account', this.account)
  }

  private persistSoon(): void {
    if (this.account.source !== 'live') return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  private async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.account.source === 'none') return
    const entry: StoredCodexUsage = {
      limits: this.account.limits,
      planType: this.account.planType,
      credits: this.account.credits,
      individualLimit: this.account.individualLimit,
      spendControlReached: this.account.spendControlReached,
      rateLimitReachedType: this.account.rateLimitReachedType,
      tokenUsage: this.account.tokenUsage,
      at: this.account.at
    }
    await persistence.saveCodexUsage(entry)
  }
}

export const codexTelemetry = new CodexTelemetryService()
