/**
 * Porte de Sources/Connection/SkillInjector.swift.
 *
 * Duas coisas com o mesmo nome no app nativo, mantidas aqui:
 *   1. Instalar a skill em ~/.claude/skills/ (uma vez por boot, idempotente)
 *   2. Sinalizar ao terminal, na conexão, que o `atelier` está disponível
 *
 * A skill vive sob o nome `atelier`, separada da skill que o app nativo injeta.
 * As duas podem coexistir: um agente lê a que corresponde ao app onde está.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { claudeSkillsDir } from '../persistence/paths'
import { terminals } from '../terminal/terminal-manager'
import { notifyRenderer } from '../../ipc/notify'

const SKILL_NAME = 'atelier'

/**
 * Marca de propriedade: só sobrescrevemos arquivos que nós mesmos escrevemos.
 * Fica DEPOIS do frontmatter — antes dele, o bloco YAML deixa de ser reconhecido
 * e o carregador de skills passa a ler este comentário como sendo a descrição.
 */
const OWNER_MARKER = '<!-- installed-by: atelier -->'

const SKILL_MD = `---
name: atelier
description: Send messages to connected AI agents on the Atelier canvas and get their responses, or recruit a new agent as a terminal node already cabled to you. Also read and write connected sticky notes, open and read connected browser portals (the pages the user is looking at), read the file the user has open in a connected code editor node (including unsaved changes and the lines they selected), publish SQL/query results as a table node on the canvas, publish an image (chart, screenshot, diagram) as a node on the canvas, create a button on the canvas that runs a command the user repeats, read secrets from a connected vault (including logging into a page without ever seeing the password), and read or describe the user's indexed development projects. Use when the user's intent is to collaborate with another agent on the canvas. Look for actions like 'ask [name] to...', 'tell [name] to...', 'check on [name]', 'open/recruit another agent', 'create/update a note', 'open/read a page in a portal', 'what file am I looking at', 'explain/refactor this selection', 'show this query result on the canvas', 'put this image on the canvas', 'make a button for this command', or 'describe the projects'.
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

## Recruit another agent

\`\`\`
atelier recruit "Name" [--preset claude|codex|antigravity|opencode|shell] [--cwd /path] [--role "Role"] [--account "Account"] [--model opus|sonnet|haiku|luna|terra|sol|model-id]
atelier recruit "Name" --command "claude --resume <session-id>" [--cwd /path]
\`\`\`

Creates a terminal node already cabled to you, so you can hand work to it with
\`ask\`. Default preset is \`claude\`; without \`--cwd\` it starts in YOUR working
directory. \`--account\` picks which Claude login the new agent runs under (the
names the user set up in Atelier); without it, the agent uses the default one.
A recruited agent boots only when its node is on screen: run \`atelier list\` and
wait for it to leave \`[not started]\` before asking it anything.

Recruit when the work is genuinely parallel or belongs to a different
responsibility — not to split a task you can finish yourself. The canvas refuses
to go past a dozen terminals.

\`--command\` runs an arbitrary command instead of one of the five presets, and is
mutually exclusive with \`--preset\`. **Prefer \`--preset\`**: it gives the new node
the right icon, colour and agent type, and those are what the canvas uses to know
what is running. \`--command\` exists for the case that has no preset — bringing an
agent back on a session that already has context.

## If you wake up with no memory of your own work

A restart of the app — a crash, or the dev watcher noticing a file change —
kills every agent on the canvas. Atelier now brings Claude Code nodes back with
\`--resume\`, so this should be rare, but it is not guaranteed: an older CLI, or a
session file that is gone, drops you into a fresh conversation.

**The work on disk survived; only the conversation did not.** So before redoing
anything: read the files, run \`git status\` and \`git diff\`, check the test suite.
Assume the previous you got further than you remember, and verify instead of
starting over — redoing finished work is how a restart turns into a regression.

### Pick the model for the work, not the biggest one

Before recruiting, run \`atelier list\`. Reuse a connected agent whose role
already covers the work; do not create a duplicate. Recruit only when the task
can advance independently or needs truly separate context or expertise. For
Codex, use \`luna\` for focused/routine/high-volume work, \`terra\` for everyday
implementation, analysis and review, and \`sol\` only for difficult, ambiguous,
architectural or high-risk problems. Do not use Sol by default.

\`--model\` sets which model the recruit runs. It applies to \`claude\` and
\`codex\`: Claude accepts its usual aliases and ids; Codex accepts \`luna\`,
\`terra\`, \`sol\`, or full ids like \`gpt-5.6-terra\`. Choose it deliberately every time you recruit:

- \`--model haiku\` — mechanical, verifiable work: run the tests and report,
  find every occurrence of X, apply a patch that is already decided, rename
  across files, summarize a log, check formatting.
- \`--model sonnet\` — ordinary implementation inside a scope you already
  defined: write a handler modeled on an existing one, cover code with tests,
  fix a bug that is already localized.
- No \`--model\` — architecture judgment, security review, or debugging a cause
  nobody has found yet.

For Codex, do not leave difficult work implicit: pass \`--model sol\` only when
the scope really needs it.

When two levels both look defensible, **take the cheaper one and escalate if the
recruit struggles**: re-running a task on a bigger model costs less than running
everything on the biggest one out of caution.

## If you are an Artisan

Some terminals are marked **Artisan** in Atelier. \`ATELIER_ARTESAO=1\` is set in
your environment when you are one, and \`atelier list\` opens with a reminder.

On Claude Code the rule is enforced: your internal subagent tool is denied, and
the refusal tells you to recruit instead. On the other agents it is instruction
only — nothing stops you, and keeping to it is on you.

That is not a punishment, it is where your team lives. A subagent is invisible on
the canvas — no node, no screen the user can read, no way to interrupt it, and it
dies with your session. A recruit is a node: visible, interruptible, resumable,
and its cost shows up on its own status line.

So delegate with \`recruit\` + \`ask\` + \`check\`, keep the board honest if one is
cabled to you, and \`dismiss\` what you opened once its work is verified. The rules
above still apply, especially the first one: run \`atelier list\` and reuse before
you recruit.

## Dismiss an agent you recruited

\`\`\`
atelier dismiss "Name" [--force]
\`\`\`

Kills the process and removes the node from the canvas. You can only dismiss an
agent YOU recruited — never the user's own terminal, and never a colleague's,
even when you are cabled to it. Dismissing an agent that is still working is
refused; run \`check\` first, and pass \`--force\` only when you are sure killing
it mid-task is what you want. Dismiss when the work you handed over is finished
and the node would just sit there; leave it alone if the user might still want
to read its screen.

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

## TODO board

A board is the work plan of this canvas, with columns and status. It is what
lets the user WATCH a card move from *Fazendo* to *Feito* while you work,
without you having to tell them anything.

\`\`\`
atelier todo list ["Board"] [--status doing] [--mine]
atelier todo add "Board" "title" [--status todo] [--assign "Name"] [--notes "…"]
atelier todo move "Board" <id|"title prefix"> <status>
atelier todo done "Board" <id|"title prefix">
atelier todo show "Board" <id|"title prefix">
atelier todo create "Title" [column…]
atelier todo plan "Board" <id|"title prefix"> [--title "…"] [--objective "…"] [--step "…"]…
atelier todo step "Board" <id|"title prefix"> <step number> <pending|in_progress|done|blocked|skipped>
\`\`\`

Only boards CABLED to you, like everything else here. \`create\` makes one already
connected to you. Name the board only when more than one is connected.

Address a card by id or by a prefix of its title — an ambiguous prefix is an
error listing the candidates, never "the first one".

A card may also carry a **plan** — how the work will be done. \`plan\` with
\`--step\` creates it, or REVISES it into a new version with the old one kept in
the history; \`plan\` with no flags just shows it. \`step\` marks one step and
creates no version — that is what keeps the history readable.

**Mark \`done\` when you FINISH, not when you start.** A board that says a card is
done when it is merely begun is worse than no board: the user stops checking it.
Move it to the middle column when you pick it up, and to the last one when the
work is actually verified.

\`--mine\` filters by \`assignee\` matching YOUR terminal name, which is how the
board distributes work between agents: each one asks what is theirs.

There is no \`delete\`. Removing a card is the user's gesture, in the node — the
same line as the vault, where you create but do not destroy.

## Code editors

A code editor node is a file open on the canvas — usually the file the user is
looking at right now. The cable answers the three things you cannot get from
disk: **which** file it is, **what** the user selected, and whether the buffer
has changes that were never saved.

\`\`\`
atelier editor list
atelier editor open <absolute path>
atelier editor read "File" [offset] [limit] [--selection]
atelier editor close "File"
\`\`\`

\`list\` prints the ABSOLUTE PATH of every connected editor, plus the cursor line
and the selected line range. That path is the point of the cable: **read here,
but edit the file with your own tools** — your \`Edit\`/\`Write\` have the diff,
the permission prompt and the history that this CLI does not, the file is the
same file, and the node reloads by itself afterwards. There is deliberately no
\`editor write\`.

\`read\` gives the buffer when it differs from disk (prefixed with
\`# unsaved changes — not on disk\`), otherwise the file. \`offset\`/\`limit\` are
in lines, like \`note read\`. \`--selection\` returns only the lines the user
selected, which is what answers "explain THIS" or "refactor THIS method"; with
nothing selected it is an error, never a guessed range.

**An editor with unsaved changes is one you do not touch.** Writing the file
under it destroys work nobody has reviewed — ask the user to save first, then
edit. \`close\` refuses a dirty editor for the same reason.

\`open\` creates the node already cabled to you, and only for a path under an
indexed project, the workspace working directory or a file-tree root. A path
already open in another node gives you THAT node back instead of a second buffer
fighting over the same file.

## Portals

A portal is a browser inside the canvas. Connected ones are yours to read — they
are usually the page the user is looking at right now. With the user's
permission you can also drive them: click, type, press keys, scroll.

\`\`\`
atelier portal list
atelier portal open <url> [name] [--session "Portal" | --shared]
atelier portal go "Portal" <url>
atelier portal read "Portal" [offset] [limit]
atelier portal html "Portal" [selector]
atelier portal shot "Portal" [path]
atelier portal close "Portal"
\`\`\`

\`open\` creates a portal already connected to you; \`localhost:5173\` and bare
domains work, exactly as in the address bar. **Same origin, same session**: if
you are connected to a portal already on that host, the new one continues its
session instead of landing on a login page. \`--session "Portal"\` forces a
specific one; \`--shared\` uses the shared cookie pool. The reply tells you which
session you got. \`read\` gives the visible TEXT of
the page, with \`offset\`/\`limit\` in lines, like \`note read\`. For a PDF or an
image there is no text to read — use \`shot\`, which writes a PNG and prints its
path for you to open.

A portal that is off-screen or zoomed out is woken up for the read, so the first
one may take a second. You cannot run arbitrary JavaScript in a portal: these
sessions are often logged in as the user.

### Acting in a page

\`\`\`
atelier portal map "Portal" [--all]
atelier portal click "Portal" <ref | --selector "css"> [--right | --double]
atelier portal type "Portal" <ref | --selector "css"> "text" [--clear] [--enter] [--keys]
atelier portal key "Portal" <Enter|Tab|Escape|Backspace|Delete|Space|Arrow…|Home|End|PageUp|PageDown>
atelier portal scroll "Portal" [ref] [--down | --up | --top | --bottom]
atelier portal wait "Portal" [--idle | --text "…" | --gone <ref> | --ms N]
atelier portal login "Portal" <ref | --selector "css"> --vault "Vault" --key KEY [--enter]
\`\`\`

**Start with \`map\`.** It lists the interactive elements by an accessibility
reference — role, label, state — and those numbers are what \`click\`, \`type\`
and \`scroll\` take. Do not guess CSS selectors from \`html\`: in a single-page app
the classes come from the bundler and change on every build. \`--selector\` is
there for when you already know the exact selector.

Refs belong to ONE map. Any navigation invalidates them, and a stale ref is an
error asking for a new \`map\` — it never clicks the wrong thing by luck. The map
covers the main frame only; if the page has iframes, the reply says so.

**Acting needs permission, per portal.** \`click\`, \`type\`, \`key\` and \`scroll\`
only work when the user has turned control on with the ⦾ button in that portal's
header; without it you get an error saying exactly that. Ask the user to enable
it — do not look for a way around. Reading (\`read\`, \`html\`, \`map\`, \`shot\`) never
needs it, and there is no \`eval\`: permission opens these verbs, not a JavaScript
interpreter.

\`type\` writes AT THE CURSOR: on a field that already reads \`tst\`, typing
\`XYZ\` leaves \`XYZtst\`. Pass \`--clear\` to replace the value instead of
appending to it.

\`login\` types a secret you never see. The value goes from the vault straight to
the page — it never enters your context, your scrollback, or the trail the user
reads. It works only when the vault node is cabled to BOTH you and that portal,
and only when the key declares the page's origin: a key for
\`https://github.com\` is refused on any other site, and a key with no origin is
refused everywhere. Fill the user field, then the password field, then press
Enter with \`portal key\` or \`--enter\`.

After a click that loads something, run \`portal wait "Portal" --idle\` before
reading. Every action reports what changed (new URL, new title) so you can tell
whether it landed without spending a \`shot\`, and every action is logged in the
portal node where the user can see it.

## Secrets / vault

A vault node holds secrets encrypted on disk. You can read the names of the keys
in the vaults cabled to you, and one value at a time when you really need it.

\`\`\`
atelier vault list
atelier vault get "Vault" <key>
atelier vault set "Vault" <KEY> <value>
atelier vault env "Vault"
\`\`\`

\`set\` CREATES a key, and that is the only write you have. It refuses a key that
already exists — you cannot change a value, and you cannot delete one; both are
the user's action in the node. A key you create is inert: no origin, so
\`portal login\` will not type it anywhere, and out of every terminal's
environment. Ask the user to turn those on if the key needs them. Every write is
in the vault's access trail.

Values you \`get\` land in your context and stay there. Prefer the injected
environment variable when there is one — \`atelier vault env\` lists which are
set — and prefer \`atelier portal login\` when the secret is going into a web
form, because there the value never reaches you at all. Never echo a secret into
the terminal, into a file, or into another agent's prompt.

A key only becomes an environment variable from the NEXT boot of this terminal
after the cable was drawn, so if \`$KEY\` is empty right after connecting a
vault, ask the user to reload the terminal.

## SQL / query results

Run the query yourself with whatever tool fits (\`psql\`, \`sqlite3\`, \`mysql\`,
…) and publish the RESULT as a table node, connected to you. The Atelier never
touches the database — this is a snapshot.

\`\`\`
atelier table create "Title" <data> [--query "SELECT …"] [--format auto|json|csv|tsv] [--dialect postgres|sqlite|mysql]
atelier table append "Title" <data> [--format …]
atelier table list
\`\`\`

\`<data>\` is one positional argument. \`--format auto\` (the default) detects it:
text starting with \`[\` or \`{\` is JSON; otherwise a tab in the first line means
TSV, else CSV. JSON is accepted as an array of objects (\`[{"id":1,"name":"a"}]\`)
or the explicit form \`{"columns":[…],"rows":[[…]]}\`. CSV/TSV take the first line
as the header.

Good inputs come straight from the client: \`sqlite3 -json db "SELECT …"\` or
\`psql -A -F',' -c "SELECT …"\`. Results over ~2000 rows (or 200k cells) are
truncated, and the reply says so. \`append\` adds rows to an existing table but
refuses if the columns differ — a schema change between calls is an error, not
a merge.

## Images

Publish an image as a node on the canvas, connected to you — a chart you
generated, a screenshot, a diagram. Pass the PATH to an image file (absolute);
PNG, JPEG, GIF, WebP, AVIF, SVG and BMP are accepted, up to 25 MB.

\`\`\`
atelier image create "Title" /abs/path/to/image.png [--alt "description"]
atelier image list
\`\`\`

## Buttons

A button is a small node on the canvas that runs something with one click — a
command in a terminal, a prompt to an agent, or a URL in a portal.

\`\`\`
atelier button propose "Label" --command "npm run dev" [--icon play] [--color "#34C759"] [--cwd <path>] [--target "Terminal"] [--confirm]
atelier button propose "Label" --prompt "review the diff" --target "Claude"
atelier button propose "Label" --url http://localhost:5173
atelier button list
atelier button remove "Label"
\`\`\`

**Propose a button when the user repeats the same command** — the second or
third time the same line goes into a terminal, offer one.
**Never propose a destructive button** (\`rm\`, \`drop\`, \`reset --hard\`,
deploy): one click is not enough deliberation for something that cannot be
undone.

Every button you propose arrives PENDING and does nothing until the user presses
Accept on the node — that is where they read the exact command. Say so when you
report back, or they will click a button that is not armed yet and think it is
broken. \`remove\` only works on a pending button you proposed yourself.

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
 * Avisa o terminal, uma vez só, que ele ganhou acesso ao CLI.
 *
 * NA TELA, NUNCA NO STDIN. A versão anterior escrevia no PTY, como o app
 * nativo: num shell isso é um comentário inofensivo, mas num agente de IA a
 * linha cai dentro do campo de digitação — e o `\r` do fim podia mandá-la como
 * prompt. O aviso é para ser lido, não digitado.
 *
 * Ir pelo canal de dados do renderer resolve os dois lados: o texto aparece no
 * xterm e some no próximo redesenho de quem tem interface de tela cheia, e não
 * entra no scrollback (que é gravado a partir da saída do processo, no main).
 */
export function injectSkillInto(terminalId: UUID): void {
  if (notified.has(terminalId)) return
  const session = terminals.get(terminalId)
  if (!session || session.exited) return

  notified.add(terminalId)
  notifyRenderer('terminal:data', {
    id: terminalId,
    data: '\r\n\x1b[90m# atelier: conectado — `atelier list` mostra agentes, notas e portais\x1b[0m\r\n'
  })
}

export function forgetTerminal(terminalId: UUID): void {
  notified.delete(terminalId)
}
