/**
 * O rascunho do diálogo de terminal virando conteúdo de nó.
 *
 * Mora fora do bridge por causa de um bug real: enquanto essa lista de campos
 * vivia dentro do `contentFor`, ela era uma CÓPIA manual do TerminalDraft que
 * nenhum teste alcançava (o bridge importa `electron`). Um campo novo no
 * rascunho — foi o caso da conta do Claude — chegava do renderer e era
 * silenciosamente descartado: o terminal nascia na conta padrão mesmo com outra
 * escolhida no diálogo, e nada acusava.
 *
 * Os `opts` vêm do renderer e são dados não confiáveis, então cada campo é
 * validado aqui. Id que não existe (responsabilidade ou conta) vira null, e não
 * erro: é o mesmo destino que ele teria no spawn, e o usuário vê o nó nascer na
 * conta padrão em vez de não nascer.
 */
import type { TerminalContent, UUID } from '@shared/types'
import { makeTerminalContent } from './node-content'

export interface DraftGuards {
  /** A responsabilidade ainda existe no RoleStore? */
  roleExists: (id: string) => boolean
  /** A conta ainda existe em claude-accounts.json? */
  accountExists: (id: string) => boolean
}

export function terminalContentFromOpts(
  opts: Record<string, unknown>,
  guards: DraftGuards
): TerminalContent {
  const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)

  return makeTerminalContent(String(opts.name ?? 'Terminal'), {
    agentType: String(opts.agentType ?? 'generic_shell'),
    command: String(opts.command ?? ''),
    workingDirectory: String(opts.workingDirectory ?? ''),
    icon: String(opts.icon ?? 'terminal'),
    color: String(opts.color ?? '#007AFF'),
    isManager: opts.isManager === true,
    monitorWithOmbro: opts.monitorWithOmbro === true,
    themeId: optStr(opts.themeId),
    fontFamily: optStr(opts.fontFamily),
    fontSize: typeof opts.fontSize === 'number' ? opts.fontSize : null,
    assignedRoleId:
      typeof opts.assignedRoleId === 'string' && guards.roleExists(opts.assignedRoleId)
        ? (opts.assignedRoleId as UUID)
        : null,
    claudeAccountId:
      typeof opts.claudeAccountId === 'string' && guards.accountExists(opts.claudeAccountId)
        ? opts.claudeAccountId
        : null,
    // Sessão anterior escolhida no select "Retomar sessão". Sem guarda: um id
    // que não bate com nenhuma transcrição em disco simplesmente decai para
    // sessão nova no `planSession`, como qualquer `--resume` que não cola.
    resumeSessionId:
      typeof opts.resumeSessionId === 'string' && opts.resumeSessionId !== ''
        ? (opts.resumeSessionId as UUID)
        : null
  })
}
