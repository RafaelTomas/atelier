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
