/**
 * Contas do Claude no renderer: o que o diálogo e a barra de ações precisam
 * dizer sobre elas.
 *
 * Mora fora dos dois componentes porque a MESMA pergunta — "este terminal é um
 * Claude?" — decide se o seletor aparece no diálogo e se o botão aparece no nó.
 * Respostas diferentes nos dois lugares dariam um terminal que dá para
 * configurar mas não dá para trocar (ou o contrário).
 */
import type { ClaudeAccountInfo } from '@shared/types'

/** Valor sentinela do <option> que abre o campo de criar conta. */
export const ADD_ACCOUNT = '__add__'

/**
 * Terminal que roda o Claude Code. O `agentType` é o caminho normal (vem do
 * Início Rápido e do `recruit`); o comando é a rede de segurança para quem
 * digitou `claude` à mão num terminal genérico — que é exatamente o caso em que
 * a conta importa e o tipo não conta.
 */
export function isClaudeCommand(t: { agentType: string; command: string }): boolean {
  if (t.agentType === 'claude_code') return true
  return /(^|[\s/\\])claude(\s|$)/.test(t.command.trim())
}

/** "Trabalho — etasso@gmail.com" ou "Trabalho — sem login". */
export function accountLabel(account: ClaudeAccountInfo): string {
  if (!account.authenticated) return `${account.label} — sem login`
  return account.email ? `${account.label} — ${account.email}` : account.label
}
