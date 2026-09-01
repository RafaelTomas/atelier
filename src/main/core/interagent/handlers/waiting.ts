/**
 * `atelier waiting` — o hook `Notification` de todo nó Claude Code (ver
 * terminal/agent-settings.ts).
 *
 * FORA de `COMMANDS` no roteador, pelo mesmo motivo do `statusline`, do
 * `artesao` e do `brief`: quem chama é o próprio Claude Code, não é um verbo
 * que um agente digita. Oferecê-lo no help daria ao agente a chance de anunciar
 * uma espera que ele não tem.
 *
 * ─── Por que um hook, e não só raspagem de tela ───
 *
 * `Notification` é o canal que o Claude Code publica DE PROPÓSITO quando para
 * para pedir alguma coisa, e a mensagem chega inteira. A tela chega com os
 * espaços comidos pelo redesenho (`Doyouwanttoproceed`), e chega junto com todo
 * o scrollback, onde um diálogo já respondido continua parecendo aberto. A
 * raspagem existe como piso para os presets sem hook — ver `detectWaiting` em
 * terminal/agent-status.ts — mas o sinal bom é este.
 *
 * ─── O que ele NÃO faz ───
 *
 * Não responde nada ao agente. `Notification` não injeta contexto, e um hook
 * que imprime aqui só polui a tela de quem já está parado esperando. A resposta
 * vazia é a resposta certa.
 */
import type { UUID } from '@shared/types'
import { terminals } from '../../terminal/terminal-manager'
import { requireTerminalId } from './context'

/** Uma linha de mensagem cabe; um payload inteiro não vira rótulo de estado. */
const MAX_MESSAGE = 200

export function handleWaiting(args: string[], terminalId: UUID | null): string {
  const tid = requireTerminalId(terminalId)
  if (!tid) return ''

  terminals.markWaiting(tid, messageFrom(args[1]))
  return ''
}

/**
 * A mensagem do payload do hook, quando dá para lê-la.
 *
 * O Claude Code entrega um JSON com `message` — "Claude needs your permission
 * to use Bash", por exemplo. Payload ausente, JSON quebrado ou campo faltando
 * viram string vazia em vez de erro: o estado `waiting` vale por si, e perder o
 * rótulo é muito melhor que perder o sinal.
 */
function messageFrom(payload: string | undefined): string {
  if (!payload) return ''
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object') return ''
    const message = (parsed as Record<string, unknown>).message
    if (typeof message !== 'string') return ''
    return message.trim().replace(/\s+/g, ' ').slice(0, MAX_MESSAGE)
  } catch {
    return ''
  }
}
