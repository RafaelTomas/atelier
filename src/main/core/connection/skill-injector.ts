/**
 * Porte de Sources/Connection/SkillInjector.swift.
 *
 * Duas coisas com o mesmo nome no app nativo, mantidas aqui:
 *   1. Instalar a skill em ~/.claude/skills/ (uma vez por boot, idempotente)
 *   2. Sinalizar ao terminal, na conexão, que o `atelier` está disponível
 *
 * A skill vive sob o nome `atelier`, separada da skill `maestri` do app nativo.
 * As duas podem coexistir: um agente lê a que corresponde ao app onde está.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { claudeSkillsDir } from '../persistence/paths'
import { terminals } from '../terminal/terminal-manager'

const SKILL_NAME = 'atelier'

/**
 * Marca de propriedade: só sobrescrevemos arquivos que nós mesmos escrevemos.
 * Fica DEPOIS do frontmatter — antes dele, o bloco YAML deixa de ser reconhecido
 * e o carregador de skills passa a ler este comentário como sendo a descrição.
 */
const OWNER_MARKER = '<!-- installed-by: atelier -->'

const SKILL_MD = `---
name: atelier
description: Send messages to connected AI agents on the Atelier canvas and get their responses. Also read and write connected sticky notes, open and read connected browser portals (the pages the user is looking at), and read or describe the user's indexed development projects. Use when the user's intent is to collaborate with another agent on the canvas. Look for actions like 'ask [name] to...', 'tell [name] to...', 'check on [name]', 'create/update a note', 'open/read a page in a portal', or 'describe the projects'.
---

${OWNER_MARKER}

# Atelier inter-agent collaboration

Connected agents exchange prompts and responses through the \`atelier\` CLI.
Connected notes can be read and written through the same CLI.

## Discover what you are connected to

\`\`\`
atelier list
\`\`\`

Always run this first — it gives the exact agent and note names to use.

## Talk to another agent

\`\`\`
atelier ask "Agent Name" "your prompt"
atelier check "Agent Name" 40
\`\`\`

\`ask\` blocks until the other agent goes idle. If it times out, do NOT re-send
the prompt — run \`check\` to see progress and wait again. Never interrupt an
agent that is still working, and do not edit files another agent is modifying.

## Your own responsibility

\`\`\`
atelier role
atelier role list
\`\`\`

If a role is assigned to your terminal, \`atelier role\` prints what you are
responsible for on this canvas. Run it before starting work — it scopes what you
should and should not touch. \`atelier list\` shows the roles of the agents you
are connected to.

## Notes

\`\`\`
atelier note create ["content"]
atelier note read "Note Name" [offset] [limit]
atelier note write "Note Name" "content"
atelier note edit "Note Name" "old text" "new text"
\`\`\`

## Portals

A portal is a browser inside the canvas. Connected ones are yours to read — they
are usually the page the user is looking at right now.

\`\`\`
atelier portal list
atelier portal open <url> [name]
atelier portal go "Portal" <url>
atelier portal read "Portal" [offset] [limit]
atelier portal html "Portal" [selector]
atelier portal shot "Portal" [path]
atelier portal close "Portal"
\`\`\`

\`open\` creates a portal already connected to you; \`localhost:5173\` and bare
domains work, exactly as in the address bar. \`read\` gives the visible TEXT of
the page, with \`offset\`/\`limit\` in lines, like \`note read\`. For a PDF or an
image there is no text to read — use \`shot\`, which writes a PNG and prints its
path for you to open.

A portal that is off-screen or zoomed out is woken up for the read, so the first
one may take a second. You cannot run arbitrary JavaScript in a portal: these
sessions are often logged in as the user.

## Projects

The user's indexed development projects, found by the Scan button. Unlike the
commands above, this index is GLOBAL: it is not limited to what you are
connected to, and it never reads files inside a project — only its metadata.

\`\`\`
atelier projects list [search] [--pending]
atelier projects info "<path or name>"
atelier projects describe "<path>" "one sentence" --stack "React,TypeScript" --role "api"
\`\`\`

Address a project by its full PATH, as printed by \`list\`. Names repeat — half
a dozen "backend" in one home is normal — and an ambiguous name is refused.

\`--pending\` lists the projects that still have no description. If you were
given the "Scanner de projetos" role, that listing is your work queue: take the
first one, inspect the folder yourself, report with \`describe\`, repeat.

Never modify anything inside a project while describing it.

## Troubleshooting

\`\`\`
atelier debug
\`\`\`

The CLI is on PATH inside Atelier terminals. If a custom shell resets PATH, use
\`"$ATELIER_CLI"\` — that variable always holds the full path.
`

let installed = false

/**
 * Idempotente, chamado a cada boot (fase 2 da ordem de boot).
 *
 * ~/.claude/skills/ é compartilhado com outros apps. Só escrevemos se o arquivo
 * não existir ou se for nosso — sobrescrever a skill de outro app destruiria
 * trabalho alheio.
 */
export async function installSkillsIfNeeded(): Promise<void> {
  if (installed) return
  try {
    const dir = join(claudeSkillsDir(), SKILL_NAME)
    const file = join(dir, 'SKILL.md')

    const existing = await readFile(file, 'utf8').catch(() => null)
    if (existing !== null && !existing.includes(OWNER_MARKER)) {
      installed = true
      log.info('skill', `skill de outro app já presente em ${file} — preservada`)
      return
    }

    await mkdir(dir, { recursive: true })
    await writeFile(file, SKILL_MD, 'utf8')
    installed = true
    log.info('skill', `skill instalada em ${dir}`)
  } catch (err) {
    // Falhar aqui não pode derrubar o boot
    log.warn('skill', 'não foi possível instalar a skill', err)
  }
}

const notified = new Set<UUID>()

/**
 * Avisa o terminal, uma vez só, que ele ganhou acesso ao CLI. Escreve um
 * comentário de shell (linha iniciada por #) — inerte se o agente for um shell,
 * informativo se for um agente de IA lendo a tela.
 */
export function injectSkillInto(terminalId: UUID): void {
  if (notified.has(terminalId)) return
  const session = terminals.get(terminalId)
  if (!session || session.exited) return

  notified.add(terminalId)
  terminals.write(
    terminalId,
    '# atelier: connected — run `atelier list` to see connected agents, notes and portals\r'
  )
}

export function forgetTerminal(terminalId: UUID): void {
  notified.delete(terminalId)
}
