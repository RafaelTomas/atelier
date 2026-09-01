/**
 * Linha de status do agente, raspada da tela.
 *
 * Não existe API para nada disto: o Claude Code (e outros CLIs) imprimem uma
 * linha como `31,3k tok · 3% · 5h:80% 7d:58%`, e é dela que saem os quatro
 * números que o rodapé do nó mostra — tokens da sessão, contexto usado e as
 * janelas de limite de uso. Lemos o mesmo texto que o usuário lê, então o
 * significado de cada número é o que o agente dá a ele.
 *
 * Módulo puro, sem electron e sem node-pty: roda no smoke headless.
 */
import type { AgentStatus } from '@shared/types'

/**
 * Sequências ANSI: CSI (cor, cursor), OSC (título da janela, terminada por BEL
 * ou ST) e os escapes de dois caracteres. A linha de status é redesenhada com
 * todos eles no meio, então some com tudo antes de procurar.
 */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Contador de tokens: `218.0k tok`, `31,3k tokens`, `tokens used: 12,345`. */
const TOKEN_PATTERNS = [
  /([\d][\d.,]*)\s*([kKmM])\s*tok(?:ens)?\b/g,
  /\btok(?:ens)?\s*(?:used|usados|usage)?\s*[:=]\s*([\d][\d.,]*)\s*([kKmM])?/gi,
  /\b([\d][\d.,]*)\s*tok(?:ens)?\b/g
]

/** Contexto usado: o `3%` que vem logo depois do contador de tokens. */
const CONTEXT = /tok(?:ens)?\b[^\d%]{0,8}(\d{1,3})\s*%/gi

/** Janelas de limite: `5h:80%`, `7d:58%`. */
const LIMIT = /\b(\d{1,3}\s*[hdw])\s*:\s*(\d{1,3})\s*%/gi

/**
 * "31,3k" → 31300, "12,345" → 12345, "1.234" → 1234.
 *
 * Com sufixo k/M o separador é sempre decimal — ninguém escreve milhar antes
 * de um `k`. Sem sufixo, grupos de exatamente três dígitos são milhar; o resto
 * é decimal. É o que faz `31,3k` (pt-BR) e `12,345` (en-US) conviverem.
 */
function toCount(raw: string, suffix?: string): number | null {
  const seps = raw.match(/[.,]/g) ?? []
  let normalized = raw

  if (seps.length > 1) {
    // Os dois separadores presentes: o último é o decimal.
    const decimal = raw.lastIndexOf(seps[seps.length - 1] === ',' ? ',' : '.')
    normalized = raw.slice(0, decimal).replace(/[.,]/g, '') + '.' + raw.slice(decimal + 1)
  } else if (seps.length === 1) {
    const sep = seps[0]
    const thousands = !suffix && new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(raw)
    normalized = thousands ? raw.replace(/[.,]/g, '') : raw.replace(/,/, '.')
  }

  const n = Number.parseFloat(normalized)
  if (!Number.isFinite(n)) return null
  const s = suffix?.toLowerCase()
  return Math.round(n * (s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1))
}

/** Última ocorrência de um padrão — a linha de status é reescrita a cada vez. */
function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null
  for (const m of text.matchAll(pattern)) last = m
  return last
}

/**
 * O que dá para ler da tela agora. Campo que o agente não mostra volta null (ou
 * lista vazia): terminal de shell puro não vira contador inventado.
 */
export function scanAgentStatus(chunk: string): AgentStatus {
  const text = stripAnsi(chunk)

  let tokens: number | null = null
  for (const pattern of TOKEN_PATTERNS) {
    const m = lastMatch(text, pattern)
    if (m) {
      tokens = toCount(m[1], m[2])
      if (tokens !== null) break
    }
  }

  const ctx = lastMatch(text, CONTEXT)
  const contextPct = ctx ? Number.parseInt(ctx[1], 10) : null

  // As janelas vêm juntas na mesma linha: pega o último bloco, não a última
  // janela — senão `5h:80% 7d:58%` perderia o 5h.
  const limits: AgentStatus['limits'] = []
  const seen = new Set<string>()
  const all = [...text.matchAll(LIMIT)].reverse()
  for (const m of all) {
    const window = m[1].replace(/\s+/g, '').toLowerCase()
    if (seen.has(window)) continue
    seen.add(window)
    limits.unshift({ window, pct: Number.parseInt(m[2], 10) })
  }

  return { tokens, contextPct, limits }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Detecção de espera — o PISO de M7b.
 *
 * O canal autoritativo é o hook `Notification` (terminal/agent-settings.ts):
 * ele chega estruturado, traz a mensagem, e existe porque o Claude Code o
 * publica de propósito. Isto aqui é o que sobra para os presets que NÃO têm
 * hook nenhum — Codex, opencode, antigravity, shell — e para o intervalo entre
 * o diálogo aparecer na tela e o hook ser processado.
 *
 * Piso, e não canal principal, por dois defeitos que a raspagem não resolve:
 *
 *   • `atelier check` devolve SCROLLBACK. Um diálogo já respondido continua no
 *     buffer e continua casando. Por isso tudo aqui olha só a CAUDA — se a
 *     conversa andou, o diálogo saiu da janela e o casamento morre junto.
 *   • o TUI COME OS ESPAÇOS ao redesenhar. Na tela real capturada em
 *     scripts/fixtures/waiting-claude-permission.txt o texto saiu como
 *     `Doyouwanttoproceed` e `requiresapproval` — um padrão escrito com as
 *     frases inteiras não casa NUNCA. A saída é comparar sem whitespace
 *     nenhum, o mesmo truque que `afterLastEcho` (handlers/ask.ts) usa para
 *     achar o eco de um prompt refluído.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Por que o agente parou. `detail` é o que dá para dizer sobre o pedido, e é
 * `null` com frequência: a tela chega com os espaços comidos, e um rótulo
 * adivinhado é pior que rótulo nenhum. Quem preenche `detail` de verdade é o
 * hook, que recebe a mensagem intacta.
 */
export interface WaitingReason {
  /**
   * `permission` é o diálogo de autorização; `question` é o agente perguntando
   * algo ao usuário numa lista de opções. Os dois param o agente do mesmo jeito
   * — e é por isso que os dois são `waiting` — mas quem lê o canvas precisa
   * saber qual, porque só um deles é sobre o que o agente ia FAZER.
   */
  kind: 'permission' | 'question'
  detail: string | null
}

/**
 * Quantas linhas do fim contam como "a tela agora".
 *
 * O diálogo do Claude Code ocupa ~8 linhas e fica coladinho no rodapé. 40 dá
 * folga para o redesenho parcial espalhar o bloco sem alcançar o diálogo
 * ANTERIOR, que é justamente o falso positivo que derrubou a primeira
 * tentativa desta detecção.
 */
const SCREEN_LINES = 40

/**
 * Quebra de linha do PTY é `\r`, `\n` OU `\r\n` — e num TUI é quase sempre a
 * primeira.
 *
 * Medido na tela capturada em scripts/fixtures/: 116 `\r` contra 7 `\n`. Quem
 * fatiasse só por `\n` veria a tela inteira como OITO linhas, a janela de 40
 * abaixo pegaria tudo, e a defesa contra o diálogo já respondido — que existe
 * justamente para olhar só o fim — não defenderia nada.
 *
 * Um `\r` solto é o TUI reescrevendo a linha por cima, e não uma linha nova.
 * Contá-lo como quebra faz a janela ficar MENOR do que a tela real, o que erra
 * para o lado seguro: no máximo deixamos de reconhecer uma espera, nunca
 * inventamos uma.
 */
const NEWLINE = /\r\n|\r|\n/

/** Sem whitespace e em minúsculas — ver o comentário do bloco sobre o TUI. */
function dense(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/**
 * O agente está parado esperando uma resposta do usuário?
 *
 * `null` quando não dá para afirmar, e é a resposta certa para todo preset cuja
 * tela ainda não foi vista de verdade. Um `waiting` inventado é pior que a
 * ignorância que ele substitui: faria `ask` desistir de um agente que está
 * trabalhando.
 */
export function detectWaiting(screen: string): WaitingReason | null {
  const lines = stripAnsi(screen).split(NEWLINE)
  const tail = lines.slice(-SCREEN_LINES).join('\n')
  const d = dense(tail)

  // Claude Code. A pergunta sozinha não basta — ela também aparece no texto de
  // uma conversa QUALQUER sobre permissões. O que a torna um diálogo é a lista
  // de opções logo abaixo, e é a conjunção que casa.
  //
  // A ÂNCORA É O RODAPÉ, e não o texto da pergunta. `Do you want to proceed`
  // era a única forma reconhecida, e o Claude Code tem mais de uma: um diálogo
  // que diz `Allow reads outside the working directories?` — o que o agente vê
  // ao abrir uma reference da skill do Atelier, que mora fora do cwd do nó —
  // passava batido, e o nó ficava `[idle]`. No ciclo 0 de 01/09 isso apareceu
  // em SEIS das sete trilhas, e uma corrida parada nele entrou no relatório
  // pontuada como se o sujeito tivesse terminado (S4, run 1).
  //
  // `Tab to amend` é o rodapé do diálogo aberto: está nas duas telas de
  // permissão capturadas e em nenhuma das trilhas normais, nem na de
  // `AskUserQuestion`. Ancorar nele cobre a próxima variante do texto sem
  // precisar aprender a frase dela. `doyouwanttoproceed` fica como alternativa,
  // porque um diálogo sem o rodapé continuaria sendo um diálogo.
  const asks = d.includes('doyouwanttoproceed')
  const amend = d.includes('tabtoamend')
  const numbered = d.includes('1.yes') || (d.includes('1.') && d.includes('2.'))
  const escape = d.includes('esctocancel')
  if ((asks || amend) && (numbered || escape)) {
    return { kind: 'permission', detail: commandUnderReview(tail) }
  }

  // A OUTRA parada do Claude Code: `AskUserQuestion`, a lista de opções.
  //
  // Não é diálogo de permissão — é o agente perguntando algo ao usuário, com
  // opções numeradas — e por isso não casa em nada acima. Um sujeito do eval
  // parado aqui foi PONTUADO como se tivesse terminado (01/09, cenário S5): o
  // agente descobriu que faltava uma variável de ambiente, parou para perguntar
  // como proceder, e a corrida entrou no relatório como resposta.
  //
  // A âncora é o rodapé da lista, `Enter to select`, que só existe quando há
  // uma seleção aberta esperando tecla. Sozinho ele bastaria; exigir também as
  // opções numeradas é o que impede que a frase, aparecendo no texto de uma
  // conversa qualquer, vire uma espera inventada.
  const selecting = d.includes('entertoselect')
  if (selecting && numbered) return { kind: 'question', detail: questionAsked(tail) }

  // Os outros presets caem aqui de propósito, até existir tela capturada deles.
  return null
}

/**
 * A pergunta que o agente fez, quando ela sobrevive ao redesenho.
 *
 * A primeira opção da lista é o que chega mais inteiro — o enunciado costuma vir
 * com os espaços comidos —, e é ela que diz ao coordenador o que destravaria o
 * nó. Sem candidata boa, `null`: um rótulo sem espaços seria pior que nenhum.
 */
function questionAsked(tail: string): string | null {
  for (const line of tail.split('\n')) {
    const m = /(?:❯\s*)?1\.\s*(.{3,80}?)\s*$/.exec(line)
    if (m && m[1] && /\s/.test(m[1])) return `asking: ${m[1]}`
  }
  return null
}

/**
 * O comando que o diálogo está pedindo para aprovar, quando ele aparece na
 * forma que sobrevive ao redesenho.
 *
 * O Claude Code ecoa o comando numa linha própria, prefixada por `⎿  $ `, e
 * essa linha chega íntegra porque não é redesenhada junto com o diálogo. As
 * outras candidatas (o rótulo `Bash command`, a descrição) vêm com os espaços
 * comidos e virariam `Verificaocaminhodocomandoatelier` no relatório — daí só
 * esta ser lida, e o resto voltar `null`.
 */
function commandUnderReview(tail: string): string | null {
  let found: string | null = null
  for (const line of tail.split('\n')) {
    const m = /⎿\s+\$\s+(.+?)\s*$/.exec(line)
    if (m && m[1]) found = m[1]
  }
  return found && found.length <= 120 ? found : null
}
