/**
 * Porte de Sources/InterAgent/CLIRouter.swift.
 *
 * Comando novo? Registre aqui E crie o handler em ./handlers/ — mesma regra do
 * app nativo.
 */
import type { UUID } from '@shared/types'
import { handleAsk } from './handlers/ask'
import { handleCheck } from './handlers/check'
import { handleList } from './handlers/list'
import { handleNote } from './handlers/note'
import { interAgentServer } from './server'

const COMMANDS = 'list ask check note debug'

export async function routeCLI(args: string[], terminalId: UUID | null): Promise<string> {
  const command = args[0]
  if (!command) return 'error: empty command'

  switch (command) {
    case 'list':
      return handleList(args, terminalId)
    case 'ask':
      return handleAsk(args, terminalId)
    case 'check':
      return handleCheck(args, terminalId)
    case 'note':
      return handleNote(args, terminalId)
    case 'debug':
      return buildDebugInfo(terminalId)

    // Ainda não portados — respondem com mensagem honesta em vez de falhar mudo
    case 'portal':
    case 'recruit':
    case 'dismiss':
    case 'connect':
    case 'role':
    case 'preset':
      return `error: '${command}' ainda não implementado neste porte Electron. Disponíveis: ${COMMANDS}`

    default:
      return `error: unknown command '${command}'. Try 'atelier list' for available commands.`
  }
}

function buildDebugInfo(terminalId: UUID | null): string {
  return [
    'Atelier inter-agent server debug:',
    `  Server port: ${interAgentServer.port}`,
    `  Terminal ID: ${terminalId ?? '(none)'}`,
    `  Platform:    ${process.platform}`,
    `  Commands:    ${COMMANDS}`
  ].join('\n')
}
