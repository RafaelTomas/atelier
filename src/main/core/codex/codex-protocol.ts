import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { childEnv } from '../subprocess-env'

export interface JsonRpcProcess {
  stdin: Writable
  stdout: Readable
  stderr?: Readable
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export interface CodexJsonRpcClientOptions {
  requestTimeoutMs?: number
  onNotification?: (method: string, params: unknown) => void
  onStderr?: (line: string) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class CodexJsonRpcClient extends EventEmitter {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false
  private timeoutMs: number

  constructor(
    private readonly child: JsonRpcProcess,
    private readonly options: CodexJsonRpcClientOptions = {}
  ) {
    super()
    this.timeoutMs = options.requestTimeoutMs ?? 5000

    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => {
        options.onStderr?.(sanitizeStderr(line))
      })
    }
    child.on('exit', () => this.failAll(new Error('Codex App Server exited')))
    child.on('error', (err) => this.failAll(err))
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex App Server is closed'))
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server request timed out: ${method}`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const message = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  initialize(params: unknown = codexInitializeParams()): Promise<unknown> {
    return this.request('initialize', params)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('Codex App Server closed'))
    this.child.kill()
  }

  private receive(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.emit('protocol-error', new Error('invalid JSON-RPC line'))
      return
    }
    if (!msg || typeof msg !== 'object') return
    const data = msg as Record<string, unknown>
    if (typeof data.method === 'string' && data.id === undefined) {
      this.options.onNotification?.(data.method, data.params)
      this.emit('notification', data.method, data.params)
      return
    }
    if (typeof data.id !== 'number') return
    const pending = this.pending.get(data.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(data.id)
    if (data.error) {
      pending.reject(new Error(rpcErrorMessage(data.error)))
    } else {
      pending.resolve(data.result)
    }
  }

  private failAll(err: Error): void {
    if (this.closed && this.pending.size === 0) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}

export function codexInitializeParams(): unknown {
  return {
    clientInfo: {
      name: 'atelier',
      title: 'Atelier',
      version: '0.0.0'
    },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false
    }
  }
}

/**
 * Como chamar o `codex` do PATH em cada plataforma.
 *
 * No Windows o `codex` do npm sao dois arquivos: um script sh sem extensao e um
 * `codex.cmd`. O `spawn` sem shell nao roda nenhum dos dois — o primeiro da
 * `ENOENT` (o CreateProcess nao executa script sem extensao) e o segundo da
 * `EINVAL`, porque o Node passou a recusar `.bat`/`.cmd` fora do shell desde a
 * correcao do CVE-2024-27980. Era por aqui que o App Server morria calado no
 * Windows: o spawn falhava, o servico caia no `catch` e a conta Codex ficava
 * eternamente em `source: 'none'` — nenhum limite, nenhum token na tela.
 *
 * A saida e o proprio `cmd.exe`, que resolve o `.cmd` do PATH. Os argumentos
 * sao literais fixos, entao nao ha nada vindo do usuario para escapar aqui.
 */
export function codexAppServerCommand(
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  const args = ['app-server', '--stdio']
  if (platform !== 'win32') return { command: 'codex', args }
  return {
    command: process.env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', 'codex', ...args]
  }
}

export function spawnCodexAppServer(): CodexJsonRpcClient {
  const { command, args } = codexAppServerCommand()
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(),
    windowsHide: true
  })
  return new CodexJsonRpcClient(child)
}

export function sanitizeStderr(line: string): string {
  return line.replace(/("?(access|refresh|id)?_?token"?\s*[:=]\s*)("[^"]+"|\S+)/gi, '$1[redacted]')
}

function rpcErrorMessage(error: unknown): string {
  const obj = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  return typeof obj.message === 'string' ? obj.message : 'Codex App Server request failed'
}
