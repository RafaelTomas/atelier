/**
 * O que já foi revelado a cada terminal — a lista contra a qual o scrollback é
 * mascarado.
 *
 * POR QUE ESTE MÓDULO EXISTE SEPARADO DO `vault-manager`: quem precisa mascarar
 * é o `terminal-manager`, no evento `data` do PTY. Se ele importasse o
 * `vault-manager` (que importa `app-state`, que alcança o próprio
 * `terminal-manager`), fecharia um ciclo de imports para ganhar duas funções.
 * Aqui não há dependência nenhuma: o `vault-manager` DEPOSITA os valores, o
 * `terminal-manager` CONSOME. Nenhum dos dois conhece o outro.
 *
 * Mascara-se só o que aquele terminal já puxou, não todo segredo de todo cofre
 * ligado: o que o agente nunca leu não tem como reaparecer na saída dele, e
 * varrer cada chunk contra o cofre inteiro custaria caro à toa (Decisão da
 * §Mascaramento do plano).
 */
import type { UUID } from '@shared/types'
import { maskSecrets } from '@shared/vault'

const revealed = new Map<UUID, Set<string>>()

/**
 * Passa a mascarar `value` na saída deste terminal.
 *
 * Chamado pelo `atelier vault get` (o agente pediu e recebeu) e pelo
 * `atelier portal login` (o agente NÃO recebeu, mas o valor foi digitado numa
 * página que ele pode ler de volta com `portal read`).
 */
export function rememberSecret(terminalId: UUID, value: string): void {
  if (!value.trim()) return
  const set = revealed.get(terminalId) ?? new Set<string>()
  set.add(value)
  revealed.set(terminalId, set)
}

/** Texto com os segredos já revelados a este terminal trocados pela máscara. */
export function maskForTerminal(terminalId: UUID, text: string): string {
  const set = revealed.get(terminalId)
  if (!set || set.size === 0) return text
  return maskSecrets(text, set)
}

/** Há algo a mascarar? Evita trabalho no caminho quente do PTY. */
export function hasSecrets(terminalId: UUID): boolean {
  const set = revealed.get(terminalId)
  return set !== undefined && set.size > 0
}

/** Terminal fechado: a lista morre com ele. */
export function forgetTerminalSecrets(terminalId: UUID): void {
  revealed.delete(terminalId)
}
