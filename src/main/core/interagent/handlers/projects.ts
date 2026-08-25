/**
 * `atelier projects` — o índice de projetos, para o agente Scanner.
 *
 * ESCOPO: diferente de `list`, `ask` e `note`, este comando NÃO é limitado aos
 * nós conectados. O índice é global — não pertence a workspace nenhum — e é o
 * mesmo para qualquer agente que pergunte, como já acontece com `role` e
 * `debug`.
 *
 * O comando nunca lê arquivos dentro dos projetos: devolve só metadados que já
 * estão no índice. Quem quiser inspecionar um projeto usa as próprias
 * ferramentas dentro do diretório, não este canal.
 *
 *   atelier projects list [busca] [--pending]
 *   atelier projects info "<caminho ou nome>"
 *   atelier projects describe "<caminho ou nome>" "descrição" [--stack a,b] [--role x]
 *
 * O identificador preferido é o CAMINHO: nomes repetem (meia dúzia de
 * "backend" numa home é o caso comum) e um `describe` que casasse com o
 * primeiro deles descreveria o projeto errado sem avisar ninguém.
 */
import type { Project, UUID } from '@shared/types'
import { notifyRenderer } from '../../../ipc/notify'
import { projectIndex } from '../../state/project-store'
import { requireTerminalId } from './context'

const USAGE = "usage: atelier projects <list|info|describe> …"

export async function handleProjects(args: string[], terminalId: UUID | null): Promise<string> {
  if (!requireTerminalId(terminalId)) return 'error: missing terminal ID'

  switch (args[1]) {
    case undefined:
    case 'list':
      return listProjects(args)
    case 'info':
      return infoProject(args)
    case 'describe':
      return describeProject(args)
    default:
      return `error: unknown subcommand '${args[1]}'. ${USAGE}`
  }
}

function line(p: Project): string {
  const flags = [p.isFavorite ? '★' : '', p.isArchived ? '[archived]' : ''].filter(Boolean).join(' ')
  const meta = [p.kind, p.gitBranch].filter(Boolean).join(' · ')
  return `  ${p.name}  (${meta})  ${p.path}${flags ? '  ' + flags : ''}`
}

/**
 * Resolve o argumento posicional em um projeto só, ou explica por que não deu.
 * A mensagem de ambiguidade lista os caminhos justamente para que a próxima
 * tentativa do agente use um deles.
 */
function resolveOne(query: string): Project | string {
  const matches = projectIndex.resolveMany(query)
  if (matches.length === 0) {
    return `error: project '${query}' not found. Use 'atelier projects list'.`
  }
  if (matches.length > 1) {
    const paths = matches.slice(0, 10).map((p) => `  ${p.path}`)
    return [
      `error: '${query}' matches ${matches.length} projects. Repeat the command with the full path:`,
      ...paths
    ].join('\n')
  }
  return matches[0]
}

function listProjects(args: string[]): string {
  const pendingOnly = args.includes('--pending')
  const query = args.slice(2).filter((a) => !a.startsWith('--')).join(' ')

  let list = pendingOnly ? projectIndex.pending : projectIndex.all.filter((p) => !p.isArchived)
  if (query) {
    const q = query.toLowerCase()
    list = list.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  }

  if (list.length === 0) {
    return pendingOnly
      ? 'No projects pending description. Every indexed project already has one.'
      : 'No projects in the index yet. The user scans for them from the Projects panel.'
  }

  const header = pendingOnly
    ? `${list.length} project(s) awaiting a description (address each one by the path shown):`
    : `${list.length} project(s) in the index:`
  // Um teto para não despejar centenas de linhas num terminal de agente.
  const shown = list.slice(0, 100)
  const tail = list.length > shown.length ? [`  … and ${list.length - shown.length} more`] : []
  return [header, ...shown.map(line), ...tail].join('\n')
}

function infoProject(args: string[]): string {
  if (args.length < 3) return 'error: usage: atelier projects info "<path or name>"'
  const project = resolveOne(args[2])
  if (typeof project === 'string') return project

  return [
    `Name:        ${project.name}`,
    `Path:        ${project.path}`,
    `Kind:        ${project.kind}${project.language ? ` (${project.language})` : ''}`,
    `Git:         ${project.gitBranch ?? '—'}${project.gitRemote ? ` → ${project.gitRemote}` : ''}`,
    `Stack:       ${project.stack.join(', ') || '—'}`,
    `Description: ${project.description ?? '—'}`,
    `Role:        ${project.role ?? '—'}`,
    `Described:   ${project.enrichedAt ?? 'not yet'}`
  ].join('\n')
}

/** Extrai `--flag valor` sem consumir os argumentos posicionais. */
function flag(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

async function describeProject(args: string[]): Promise<string> {
  const positional = args.slice(2).filter((a, i, all) => {
    if (a.startsWith('--')) return false
    const prev = all[i - 1]
    return !(prev && prev.startsWith('--'))
  })

  if (positional.length < 2) {
    return 'error: usage: atelier projects describe "<path>" "description" [--stack a,b] [--role x]'
  }

  const project = resolveOne(positional[0])
  if (typeof project === 'string') return project

  const stackArg = flag(args, 'stack')
  const roleArg = flag(args, 'role')
  const updated = await projectIndex.describe(project.id, {
    description: positional[1],
    ...(stackArg ? { stack: stackArg.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(roleArg ? { role: roleArg } : {})
  })
  if (!updated) return 'error: could not update the index'

  // A UI reflete na hora: o painel do usuário se preenche enquanto o agente
  // trabalha, sem que ele precise recarregar nada.
  notifyRenderer('project:changed', { ids: [updated.id] })

  const truncated = positional[1].length > 500 ? ' (description truncated to 500 chars)' : ''
  return `Updated '${updated.name}'.${truncated}\nRemaining without description: ${projectIndex.pending.length}`
}
