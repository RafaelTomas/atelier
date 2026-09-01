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
  recruit "Name" [options]          Create a new connected agent node
  dismiss "Name"                    Close a connected agent
  note <read|write|edit|create>     Read/write/edit connected notes
  portal <list|open|go|read|html|shot|close|map|click|type|key|scroll|wait|login>
                                    Navigate and control web pages (read-only without user approval)
  editor <list|open|read|close>     View user's open file and selection (no write; edit with your own tools)
  table <create|append|list>        Publish query results as table nodes (you run the query)
  image <create|list>               Publish image files as nodes on the canvas
  todo <list|add|move|done|show|create|plan|step>
                                    Manage todo board items and plans
  vault <list|get|set|env>          Secrets from connected vaults (set creates only, never overwrites)
                                    env --export loads them into your shell without printing:
                                    eval "$(atelier vault env --export)"
  button <propose|list|remove>      Propose buttons (pending until user accepts); remove only your pending ones
  role [list]                       Your assigned responsibility
  projects <list|info|describe>     The user's indexed projects
  debug                             Diagnose connection issues

Environment:
  ATELIER_SOCKET       Socket path / named pipe (set by Atelier)
  ATELIER_TERMINAL_ID  Terminal UUID (set by Atelier)
  ATELIER_CLI          Path to this CLI
  ATELIER_ROLE         Name of the assigned responsibility, when there is one
  ATELIER_ARTESAO      Indicates terminal is an Artisan (when set)
`

function fail(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

// ─── artesao ──────────────────────────────────────────────────────────────────

/**
 * A recusa do Artesão, e o ÚNICO texto de Artesão que mora no CLI.
 *
 * Ele responde por dois hooks: é a razão do `deny` no `PreToolUse` do `Task`, e
 * é o que o `SessionStart` injeta quando o app não responde. A doutrina completa
 * — com quem está no canvas e quantas vagas sobram — vive no main, em
 * `interagent/artisan-doctrine.ts`, porque precisa do canvas para existir. Este
 * texto vive aqui porque precisa do OPOSTO: funcionar com o Atelier mudo.
 *
 * Um bloqueio que depende de o app responder não é bloqueio. Se o socket cair,
 * um Artesão tem que continuar Artesão — daí `guard` nunca abrir conexão.
 */
const ARTISAN_REFUSAL = `This terminal is an Artisan: internal subagents are turned off here.

A subagent is invisible on the canvas. It has no node, so the user cannot watch
it, interrupt it, or read what it cost; it borrows YOUR identity on the atelier
CLI; it burns YOUR context window; and it dies with your session.

Open a node instead:

  atelier list                                  reuse before you recruit
  atelier recruit "Name" --model haiku|sonnet   a node, already cabled to you
  atelier ask "Name" "the task"                 hand it over, wait for the answer
  atelier check "Name" 40                       read its screen, do not re-ask
  atelier dismiss "Name"                        close it when the work is done

Write the task as if the recruit could not see your context — it cannot.`

/** A resposta do hook `PreToolUse` que nega o `Task` e diz o caminho certo. */
function artisanGuardResponse() {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: ARTISAN_REFUSAL
    }
  })
}

/** A resposta do hook `SessionStart` que acrescenta a doutrina ao contexto. */
function artisanBriefResponse(text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text }
  })
}

const socketPath = process.env.ATELIER_SOCKET
const terminalId = process.env.ATELIER_TERMINAL_ID

const args = process.argv.slice(2)
const command = args[0]

/** Cabeçalho da requisição — o mesmo para todos os comandos. */
function head(length) {
  return (
    'POST /cli HTTP/1.0\r\n' +
    'Host: atelier\r\n' +
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

/**
 * Os desfechos que viram código de saída, e o par literal deles no app.
 *
 * O protocolo do socket carrega TEXTO. Alargá-lo para um campo de status
 * obrigaria a reinstalar este CLI no PATH de todo mundo a cada mudança, então o
 * desfecho viaja como a ÚLTIMA LINHA da resposta, num formato que ninguém
 * escreve por acaso.
 *
 * O par vive em src/main/core/interagent/handlers/ask.ts, e scripts/test-ask.mjs
 * falha se as duas cópias se separarem: um CLI que deixe de reconhecer a linha
 * volta a sair com 0 em silêncio — o defeito exato que isto conserta.
 *
 * Os códigos: 2 = ainda trabalhando, 3 = parado pedindo algo ao usuário. Ambos
 * diferentes de 0, porque nos dois casos NÃO há resposta para ler.
 */
const OUTCOMES = [
  { line: '[atelier: timed out — agent still working]', code: 2 },
  { line: '[atelier: agent stopped and is asking the user]', code: 3 }
]

/** O código que a resposta pede, ou 0 quando ela é uma resposta de verdade. */
function exitCodeFor(payload) {
  const last = payload.trimEnd().split('\n').pop() || ''
  const hit = OUTCOMES.find((o) => last === o.line)
  return hit ? hit.code : 0
}

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
    process.exit(exitCodeFor(payload))
  })
}

// ─── artesao brief ────────────────────────────────────────────────────────────

/**
 * O hook `SessionStart` de um Artesão. Pergunta a doutrina ao app — é ela que
 * sabe quem está no canvas — e cai no texto local se o app não responder.
 *
 * O payload do stdin é lido e descartado: o `SessionStart` entrega um JSON de
 * sessão, e a doutrina não depende de nada dele. Ler mesmo assim evita deixar o
 * hook escrevendo num pipe que ninguém drena.
 */
function sendArtisanBrief() {
  const body = Buffer.from(JSON.stringify({ args: ['artesao', 'brief'] }), 'utf8')
  const socket = net.createConnection(socketPath)
  // COM timeout, como a statusline: isto roda no boot de cada sessão, e um
  // socket pendurado seguraria a abertura do agente.
  socket.setTimeout(5000)

  const chunks = []
  let answered = false
  const answer = (text) => {
    if (answered) return
    answered = true
    const doctrine = text.trim()
    // Resposta vazia, erro, timeout ou um `error:` do roteador: vale o texto
    // local. Um Artesão sem doutrina nenhuma é o pior desfecho deste hook.
    const useful = doctrine && !doctrine.startsWith('error:') ? doctrine : ARTISAN_REFUSAL
    process.stdout.write(`${artisanBriefResponse(useful)}\n`)
    process.exit(0)
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

// ─── brief ────────────────────────────────────────────────────────────────────

/**
 * O hook `SessionStart` de TODO nó Claude Code, não só o Artesão — a resposta
 * de `atelier brief` (o inventário do canvas, com a doutrina do Artesão como
 * bloco quando o chamador é um; ver interagent/handlers/brief.ts) embrulhada
 * no MESMO formato de hook do `artesao brief`, via `artisanBriefResponse` —
 * a função só precisa do texto e do nome do evento, e os dois são idênticos.
 *
 * Sem doutrina de fallback aqui: ao contrário do Artesão, um nó comum sem
 * resposta do app não perde uma trava de ferramenta, só o atalho — melhor
 * nenhum contexto extra do que um hook gritando `error:` para dentro da
 * primeira mensagem da sessão.
 */
function sendBrief() {
  const body = Buffer.from(JSON.stringify({ args: ['brief'] }), 'utf8')
  const socket = net.createConnection(socketPath)
  // COM timeout, como a statusline e o artesao brief: roda no boot de cada
  // sessão, e um socket pendurado seguraria a abertura do agente.
  socket.setTimeout(5000)

  const chunks = []
  let answered = false
  const answer = (text) => {
    if (answered) return
    answered = true
    const brief = text.trim()
    if (brief && !brief.startsWith('error:')) {
      process.stdout.write(`${artisanBriefResponse(brief)}\n`)
    }
    process.exit(0)
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

// ─── waiting ──────────────────────────────────────────────────────────────────

/**
 * O hook `Notification` de todo nó Claude Code: o agente parou para pedir algo.
 *
 * Difere do `brief` e da `statusline` em três pontos, e os três vêm de quem
 * está do outro lado — alguém já parado, olhando uma tela congelada:
 *
 *  - NÃO imprime nada. `Notification` não injeta contexto, então tudo que
 *    saísse daqui só sujaria a tela de quem está esperando.
 *  - o payload do stdin vai INTEIRO para o app, que extrai o `message` de lá
 *    (interagent/handlers/waiting.ts). O CLI não interpreta JSON: se o formato
 *    do hook mudar, quem se adapta é o app, que dá para atualizar sem reinstalar
 *    o CLI no PATH do usuário.
 *  - timeout curto. Um socket pendurado aqui atrasaria o diálogo que o usuário
 *    está tentando responder, e o estado de espera é uma conveniência do
 *    coordenador — nunca vale segurar a tela de quem trabalha.
 */
function sendWaiting(payload) {
  const body = Buffer.from(JSON.stringify({ args: ['waiting', payload] }), 'utf8')
  const socket = net.createConnection(socketPath)
  socket.setTimeout(2000)
  const done = () => process.exit(0)
  socket.on('connect', () => {
    socket.write(head(body.length))
    socket.write(body)
  })
  socket.on('data', () => undefined)
  socket.on('timeout', () => socket.destroy())
  socket.on('error', done)
  socket.on('close', done)
}

/**
 * `vault env --export` imprime SEGREDO, e a decisão de recusar mora aqui.
 *
 * Ele existe para ser comido por um shell — `eval "$(atelier vault env
 * --export)"` — e nessa forma a saída é um cano. Quando a saída é a TELA, o
 * mesmo comando só serviria para despejar as senhas no scrollback do nó, onde o
 * agente as lê de volta e o usuário as vê.
 *
 * A guarda mora no CLI, e não no app, porque só aqui se sabe para onde a saída
 * vai: o app responde por um socket e não tem como saber se do outro lado há um
 * terminal.
 */
function refusesExportToTTY(command, argv, isTTY) {
  return command === 'vault' && argv.includes('--export') && Boolean(isTTY)
}

// ─── Despacho ─────────────────────────────────────────────────────────────────

function main() {
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP)
    process.exit(command ? 0 : 1)
  }

  // ANTES das guardas de ambiente, e de propósito: a recusa do Artesão não fala
  // com o app, então ela também não precisa do socket para funcionar.
  if (command === 'artesao' && args[1] === 'guard') {
    readStdin()
      .then(() => {
        process.stdout.write(`${artisanGuardResponse()}\n`)
        process.exit(0)
      })
      .catch(() => {
        process.stdout.write(`${artisanGuardResponse()}\n`)
        process.exit(0)
      })
    return
  }

  if (!socketPath) fail('only available inside Atelier terminals (ATELIER_SOCKET not set).')
  if (!terminalId) fail('only available inside Atelier terminals (ATELIER_TERMINAL_ID not set).')

  if (command === 'statusline') {
    readStdin()
      .then(sendStatusLine)
      .catch(() => process.exit(0))
    return
  }

  if (command === 'artesao' && args[1] === 'brief') {
    readStdin()
      .then(sendArtisanBrief)
      .catch(() => process.exit(0))
    return
  }

  if (command === 'brief') {
    readStdin()
      .then(sendBrief)
      .catch(() => process.exit(0))
    return
  }

  if (command === 'waiting') {
    readStdin()
      .then(sendWaiting)
      .catch(() => process.exit(0))
    return
  }

  // `vault env --export` imprime SEGREDO. Ele existe para ser comido por um
  // shell — `eval "$(atelier vault env --export)"` —, e nessa forma a saída é um
  // cano, não a tela. Quando a saída É a tela, o mesmo comando só serviria para
  // despejar as senhas no scrollback do nó, onde o agente as lê de volta e o
  // usuário as vê. Então ali ele não roda.
  //
  // A guarda mora no CLI porque só aqui se sabe para onde a saída vai: o app
  // responde por um socket e não tem como saber se do outro lado há um terminal.
  if (refusesExportToTTY(command, args, process.stdout.isTTY)) {
    process.stderr.write(
      'error: refusing to print secrets to a terminal.\n' +
        'This prints export lines meant to be loaded, never read. Use:\n' +
        '  eval "$(atelier vault env --export)"\n'
    )
    process.exit(1)
  }

  sendCommand(args)
}

// `require.main !== module` é o teste requerendo este arquivo para olhar os
// textos do Artesão sem subir socket nenhum. Executado como programa, nada muda.
if (require.main === module) {
  main()
} else {
  module.exports = {
    ARTISAN_REFUSAL,
    artisanGuardResponse,
    artisanBriefResponse,
    OUTCOMES,
    exitCodeFor,
    refusesExportToTTY
  }
}
