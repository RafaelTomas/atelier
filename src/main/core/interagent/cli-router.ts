/**
 * Porte de Sources/InterAgent/CLIRouter.swift.
 *
 * Comando novo? Registre aqui E crie o handler em ./handlers/ — mesma regra do
 * app nativo.
 */
import type { UUID } from '@shared/types'
import { handleArtesao } from './handlers/artesao'
import { handleAsk } from './handlers/ask'
import { handleBrief } from './handlers/brief'
import { handleConnect } from './handlers/connect'
import { handleButton } from './handlers/button'
import { handleCheck } from './handlers/check'
import { handleDismiss } from './handlers/dismiss'
import { handleEditor } from './handlers/editor'
import { handleImage } from './handlers/image'
import { handleList } from './handlers/list'
import { handleNote } from './handlers/note'
import { handlePortal } from './handlers/portal'
import { handleProjects } from './handlers/projects'
import { handleRecruit } from './handlers/recruit'
import { handleRole } from './handlers/role'
import { handleStatusLine } from './handlers/statusline'
import { handleTable } from './handlers/table'
import { handleTodo } from './handlers/todo'
import { handleWaiting } from './handlers/waiting'
import { handleVault } from './handlers/vault'
import { interAgentServer } from './server'

const COMMANDS =
  'list ask check recruit dismiss note portal editor table image todo vault button role projects debug'

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
    case 'recruit':
      return handleRecruit(args, terminalId)
    case 'dismiss':
      return handleDismiss(args, terminalId)
    case 'note':
      return handleNote(args, terminalId)
    case 'portal':
      return handlePortal(args, terminalId)
    case 'editor':
      return handleEditor(args, terminalId)
    case 'table':
      return handleTable(args, terminalId)
    case 'todo':
      return handleTodo(args, terminalId)
    case 'image':
      return handleImage(args, terminalId)
    case 'vault':
      return handleVault(args, terminalId)
    case 'button':
      return handleButton(args, terminalId)
    case 'role':
      return handleRole(args, terminalId)
    case 'projects':
      return handleProjects(args, terminalId)
    // Fora de COMMANDS de propósito: não é um verbo que um agente digita. Quem
    // o chama é o Claude Code, a cada mensagem, pelo `statusLine` que o Atelier
    // instala no terminal — listá-lo no help só ofereceria ao agente um comando
    // que não faz nada útil na mão dele.
    case 'statusline':
      return handleStatusLine(args, terminalId)
    // Fora de COMMANDS pelo mesmo motivo do `statusline`: quem chama é o Claude
    // Code, pelos hooks que o Artesão instalou no `--settings` daquele terminal.
    // Oferecê-lo no help daria ao agente um verbo que não faz nada na mão dele.
    case 'artesao':
      return handleArtesao(args, terminalId)
    // Fora de COMMANDS pelo mesmo motivo: não é um verbo que um agente digita.
    // Quem chama é o hook `SessionStart` que o Atelier instala para TODO nó
    // Claude Code, e o boot do PTY, que grava a mesma resposta em
    // `ATELIER_BRIEF` para os presets sem hook (ver terminal-manager.ts e
    // terminal/agent-settings.ts).
    case 'brief':
      return handleBrief(args, terminalId)
    // Também fora de COMMANDS: quem chama é o hook `Notification`, e um agente
    // que pudesse digitá-lo anunciaria uma espera que não existe.
    case 'waiting':
      return handleWaiting(args, terminalId)
    case 'debug':
      return buildDebugInfo(terminalId)

    // Fora de COMMANDS, e não por não estar pronto: quem cabeia o canvas é o
    // USUÁRIO. Os cabos são a estrutura que ele desenhou, e um agente que
    // pudesse religá-los mudaria o que os outros enxergam sem ninguém ver.
    // Existe para o harness do eval montar a bancada de cada sujeito, e para um
    // coordenador que sabe o que está fazendo — os dois lados precisam já estar
    // cabeados a quem chama.
    case 'connect':
      return handleConnect(args, terminalId)

    // Ainda não portados — respondem com mensagem honesta em vez de falhar mudo
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
