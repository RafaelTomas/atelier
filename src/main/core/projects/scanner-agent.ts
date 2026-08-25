/**
 * O nó Scanner: um agente de verdade, no canvas, que descreve os projetos.
 *
 * Por que um nó visível e não um processo escondido: rodar um agente headless
 * a partir do main falha em silêncio no caso mais comum — sem credencial, sem
 * cota, offline, binário fora do PATH — e o usuário só vê um scan que "não fez
 * nada". Aqui ele vê o terminal, lê o que aconteceu, e pode intervir.
 *
 * E o agente devolve o resultado pelo CLI (`atelier projects describe`), não
 * pelo stdout: é o mesmo socket que os outros agentes já usam, o que dispensa
 * qualquer parsing de scrollback — a parte que tornaria isto frágil.
 *
 * O índice NUNCA depende deste agente. As heurísticas do scanner já preenchem
 * nome, stack, linguagem, branch e descrição do README. Se o Scanner nunca
 * rodar, o painel continua completo.
 */
import type { AgentRole, CanvasNode, Point, UUID } from '@shared/types'
import { log } from '../logger'
import { makeTerminalContent } from '../models/node-content'
import { makeCanvasNode } from '../models/workspace'
import { appState } from '../state/app-state'
import { roles } from '../state/role-store'
import { terminals } from '../terminal/terminal-manager'

export const SCANNER_ROLE_NAME = 'Scanner de projetos'

/**
 * O texto que o agente lê com `atelier role`. É o prompt inteiro: nada é
 * escrito no PTY além do comando que sobe o agente.
 */
const SCANNER_INSTRUCTIONS = `You describe the user's development projects so they can find them later.

Loop, one project at a time:

1. Run \`atelier projects list --pending\` to see what still needs a description.
   Stop when it reports none pending.
2. Take the FIRST pending project. Copy its path from that listing — the path
   is the identifier; names repeat.
3. Inspect it yourself — README, manifest, source layout. Read files; do not
   guess from the name.
4. Report with:

   atelier projects describe "<full path>" "<one sentence, max 500 chars>" --stack "React,TypeScript" --role "<what it is for>"

   - description: what the project DOES, in the user's language. Not "a Node
     project" — say what it builds or solves.
   - stack: the real frameworks and languages, comma separated, at most 12.
   - role: the project's purpose in one or two words (api, cli, site, lib,
     study, prototype).
5. Go back to step 1.

Rules:
- NEVER modify, create or delete anything inside a project. You are reading.
- If a project is unreadable or empty, describe it as such and move on — do not
  retry and do not stop the loop.
- Do not run builds, installs or tests.`

/**
 * O empurrão inicial. Sem ele o agente sobe e fica parado no prompt: subir o
 * binário não é dar trabalho a ele, e o usuário via um nó "Scanner" que não
 * descrevia nada.
 *
 * Curto de propósito — a fila e as regras estão na role, que ele lê com
 * `atelier role`. Repetir tudo aqui daria duas fontes da verdade.
 */
const KICKOFF = 'Run `atelier role` to read your instructions, then follow them now.'

/** Quanto tempo sem saída nova conta como "o agente terminou de subir". */
const READY_QUIET_MS = 2500
const KICKOFF_TIMEOUT_MS = 45_000
const POLL_MS = 500
/** Intervalo entre o texto e o ENTER — ver o comentário no envio. */
const SUBMIT_DELAY_MS = 400

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Espera o agente acabar de subir e manda o primeiro prompt.
 *
 * A espera é por SILÊNCIO, não por tempo fixo: `claude` leva de um a dez
 * segundos conforme a máquina, e um prompt digitado no meio do splash se perde.
 * O PTY também não existe no instante em que o nó nasce — quem o abre é o
 * renderer, ao montar o nó —, daí a sondagem em vez de uma leitura só.
 */
async function kickoffScanner(nodeId: UUID): Promise<void> {
  const deadline = Date.now() + KICKOFF_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(POLL_MS)
    const session = terminals.get(nodeId)
    if (!session) continue
    if (session.exited) {
      log.warn('scan', 'Scanner saiu antes do primeiro prompt')
      return
    }
    if (session.buffer.length === 0) continue
    if (Date.now() - session.lastOutputAt < READY_QUIET_MS) continue

    // Texto e ENTER em duas escritas: chegando juntos, o composer do agente
    // trata o CR como quebra de linha da mesma colagem e o prompt fica parado
    // na caixa, digitado e não enviado.
    terminals.write(nodeId, KICKOFF)
    await delay(SUBMIT_DELAY_MS)
    terminals.write(nodeId, '\r')
    log.info('scan', `Scanner recebeu o prompt inicial (${nodeId.slice(0, 8)})`)
    return
  }
  log.warn('scan', 'Scanner não ficou pronto a tempo; prompt inicial não foi enviado')
}

async function ensureScannerRole(): Promise<AgentRole> {
  const existing = roles.all.find((r) => r.name === SCANNER_ROLE_NAME)
  if (existing) return existing
  return roles.save({
    name: SCANNER_ROLE_NAME,
    instructions: SCANNER_INSTRUCTIONS,
    icon: 'sparkle',
    color: '#6E56CF',
    workspaceId: null
  })
}

export interface StartScannerInput {
  workspaceId: UUID
  position: Point
  /** Comando do agente (claude, codex, …). Vazio abre só o shell. */
  command: string
  homeDir: string
}

export async function startScannerAgent(
  input: StartScannerInput
): Promise<{ node: CanvasNode } | { error: string }> {
  const ws = appState.workspaces.get(input.workspaceId)
  if (!ws) return { error: 'nenhum workspace aberto' }

  const role = await ensureScannerRole()

  // Um Scanner por vez: dois agentes na mesma fila se sobrepõem e gastam o
  // dobro de tokens descrevendo os mesmos projetos.
  const running = ws.nodes.find(
    (n) =>
      n.content.type === 'terminal' &&
      n.content.value.assignedRoleId === role.id &&
      !terminals.get(n.id)?.exited
  )
  if (running) return { node: running }

  const node = makeCanvasNode(
    { ...input.position, width: 560, height: 360 },
    {
      type: 'terminal',
      value: makeTerminalContent('Scanner', {
        command: input.command,
        // A home: o agente navega até cada projeto por conta própria, a partir
        // dos caminhos que o `atelier projects list` devolve.
        workingDirectory: input.homeDir,
        icon: 'sparkle',
        color: '#6E56CF',
        assignedRoleId: role.id
      })
    }
  )

  ws.addNode(node)
  log.info('scan', `nó Scanner criado (${node.id.slice(0, 8)})`)
  // Não aguardamos: o IPC responde com o nó agora, e o empurrão vai quando o
  // agente estiver de pé.
  if (input.command) void kickoffScanner(node.id)
  return { node }
}
