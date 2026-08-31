#!/usr/bin/env node
/**
 * demo-agent — o "agente de IA" roteirizado da demo do Atelier.
 *
 * Num palco, um terminal rodando `claude` de verdade exige login e internet, e
 * é exatamente o que quebra na hora. Este script ocupa o lugar dele: roda dentro
 * do PTY de um nó terminal, imita o suficiente de um agente (banner, linha de
 * status, reação a prompt) e executa uma sequência FIXA de comandos `atelier`.
 * Sem rede, sem credencial, sem custo — ver o plano em
 * docs/2026-08-30-PLANO-workspace-de-demonstracao.md, seção 4.1.
 *
 * Como o Atelier conversa com ele:
 *  - o `atelier ask` de outro agente DIGITA um prompt no nosso stdin e depois
 *    bloqueia até nos ver "ocioso" — e ocioso, para o Atelier, é só "sem saída
 *    nova por ~2s" (terminal-manager.isIdle). Então o contrato aqui é simples:
 *    ao receber uma linha, produzir saída enquanto "trabalha" e depois calar a
 *    boca. O silêncio é o que devolve o controle a quem chamou.
 *  - a linha de status no banner (`31,3k tok · 3% · 5h:80% 7d:58%`) é o que o
 *    `scanAgentStatus` raspa para o rodapé do nó e o Monitor nascerem com
 *    número, mesmo antes do primeiro prompt (risco "Monitor sem dado de IA").
 *
 * Regra de ouro (tabela de riscos do plano): STATELESS POR PROMPT. Cada linha
 * recebida dispara o passo que casa com o CONTEÚDO dela, nunca um contador
 * interno. Reexecutar o mesmo prompt repete o mesmo passo — nada avança.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// ─── Papel ───────────────────────────────────────────────────────────────────
//
// `--script artesao|implementa|revisa`. Aceita também a forma `--script=x`.

function readScript(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--script') return argv[i + 1]
    if (argv[i]?.startsWith('--script=')) return argv[i].slice('--script='.length)
  }
  return undefined
}

const raw = readScript(process.argv.slice(2)) ?? 'implementa'
const SCRIPT = raw
if (!['artesao', 'implementa', 'revisa'].includes(SCRIPT)) {
  process.stderr.write(`demo-agent: roteiro desconhecido '${raw}' (use artesao|implementa|revisa)\n`)
  process.exit(2)
}

// ─── Nomes do canvas ─────────────────────────────────────────────────────────
//
// Batem com o inventário da seção 2 do plano. Ficam aqui num lugar só para o
// roteiro e o gerador do workspace não divergirem na unha.

const NODES = {
  spec: 'Spec — busca',
  board: 'Sprint da busca',
  card: 'Implementar `search()`',
  vault: 'Credenciais',
  secret: 'DEMO_API_KEY',
  docs: 'Docs — demo-repo',
  docsUrl: 'http://localhost:4173',
  claude: 'Claude',
  codex: 'Codex'
}

// ─── Saída com cara de TUI ───────────────────────────────────────────────────

const out = (s = '') => process.stdout.write(`${s}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A linha de status. O formato é o que `agent-status.ts` sabe raspar:
 * `<n>k tok · <ctx>% · 5h:<n>% 7d:<n>%`. Os números são cosméticos mas
 * DETERMINÍSTICOS no conteúdo do prompt — reexecutar o mesmo prompt mostra o
 * mesmo número, coerente com o "stateless por prompt".
 */
function statusLine(seed = 0) {
  const tok = (31.3 + (seed % 40) / 10).toFixed(1).replace('.', ',')
  const ctx = 3 + (seed % 7)
  return `${tok}k tok · ${ctx}% · 5h:80% 7d:58%`
}

function banner() {
  const titulo = {
    artesao: 'roteiro: artesão — o apresentador, que delega',
    implementa: 'roteiro: implementa — lê a spec, move o cartão, revisa via Codex',
    revisa: 'roteiro: revisa — devolve uma revisão curta em bullets'
  }[SCRIPT]
  out()
  out('  [1m✻ demo-agent[0m  ·  agente roteirizado da demo (offline)')
  out(`  ${titulo}`)
  out('  sem rede · sem credencial · comandos reais via $ATELIER_CLI')
  out()
  out(`  ${statusLine()}`)
  out()
  idle()
}

function idle() {
  out('[2m› ocioso — aguardando um prompt no PTY[0m')
}

// ─── O CLI `atelier` ─────────────────────────────────────────────────────────
//
// Sempre pelo binário em $ATELIER_CLI (o `PATH` do PTY não é confiável — mesmo
// motivo de cli-install.ts). Sem ele, o passo é PULADO com aviso claro e o
// laço segue: um roteiro de demo nunca pode travar o terminal.

const CLI = process.env.ATELIER_CLI

/**
 * Roda `<ATELIER_CLI> <args...>` (o binário é executável — um shim de shell,
 * hoje), ecoando a saída no nosso stdout para o canvas mostrar atividade.
 * Nunca lança: devolve `{ ok, text }`.
 *
 * O `ask` pode bloquear por dezenas de segundos (espera o outro agente ficar
 * ocioso) — é legítimo, e por isso não há timeout aqui. O `spawn` streamado
 * mantém a saída pingando enquanto isso.
 */
function atelier(args) {
  return new Promise((resolve) => {
    if (!CLI) {
      out(`  [33m⚠ $ATELIER_CLI não definido — pulei: atelier ${args.join(' ')}[0m`)
      return resolve({ ok: false, text: '' })
    }
    out(`  [2m$ atelier ${args.join(' ')}[0m`)
    const child = spawn(CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (d) => {
      text += d
      process.stdout.write(indent(d.toString()))
    })
    child.stderr.on('data', (d) => process.stdout.write(indent(d.toString())))
    child.on('error', (err) => {
      out(`  [33m⚠ atelier indisponível (${err.code || err.message}) — passo pulado[0m`)
      resolve({ ok: false, text: '' })
    })
    child.on('close', (code) => resolve({ ok: code === 0, text: text.trim() }))
  })
}

const indent = (s) =>
  s
    .split('\n')
    .map((l) => (l ? `    ${l}` : l))
    .join('\n')

// ─── "Trabalho" ──────────────────────────────────────────────────────────────
//
// Um atraso curto com duas ou três linhas de "pensando", só para o espectador
// ver o agente reagir. Curto de propósito: o `ask` de quem chamou tem timeout
// de 30s, e precisamos terminar e cair em silêncio bem antes disso.

async function pensando(...linhas) {
  for (const l of linhas) {
    await sleep(450)
    out(`  [2m· ${l}[0m`)
  }
  await sleep(300)
}

// ─── Reconhecimento do prompt ────────────────────────────────────────────────
//
// Por palavra-chave, no conteúdo — não por ordem de chegada. Um prompt que não
// casa com nada ganha uma resposta genérica e volta a ocioso (nunca trava).

const has = (t, ...ks) => ks.some((k) => t.includes(k))

async function handle(prompt) {
  const t = prompt.toLowerCase()
  out()
  out(`[1m▸[0m ${prompt}`)

  if (SCRIPT === 'revisa') return await roteiroRevisa(t)
  if (SCRIPT === 'artesao') return await roteiroArtesao(t)
  return await roteiroImplementa(t)
}

/**
 * implementa: o núcleo da demo. Lê a nota, move o cartão, abre e lê o portal,
 * toca o cofre SEM exibir o valor, e delega a revisão ao Codex. Cada bloco é
 * independente — reexecutar o prompt inteiro só repete tudo.
 */
async function roteiroImplementa(t) {
  if (!has(t, 'implement', 'busca', 'search', 'spec', 'search()')) {
    out('  (nada a fazer para este prompt neste roteiro)')
    return
  }

  await pensando('lendo a especificação da busca', 'planejando a implementação de search()')
  await atelier(['note', 'read', NODES.spec])

  await pensando('implementei search() em src/search.ts', 'movendo o cartão no kanban')
  await atelier(['todo', 'done', NODES.board, 'Implementar'])

  await pensando('conferindo a documentação servida localmente')
  await atelier(['portal', 'open', NODES.docsUrl, NODES.docs])
  await atelier(['portal', 'read', NODES.docs])

  await pensando('preciso da chave da API para o teste de integração')
  const v = await atelier(['vault', 'list', NODES.vault])
  // NUNCA `vault get`: o valor não pode aparecer na tela. `list` só mostra os
  // nomes das chaves — basta confirmar que a chave existe no cofre conectado.
  out(
    v.ok && v.text.includes(NODES.secret)
      ? `  ✓ ${NODES.secret} carregada do cofre (valor não exibido)`
      : `  · seguirei sem ${NODES.secret} (cofre indisponível)`
  )

  await pensando('terminei — pedindo revisão ao Codex')
  await atelier(['ask', NODES.codex, 'revisa o diff de src/search.ts'])

  out()
  out('  Pronto: search() implementada, cartão em Feito, revisão solicitada ao Codex.')
  out(`  ${statusLine(t.length)}`)
}

/**
 * revisa: sem CLI. Uma revisão curta em bullets, como um revisor devolveria.
 */
async function roteiroRevisa(t) {
  if (!has(t, 'revis', 'diff', 'review', 'search')) {
    out('  (sem diff para revisar neste prompt)')
    return
  }
  await pensando('lendo o diff de src/search.ts', 'conferindo contra a Spec — busca')
  out('  Revisão de src/search.ts:')
  out('   • search() cobre o caso base e o vazio; casa com a Spec.')
  out('   • falta normalizar acento/caixa antes de comparar os termos.')
  out('   • o retorno deveria ser estável (ordenar por relevância, depois alfabético).')
  out('   • teste feliz ok; adicionar um caso "termo não encontrado".')
  out('  Veredito: aprovar com os ajustes acima.')
  out(`  ${statusLine(t.length)}`)
}

/**
 * artesao: o apresentador. Lê a spec e delega a implementação à Claude —
 * depois o canvas mostra o trabalho acontecendo sozinho.
 */
async function roteiroArtesao(t) {
  if (!has(t, 'implement', 'busca', 'search', 'spec', 'delega', 'delegue')) {
    out('  (o artesão só delega — nada a fazer para este prompt)')
    return
  }
  await pensando('lendo a Spec — busca antes de delegar')
  await atelier(['note', 'read', NODES.spec])
  await pensando('passando a bola para a Claude')
  await atelier([
    'ask',
    NODES.claude,
    'Leia a Spec — busca e implemente search() em src/search.ts; quando terminar, peça revisão ao Codex.'
  ])
  out()
  out('  Deleguei à Claude. Acompanhe o kanban e o editor.')
  out(`  ${statusLine(t.length)}`)
}

// ─── Laço principal ──────────────────────────────────────────────────────────
//
// Lê o stdin linha a linha, para sempre. Uma linha em branco é ignorada (o
// `ask` manda o texto e o Enter separados). Depois de cada prompt, volta a
// ocioso — é o silêncio subsequente que o Atelier lê como "terminou".

banner()

let ocupado = Promise.resolve()
const rl = createInterface({ input: process.stdin })

rl.on('line', (linha) => {
  const prompt = linha.trim()
  if (!prompt) return
  // Serializa: um prompt de cada vez, na ordem de chegada.
  ocupado = ocupado
    .then(() => handle(prompt))
    .catch((err) => out(`  [31m✗ erro no roteiro: ${err.message}[0m`))
    .then(() => {
      out()
      idle()
    })
})

// stdin fechou: num terminal de verdade isso não acontece, mas alimentado por
// um pipe (teste) sim. Espera o prompt em curso terminar antes de sair.
rl.on('close', () => {
  void ocupado.then(() => process.exit(0))
})
