import type { CodexAccountUsage, StoredCodexUsage } from '@shared/types'
import { fromCodexRateLimits, mergeCodexAccount } from '@shared/agent-usage'
import { notifyRenderer } from '../../ipc/notify'
import { log } from '../logger'
import { persistence } from '../persistence/persistence-manager'
import { CodexJsonRpcClient, spawnCodexAppServer } from './codex-protocol'

const SAVE_DEBOUNCE_MS = 5000

function empty(source: CodexAccountUsage['source'] = 'none'): CodexAccountUsage {
  return {
    authMode: null,
    planType: null,
    limits: [],
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    rateLimitReachedType: null,
    resetCreditsAvailable: null,
    at: new Date().toISOString(),
    source
  }
}

export class CodexTelemetryService {
  private refs = 0
  private client: CodexJsonRpcClient | null = null
  private account: CodexAccountUsage = empty()
  private saveTimer: NodeJS.Timeout | null = null

  get current(): CodexAccountUsage {
    return this.account
  }

  async loadStored(): Promise<void> {
    const stored = await persistence.loadCodexUsage()
    if (!stored) return
    this.account = {
      ...empty('stored'),
      planType: stored.planType,
      limits: stored.limits,
      credits: stored.credits,
      individualLimit: stored.individualLimit,
      spendControlReached: stored.spendControlReached,
      rateLimitReachedType: stored.rateLimitReachedType,
      at: stored.at
    }
  }

  async subscribe(): Promise<CodexAccountUsage> {
    this.refs += 1
    await this.ensureStarted()
    return this.account
  }

  async unsubscribe(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs === 0) this.stop()
  }

  async refreshAccount(): Promise<CodexAccountUsage> {
    await this.ensureStarted()
    if (!this.client) return this.account
    await this.readAccount()
    return this.account
  }

  async accountUsage(): Promise<unknown | null> {
    await this.ensureStarted()
    if (!this.client) return null
    try {
      return await this.client.request('account/usage/read')
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
    try {
      this.client = spawnCodexAppServer()
      this.client.on('notification', (method: string, params: unknown) => {
        if (method === 'account/rateLimits/updated') void this.readAccount()
        if (method === 'account/updated') this.mergeAccount(params)
      })
      await this.client.initialize({})
      await this.readAccount()
    } catch (err) {
      log.warn('codex', 'Codex App Server indisponivel', err)
      this.client?.close()
      this.client = null
      if (this.account.source !== 'stored') this.account = empty('none')
    }
  }

  private stop(): void {
    this.client?.close()
    this.client = null
  }

  private async readAccount(): Promise<void> {
    if (!this.client) return
    try {
      const [account, limits] = await Promise.all([
        this.client.request('account/read').catch(() => null),
        this.client.request('account/rateLimits/read').catch(() => null)
      ])
      this.account = {
        ...mergeCodexAccount(this.account, account),
        limits: fromCodexRateLimits(limits),
        at: new Date().toISOString(),
        source: 'live'
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
      source: this.account.source === 'none' ? 'live' : this.account.source
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
      at: this.account.at
    }
    await persistence.saveCodexUsage(entry)
  }
}

export const codexTelemetry = new CodexTelemetryService()
