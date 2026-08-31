/**
 * `atelier ask "Agent" "prompt"` — porte de AskHandler.swift.
 *
 * Escreve o prompt no PTY do destinatário e bloqueia até ele ficar ocioso
 * (sem saída nova por agentIdleTimeoutMs) ou estourar o timeout.
 */
import type { UUID } from '@shared/types'
import { Constants } from '../../constants'
import { log } from '../../logger'
import { nodeDisplayName } from '../../models/node-content'
import { stripAnsi, terminals } from '../../terminal/terminal-manager'
import { setConnectionStatus } from '../../connection/connection-manager'
import { findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

export async function handleAsk(args: string[], terminalId: UUID | null): Promise<string> {
  if (args.length < 3) return 'error: usage: atelier ask "TargetAgent" "prompt"'

  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  const [, targetName, prompt] = args
  const target = findConnectedNode(tid, targetName, 'terminal')
  if (!target) {
    return `error: agent '${targetName}' not found. Use 'atelier list' to see connected agents.`
  }

  const session = terminals.get(target.id)
  if (!session || session.exited) {
    return `error: agent '${nodeDisplayName(target.content)}' has no running terminal.`
  }

  const ws = workspaceForTerminal(tid)
  const connection = ws
    ?.connectionsFor(tid)
    .find((c) => c.nodeIdA === target.id || c.nodeIdB === target.id)

  if (connection) setConnectionStatus(connection.id, 'communicating')
  terminals.markActiveTask(target.id)

  const baseline = session.buffer.length
  await writePrompt(target.id, prompt)
  log.debug('ask', `prompt enviado a ${target.id.slice(0, 8)}: ${prompt.slice(0, 50)}`)

  const output = await waitForIdle(target.id, baseline, prompt)
  if (connection) setConnectionStatus(connection.id, 'idle')

  return output.trim() || '(agent produced no output)'
}

/**
 * Pausa entre o texto e o Enter. Mesmo valor do comando inicial do PTY
 * (terminal-manager.spawn), pela mesma razão: dar ao programa do outro lado um
 * ciclo de leitura antes da próxima tecla.
 */
const ENTER_DELAY_MS = 300

/**
 * Escreve o prompt e MANDA O ENTER SEPARADO — nunca `texto + '\r'` num write só.
 *
 * O TUI de um agente (Claude Code, Codex) classifica como COLAGEM todo bloco
 * que chega grande e de uma vez, e uma colagem vira um anexo no campo de
 * entrada (`[Pasted text #1 +13 lines]`) em vez de virar tecla por tecla. O
 * `\r` que vem grudado no mesmo bloco entra nessa mesma colagem e não é lido
 * como "enviar": o prompt fica parado no input, o agente segue ocioso, e o
 * `ask` volta com `(agent produced no output)` — o que parece o agente ter
 * ignorado a mensagem, quando ele nunca a recebeu.
 *
 * Não é questão de quebras de linha: um prompt de UMA linha só, longo, é
 * classificado do mesmo jeito. O que separa uma tecla de uma colagem é o
 * pedaço em que ela chega.
 *
 * Num shell puro os dois caminhos dão no mesmo — daí isto ter passado tanto
 * tempo despercebido.
 */
async function writePrompt(id: UUID, prompt: string): Promise<void> {
  terminals.write(id, prompt.replace(/\r?\n$/, ''))
  await sleep(ENTER_DELAY_MS)
  terminals.write(id, '\r')
}

/**
 * Espera o agente parar de produzir saída. Sonda a cada 250 ms: barato e
 * suficiente, já que a condição de parada é temporal.
 */
async function waitForIdle(id: UUID, baseline: number, prompt: string): Promise<string> {
  const deadline = Date.now() + Constants.askResponseTimeoutMs
  // Dá tempo do agente começar a responder antes de medir ociosidade
  await sleep(400)

  while (Date.now() < deadline) {
    if (terminals.isIdle(id)) break
    await sleep(250)
  }

  const session = terminals.get(id)
  if (!session) return 'error: agent terminal disappeared'

  const fresh = session.buffer.slice(baseline)
  const timedOut = Date.now() >= deadline
  const body = stripPrompt(fresh, prompt)

  return timedOut
    ? `${body}\n\n(timed out after ${Constants.askResponseTimeoutMs / 1000}s — agent may still be working; use 'atelier check')`
    : body
}

/**
 * Remove o eco do próprio prompt e sequências ANSI.
 *
 * A versão anterior descartava a PRIMEIRA LINHA, o que pressupõe duas coisas
 * que quase nunca valem: que o buffer tem linhas de verdade, e que o eco cabe
 * em uma. Medido nos três presets que dá para rodar, a premissa falhou nos três
 * — com gravidades diferentes, e é por isso que passou tanto tempo de pé:
 *
 *   • claude_code — o TUI redesenha a tela inteira sem `\n`, então tudo colapsa
 *     em UMA linha e `slice(1)` levava a resposta junto: `ask` voltava com
 *     `(agent produced no output)` mesmo com o agente tendo respondido na tela.
 *   • codex — emite `\n` entre os blocos, então sobrevivia, mas com a moldura.
 *   • generic_shell — o único caso em que a premissa vale, e só enquanto o eco
 *     couber na largura do terminal: um comando que sofre wrap ocupa duas linhas
 *     visuais e a segunda vazava para a resposta (um `wc -l ...injector.ts`
 *     devolvia `ts` grudado antes do número).
 *
 * Cortar pelo CONTEÚDO do eco em vez de por contagem de linhas resolve os três
 * sem ramificar por provedor — o que também vale para os presets que não temos
 * como instalar aqui (antigravity, opencode).
 */
function stripPrompt(text: string, prompt: string): string {
  return afterLastEcho(stripAnsi(text), prompt).replace(/^\s+/, '').trimEnd()
}

/**
 * Devolve o que veio DEPOIS da última aparição do prompt no texto.
 *
 * Comparação feita sem espaço nenhum dos dois lados: o TUI reflui o eco com a
 * largura que tem na hora, e o mesmo prompt aparece ora quebrado em três linhas,
 * ora numa só. Ignorar todo whitespace faz as duas formas casarem.
 *
 * A ÚLTIMA aparição, e não a primeira, porque um TUI reescreve o prompt a cada
 * redesenho — a resposta está depois da última cópia, não da primeira.
 *
 * Prefixos decrescentes para ACHAR o início, e subsequência para consumir o
 * resto: o redesenho parcial come caracteres (nos buffers do Claude o mesmo eco
 * saiu como `skill-injctor.ts` e `arquiv`), então casar o prompt inteiro só
 * acerta as cópias íntegras — que costumam ser as PRIMEIRAS, justamente as que
 * não interessam. Como a corrupção OMITE caracteres e nunca inventa, o eco
 * continua sendo uma subsequência do prompt, e é assim que o consumimos.
 *
 * Se nem o prefixo mais curto casar, devolvemos o texto inteiro: sujo é
 * recuperável, vazio não.
 */
function afterLastEcho(text: string, prompt: string): string {
  const dense: number[] = []
  let hay = ''
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i])) {
      hay += text[i]
      dense.push(i)
    }
  }

  const needle = prompt.replace(/\s+/g, '')
  if (!needle || hay === '') return text

  // O início mais TARDIO que qualquer prefixo encontrar: um TUI reescreve o
  // prompt a cada redesenho, e a resposta vem depois da última cópia.
  let start = -1
  for (const len of [needle.length, 60, 40, 24, 12]) {
    if (len > needle.length) continue
    const at = hay.lastIndexOf(needle.slice(0, len))
    if (at > start) start = at
  }
  if (start < 0) return text

  let h = start
  let n = 0
  while (h < hay.length && n < needle.length) {
    if (hay[h] === needle[n]) h++
    n++
  }
  return h > start ? text.slice(dense[h - 1] + 1) : text
}

/** Ponto de entrada do teste do extrator (scripts/test-ask.mjs). */
export const stripPromptForTest = stripPrompt

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
