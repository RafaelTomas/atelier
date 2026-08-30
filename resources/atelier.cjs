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
  vault <list|get|env>              Secrets from connected vaults (never writes)
  role [list]                       Your assigned responsibility
  projects <list|info|describe>     The user's indexed projects
  debug                             Diagnose connection issues

Environment:
  ATELIER_SOCKET       Socket path / named pipe (set by Atelier)
  ATELIER_TERMINAL_ID  Terminal UUID (set by Atelier)
  ATELIER_CLI          Path to this CLI
  ATELIER_ROLE         Name of the assigned responsibility, when there is one
`

function fail(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

const socketPath = process.env.ATELIER_SOCKET
const terminalId = process.env.ATELIER_TERMINAL_ID

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP)
  process.exit(command ? 0 : 1)
}

if (!socketPath) fail('only available inside Atelier terminals (ATELIER_SOCKET not set).')
if (!terminalId) fail('only available inside Atelier terminals (ATELIER_TERMINAL_ID not set).')

/** Cabeçalho da requisição — o mesmo para todos os comandos. */
function head(length) {
  return (
    'POST /cli HTTP/1.0\r\n' +
    'Host: maestri\r\n' +
    `X-Terminal-ID: ${terminalId}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${length}\r\n` +
    '\r\n'
  )
}

/** O corpo da resposta HTTP, sem os cabeçalhos. */
function bodyOf(chunks) {
  const raw = Buffer.concat(chunks).toString('utf8')
  const split = raw.indexOf('\r\n\r\n')
  return split >= 0 ? raw.slice(split + 4) : raw
}

// ─── statusline ───────────────────────────────────────────────────────────────

/**
 * `atelier statusline` — o único comando que NÃO é digitado por um agente.
 *
 * Quem o chama é o Claude Code, a cada mensagem nova, por causa do `statusLine`
 * que o Atelier instalou no `--settings` deste terminal. O payload da sessão
 * (modelo, tokens, tamanho da janela de contexto, custo, limites de uso) chega
 * no STDIN, e não em argv — por isso este é o único caminho que lê stdin antes
 * de falar com o socket.
 *
 * Duas regras, e as duas existem porque isto é a BARRA DE STATUS do usuário:
 *
 *  - o stdin é lido INTEIRO antes do envio. Um JSON de alguns KB chega partido
 *    em vários chunks, e mandar só o primeiro produziria um parse inválido a
 *    cada mensagem — em silêncio, porque o handler responde vazio nesse caso.
 *  - falha nossa nunca apaga a barra. Atelier fechado, socket mudo, timeout: o
 *    comando ainda executa a statusLine ORIGINAL do usuário
 *    (`ATELIER_STATUSLINE_INNER`) e imprime a saída dela. Sem ela configurada,
 *    imprime a linha que o Atelier montou; sem nada, não imprime nada, e o
 *    Claude Code mantém a última linha boa.
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    // O Claude Code sempre entrega o JSON, mas um stdin não conectado (teste na
    // mão, shell incomum) travaria este processo para sempre.
    setTimeout(finish, 2000).unref()
  })
}

/**
 * Executa a statusLine que o usuário já tinha e deixa a saída dela passar, com
 * o MESMO payload no stdin.
 *
 * Instalar a nossa APAGA a dele — a chave `statusLine` é uma só. Isto a
 * devolve: quem montou uma barra própria continua vendo exatamente aquela barra
 * dentro do Atelier.
 */
function runInner(payload, fallback) {
  const inner = process.env.ATELIER_STATUSLINE_INNER
  if (!inner) {
    if (fallback) process.stdout.write(`${fallback}\n`)
    process.exit(0)
    return
  }
  const { spawn } = require('node:child_process')
  const child = spawn(inner, { shell: true, stdio: ['pipe', 'inherit', 'ignore'] })
  child.on('error', () => process.exit(0))
  child.on('close', () => process.exit(0))
  child.stdin.on('error', () => undefined)
  child.stdin.end(payload)
}

function sendStatusLine(payload) {
  const body = Buffer.from(JSON.stringify({ args: ['statusline', payload] }), 'utf8')
  const socket = net.createConnection(socketPath)
  // COM timeout, ao contrário dos outros comandos: este roda a cada mensagem do
  // agente, e um socket pendurado deixaria um processo por mensagem na máquina.
  socket.setTimeout(5000)

  const chunks = []
  let answered = false
  const answer = (text) => {
    if (answered) return
    answered = true
    runInner(payload, text.trim())
  }

  socket.on('connect', () => {
    socket.write(head(body.length))
    socket.write(body)
  })
  socket.on('data', (chunk) => chunks.push(chunk))
  socket.on('timeout', () => socket.destroy())
  socket.on('error', () => answer(''))
  socket.on('close', () => answer(bodyOf(chunks)))
}

// ─── Todos os outros comandos ─────────────────────────────────────────────────

function sendCommand(argv) {
  const body = Buffer.from(JSON.stringify({ args: argv }), 'utf8')
  const socket = net.createConnection(socketPath)
  // Sem timeout: comandos como `ask` bloqueiam legitimamente por minutos
  socket.setTimeout(0)

  const chunks = []

  socket.on('connect', () => {
    socket.write(head(body.length))
    socket.write(body)
  })

  socket.on('data', (chunk) => chunks.push(chunk))

  socket.on('error', (err) => {
    process.stderr.write(`error: connection failed: ${err.message}\n`)
    process.stderr.write('Is Atelier running? Try: atelier debug\n')
    process.exit(1)
  })

  socket.on('end', () => {
    const payload = bodyOf(chunks)
    process.stdout.write(payload.endsWith('\n') ? payload : `${payload}\n`)
    process.exit(0)
  })
}

if (command === 'statusline') {
  readStdin()
    .then(sendStatusLine)
    .catch(() => process.exit(0))
} else {
  sendCommand(args)
}
