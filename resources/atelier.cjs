#!/usr/bin/env node
/**
 * atelier — CLI inter-agentes do Atelier (porte de Sources/CLI/).
 *
 * Cliente puro de socket: zero dependências, para poder rodar dentro do PTY de
 * qualquer agente. O formato da requisição é o mesmo do app nativo — só o nome
 * do binário e as variáveis de ambiente mudaram:
 *
 *     POST /cli HTTP/1.0
 *     X-Terminal-ID: <UUID>
 *     Content-Type: application/json
 *
 *     {"args":["ask","Agent","prompt"]}
 *
 * Transporte: Unix socket (macOS/Linux) ou named pipe (Windows) — a API do
 * módulo `net` é a mesma, muda só o caminho.
 *
 * NOTA DE PORTE: no app nativo isto é um binário universal de ~279 KB. Aqui
 * roda sobre o runtime do Electron (ELECTRON_RUN_AS_NODE=1) via wrapper. Para
 * distribuição, o plano é reescrever em Go/Rust — ver docs/migracao-electron.md §6.
 */
'use strict'

const net = require('node:net')

const HELP = `atelier — Atelier inter-agent CLI

Usage: atelier <command> [args...]

Commands:
  list                              List connected agents, notes, portals
  ask "Agent" "prompt"              Send prompt to connected agent
  check "Agent" [lines]             View agent's recent output
  note <read|write|create>          Read/write connected notes
  debug                             Diagnose connection issues

Environment:
  ATELIER_SOCKET       Socket path / named pipe (set by Atelier)
  ATELIER_TERMINAL_ID  Terminal UUID (set by Atelier)
  ATELIER_CLI          Path to this CLI
`

function fail(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

const socketPath = process.env.ATELIER_SOCKET
const terminalId = process.env.ATELIER_TERMINAL_ID || process.env.ATELIER_TERMINAL_ID

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP)
  process.exit(command ? 0 : 1)
}

if (!socketPath) fail('only available inside Atelier terminals (ATELIER_SOCKET not set).')
if (!terminalId) fail('only available inside Atelier terminals (ATELIER_TERMINAL_ID not set).')

const body = Buffer.from(JSON.stringify({ args }), 'utf8')
const request =
  'POST /cli HTTP/1.0\r\n' +
  'Host: maestri\r\n' +
  `X-Terminal-ID: ${terminalId}\r\n` +
  'Content-Type: application/json\r\n' +
  `Content-Length: ${body.length}\r\n` +
  '\r\n'

const socket = net.createConnection(socketPath)
// Sem timeout: comandos como `ask` bloqueiam legitimamente por minutos
socket.setTimeout(0)

const chunks = []

socket.on('connect', () => {
  socket.write(request)
  socket.write(body)
})

socket.on('data', (chunk) => chunks.push(chunk))

socket.on('error', (err) => {
  process.stderr.write(`error: connection failed: ${err.message}\n`)
  process.stderr.write('Is Atelier running? Try: atelier debug\n')
  process.exit(1)
})

socket.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8')
  const split = raw.indexOf('\r\n\r\n')
  const payload = split >= 0 ? raw.slice(split + 4) : raw
  process.stdout.write(payload.endsWith('\n') ? payload : `${payload}\n`)
  process.exit(0)
})
