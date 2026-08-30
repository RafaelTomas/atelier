/**
 * A doutrina do Artesão — o texto que um nó marcado como Artesão lê no início
 * da sessão, pelo hook `SessionStart` que o Atelier instala no `--settings`
 * dele (ver terminal/agent-settings.ts).
 *
 * ─── Por que existe ───
 *
 * Um agente Claude Code tem duas formas de delegar e escolhe a errada por
 * hábito: a ferramenta `Task`, que abre um subagente DENTRO da sessão dele. No
 * canvas isso é o pior dos dois mundos — o subagente não tem nó, então o usuário
 * não vê nada; não tem `ATELIER_TERMINAL_ID` próprio, então um `atelier ask`
 * disparado de dentro dele age como se fosse o pai; e morre com a sessão do pai,
 * levando junto o que descobriu.
 *
 * O hook `PreToolUse` já bloqueia o `Task` e devolve o caminho certo na razão da
 * recusa. Esta doutrina é a outra metade: ela chega ANTES do erro, para o agente
 * já começar a sessão sabendo onde a equipe dele mora.
 *
 * ─── Duas fontes para o texto, de propósito ───
 *
 * A recusa curta vive no `resources/atelier.cjs`, porque um bloqueio não pode
 * depender de o app responder — se o socket estiver mudo, o Artesão tem que
 * continuar Artesão. A doutrina longa vive aqui, porque ela precisa do canvas:
 * quem já está cabeado, quantas vagas de terminal sobram. Cada lado aponta para
 * o outro no comentário; mudar um sem olhar o outro é como eles divergem.
 *
 * ─── Idioma ───
 *
 * Inglês, como todo texto que um agente lê neste repositório (o SKILL.md, as
 * respostas do CLI, as instruções do Scanner). A interface é que é em português.
 *
 * Módulo puro e sem `electron`: o teste o alcança direto.
 */

/**
 * A versão de seis linhas, para abrir o `atelier list` de um Artesão.
 *
 * Existe por causa dos agentes que NÃO são Claude Code. Neles não há
 * `SessionStart` que injete a doutrina nem hook que bloqueie o subagente: o que
 * há é o CLI, e `list` é o comando que todo agente roda antes de delegar. Pôr o
 * cabeçalho ali entrega a regra no instante em que ela decide alguma coisa.
 *
 * Curto de propósito. `list` é chamado o tempo todo, e despejar a doutrina
 * inteira a cada chamada afogaria a resposta que o agente foi buscar — a versão
 * completa é a do `atelier artesao brief`.
 */
export function artisanBanner(): string {
  return [
    'You are an ARTISAN: delegate by opening NODES on this canvas, never as',
    'subagents inside your own session — a subagent has no node, so the user',
    'cannot watch it, and it dies with your session.',
    '',
    '  atelier recruit "Name" --model haiku|sonnet   open one, cabled to you',
    '  atelier ask "Name" "the task"                 hand the work over',
    '  atelier dismiss "Name"                        close it when it is done',
    '',
    "Run 'atelier artesao brief' for the full briefing."
  ].join('\n')
}

export interface ArtisanContext {
  /** Nomes dos agentes já cabeados ao Artesão. */
  peers: string[]
  /** Quantos terminais ainda cabem neste canvas antes do teto do `recruit`. */
  slotsLeft: number
  /** Quadros de TODO cabeados, se houver. */
  boards: string[]
}

/** O corpo fixo — o "o quê" e o "porquê", que não dependem do canvas. */
const BODY = `You are an ARTISAN on this Atelier canvas.

You delegate by opening agents as NODES on the canvas, never as subagents inside
your own session. Internal subagents are turned off for this terminal: the Task
tool is denied here, and trying it costs you a turn.

Why the canvas and not a subagent: a node has a face. The user watches it work,
reads its screen, interrupts it, and picks it back up after a crash. A subagent
has none of that — it is invisible, it borrows YOUR identity on the atelier CLI,
it burns YOUR context window, and it dies with your session.

How to delegate:

  atelier list                                  who is already here
  atelier recruit "Name" --model haiku|sonnet   a node, already cabled to you
  atelier ask "Name" "the task"                 hand it over, wait for the answer
  atelier check "Name" 40                       read its screen, do not re-ask
  atelier dismiss "Name"                        close it when the work is done

Rules of the workshop:

- Reuse before you recruit. Run \`atelier list\` first, every time: an agent whose
  role already covers the work is better than a second one that duplicates it.
- One recruit, one scope. Write the task as if the recruit could not see your
  context — it cannot. Name the files, the goal, and what "done" looks like.
- Pick the cheapest model that can do the work. The ladder is in the \`atelier\`
  skill; do not escalate out of caution.
- Do it yourself when splitting costs more than doing. Recruiting is for work
  that can genuinely advance in parallel, or that needs separate context.
- \`ask\` blocks until the other agent goes idle. If it times out, run \`check\` —
  re-sending the prompt interrupts an agent that is still working.
- Dismiss what you opened once its work is verified, so the canvas stays legible.`

/**
 * A doutrina com o estado do canvas no fim.
 *
 * O bloco vivo vai DEPOIS das regras, e não antes: é o que muda a cada sessão, e
 * lê-lo sem as regras não diz nada. Cada linha só aparece quando tem conteúdo —
 * "Connected agents: (none)" é ruído, e um canvas vazio já se explica sozinho.
 */
export function artisanDoctrine(ctx: ArtisanContext): string {
  const lines = [BODY, '', 'On this canvas right now:']

  lines.push(
    ctx.peers.length > 0
      ? `- Already cabled to you: ${ctx.peers.join(', ')}. Consider them before recruiting.`
      : '- Nobody is cabled to you yet. Everyone you recruit arrives connected.'
  )

  if (ctx.boards.length > 0) {
    lines.push(
      `- Board${ctx.boards.length > 1 ? 's' : ''} cabled to you: ${ctx.boards.join(', ')}.`,
      '  Move a card when you pick it up and when it is actually done — that board',
      '  is how the user watches the work without asking you.'
    )
  }

  // O teto é do `recruit`, não do canvas: criar terminal na mão continua livre.
  // Dizer o número evita o Artesão descobrir o limite batendo nele no meio de um
  // plano de cinco recrutamentos.
  lines.push(
    ctx.slotsLeft > 0
      ? `- ${ctx.slotsLeft} more terminal${ctx.slotsLeft > 1 ? 's' : ''} can be recruited here before the ceiling.`
      : '- The recruit ceiling for this canvas is reached. Dismiss a finished agent, or ask the user to remove one, before recruiting again.'
  )

  return lines.join('\n')
}
