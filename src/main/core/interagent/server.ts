/**
 * Porte de Sources/InterAgent/InterAgentServer.swift.
 *
 * Dois canais, uma rota só (`POST /cli`):
 *   • Unix socket em <dataDir>/run/agent.sock  (macOS/Linux)
 *     named pipe \\.\pipe\atelier               (Windows)
 *   • TCP em 127.0.0.1, porta dinâmica — nunca exposto para fora
 *
 * O parser HTTP é manual e mínimo de propósito: o cliente é sempre o nosso CLI,
 * e é o mesmo formato HTTP/1.0 que o app nativo fala. Não é um servidor web.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { ipcSocketPath, paths } from '../persistence/paths'
import { Constants } from '../constants'
import { routeCLI } from './cli-router'

const MAX_BODY = 1024 * 1024 // 1 MB, igual ao app nativo (comandos portal grandes)

interface ParsedRequest {
  path: string
  terminalId: UUID | null
  body: string
}

function parseHTTPRequest(raw: string): ParsedRequest | null {
  const split = raw.indexOf('\r\n\r\n')
  if (split < 0) return null

  const head = raw.slice(0, split)
  const body = raw.slice(split + 4)
  const lines = head.split('\r\n')
  const requestLine = lines[0] ?? ''
  const path = requestLine.split(' ')[1] ?? '/'

  let terminalId: UUID | null = null
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const name = line.slice(0, idx).trim().toLowerCase()
    if (name === 'x-terminal-id') terminalId = line.slice(idx + 1).trim().toUpperCase()
  }
  return { path, terminalId, body }
}

function contentLengthOf(raw: string): number | null {
  const match = /content-length:\s*(\d+)/i.exec(raw)
  return match ? Number(match[1]) : null
}

function httpResponse(text: string, status = 200): string {
  const body = Buffer.from(text, 'utf8')
  return (
    `HTTP/1.0 ${status} ${status === 200 ? 'OK' : 'Bad Request'}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    text
  )
}

class InterAgentServer {
  port = 0
  private unixServer: net.Server | null = null
  private tcpServer: net.Server | null = null

  private handleConnection(socket: net.Socket): void {
    let raw = ''
    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > MAX_BODY) {
        socket.end(httpResponse('error: request too large', 400))
        return
      }

      const headEnd = raw.indexOf('\r\n\r\n')
      if (headEnd < 0) return // headers incompletos

      const expected = contentLengthOf(raw.slice(0, headEnd))
      const received = Buffer.byteLength(raw.slice(headEnd + 4), 'utf8')
      if (expected !== null && received < expected) return // body ainda chegando

      void this.dispatch(raw, socket)
    })

    socket.on('error', (err) => log.debug('ipc', `socket error: ${err.message}`))
  }

  private async dispatch(raw: string, socket: net.Socket): Promise<void> {
    const parsed = parseHTTPRequest(raw)
    if (!parsed) {
      socket.end(httpResponse('error: malformed request', 400))
      return
    }
    if (parsed.path !== '/cli') {
      socket.end(httpResponse('error: unknown route', 400))
      return
    }

    let args: string[] = []
    try {
      const json = JSON.parse(parsed.body) as { args?: unknown }
      if (Array.isArray(json.args)) args = json.args.map(String)
    } catch {
      socket.end(httpResponse('error: invalid JSON body', 400))
      return
    }

    log.debug('ipc', `cli ${args.join(' ')} (tid=${parsed.terminalId?.slice(0, 8) ?? 'none'})`)

    try {
      const output = await routeCLI(args, parsed.terminalId)
      socket.end(httpResponse(output))
    } catch (err) {
      log.error('ipc', 'handler lançou exceção', err)
      socket.end(httpResponse(`error: ${(err as Error).message}`))
    }
  }

  async start(): Promise<void> {
    await mkdir(paths.runDir(), { recursive: true })

    // Socket órfão de um crash anterior impede o bind
    const sockPath = ipcSocketPath()
    if (process.platform !== 'win32' && existsSync(sockPath)) {
      try {
        unlinkSync(sockPath)
      } catch (err) {
        log.warn('ipc', `não foi possível remover socket antigo: ${(err as Error).message}`)
      }
    }

    this.unixServer = net.createServer((s) => this.handleConnection(s))
    await new Promise<void>((resolve, reject) => {
      this.unixServer!.once('error', reject)
      this.unixServer!.listen(sockPath, () => resolve())
    })
    log.info('ipc', `socket em ${sockPath}`)

    this.tcpServer = net.createServer((s) => this.handleConnection(s))
    await new Promise<void>((resolve, reject) => {
      this.tcpServer!.once('error', reject)
      this.tcpServer!.listen(0, Constants.interAgentServerHost, () => {
        const addr = this.tcpServer!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
    log.info('ipc', `TCP em ${Constants.interAgentServerHost}:${this.port}`)
  }

  stop(): void {
    this.unixServer?.close()
    this.tcpServer?.close()
    this.unixServer = null
    this.tcpServer = null
    if (process.platform !== 'win32') {
      try {
        unlinkSync(ipcSocketPath())
      } catch {
        /* já removido */
      }
    }
    this.port = 0
  }
}

export const interAgentServer = new InterAgentServer()
