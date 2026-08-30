/**
 * `atelier statusline` — o agente publicando o próprio estado.
 *
 * Não é um comando que um agente digita: quem o chama é o Claude Code, a cada
 * mensagem nova, por causa do `statusLine` que o Atelier instala no `--settings`
 * daquele terminal (ver terminal/status-line.ts). O payload vem no stdin do CLI
 * e chega aqui como `args[1]`.
 *
 * A resposta volta para o stdout do comando, e o Claude Code a desenha na barra
 * de status do agente. Ou seja: o que este handler devolve é TEXTO PARA O
 * USUÁRIO LER, não uma confirmação para uma máquina — daí a linha compacta em
 * vez de um `ok`. Quando o usuário já tinha uma statusLine própria, o CLI nem
 * chega a usar esta resposta: ele executa a original e imprime a saída dela.
 */
import type { UUID } from '@shared/types'
import { formatTokens } from '@shared/types'
import { notifyRenderer } from '../../../ipc/notify'
import { recordStatusLine } from '../../terminal/status-line'
import { requireTerminalId } from './context'

export async function handleStatusLine(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const raw = args[1]
  if (!raw) return 'error: statusline expects the session JSON on stdin'

  const usage = recordStatusLine(tid, raw)
  // Texto inválido não derruba a barra do usuário: ela continua mostrando a
  // última linha boa em vez de piscar um erro a cada mensagem.
  if (!usage) return ''

  // Direto para a UI, sem passar pelo terminal-manager: quem produz esta
  // leitura é o agente, não o PTY — o manager não tem o que acrescentar, e
  // roteá-la por ele só criaria um evento para reencaminhar outro.
  notifyRenderer('terminal:usage', { id: tid, usage })

  const parts: string[] = []
  if (usage.model) parts.push(usage.model)
  if (usage.usedPercentage !== null) {
    // O tamanho da janela entra junto: "8%" de 1M e "8%" de 200k são coisas
    // diferentes, e é exatamente o que a leitura de tela nunca soube dizer.
    const size = usage.contextWindowSize
    const janela = size ? ` de ${formatTokens(size)}` : ''
    parts.push(`${Math.round(usage.usedPercentage)}% ctx${janela}`)
  } else if (usage.inputTokens !== null) {
    parts.push(`${formatTokens(usage.inputTokens)} tok`)
  }
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(2)}`)
  for (const l of usage.limits) parts.push(`${l.window} ${Math.round(l.pct)}%`)

  return parts.join(' · ')
}
