/**
 * `atelier ask "Agent" "prompt"` — porte de AskHandler.swift.
 *
 * Escreve o prompt no PTY do destinatário e bloqueia até ele PARAR — e a graça
 * do M7 é que "parar" agora tem três desfechos diferentes, que antes eram um só:
 *
 *   • o agente terminou            → exit 0, a resposta dele
 *   • o agente parou para PEDIR    → exit 3, dizendo o que ele pede
 *   • o tempo acabou e ele trabalha → exit 2, e a resposta é parcial
 *
 * Antes, os três saíam com exit 0, e o do meio era indistinguível do primeiro.
 * Pior: como um TUI animado nunca fica 2s calado, o desfecho NORMAL de um
 * agente Claude Code trabalhando era o terceiro — `ask` estourava o timeout
 * SEMPRE, e com exit 0, o que treinava quem chama a ignorar o código de saída.
 */
import type { AgentLifecycle, UUID } from '@shared/types'
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

  const output = await waitForStop(target.id, baseline, prompt)
  if (connection) setConnectionStatus(connection.id, 'idle')

  return output || '(agent produced no output)'
}

/**
 * As linhas que dizem ao CLI com que código sair.
 *
 * O protocolo do socket carrega TEXTO, e só. Em vez de alargá-lo para um campo
 * de status — que obrigaria a atualizar o `atelier` já instalado no PATH de
 * todo mundo — o desfecho viaja como a ÚLTIMA linha da resposta, num formato
 * que ninguém escreve por acaso.
 *
 * Estas constantes têm um par literal em resources/atelier.cjs, e
 * scripts/test-ask.mjs falha se as duas se separarem: um CLI que deixe de
 * reconhecer a linha volta a sair com 0 em silêncio, que é exatamente o defeito
 * que isto conserta.
 */
export const ASK_TIMEOUT_LINE = '[atelier: timed out — agent still working]'
export const ASK_WAITING_LINE = '[atelier: agent stopped and is asking the user]'

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
 * Espera o agente PARAR — de qualquer um dos jeitos. Sonda a cada 250 ms:
 * barato, e a condição de parada muda em escala de segundos.
 *
 * Sair por `waiting` é a diferença que paga o M7. Antes, um agente que parava
 * num diálogo de permissão prendia quem chamou até o timeout inteiro, e
 * devolvia exit 0 com uma tela de diálogo no corpo — o coordenador lia aquilo
 * como resposta e seguia em frente. Agora ele volta na hora, dizendo o que
 * falta.
 */
async function waitForStop(id: UUID, baseline: number, prompt: string): Promise<string> {
  const deadline = Date.now() + Constants.askResponseTimeoutMs
  // Dá tempo do agente começar a responder antes de medir a parada
  await sleep(400)

  let state: AgentLifecycle = 'working'
  let asked: string | null = null
  while (Date.now() < deadline) {
    const now = terminals.agentState(id)
    state = now.state
    asked = now.waiting?.detail ?? null
    if (state !== 'working') break
    await sleep(250)
  }

  const session = terminals.get(id)
  if (!session) return 'error: agent terminal disappeared'

  const body = stripPrompt(session.buffer.slice(baseline), prompt)

  // A linha-sentinela é sempre a ÚLTIMA: é assim que o CLI a acha sem se
  // arriscar a confundi-la com uma linha da resposta do agente.
  if (state === 'waiting') {
    return [
      body,
      '',
      asked ? `It is asking: ${asked}` : 'It did not say what it is asking.',
      'Answer in the node — another ask would interrupt it, not unblock it.',
      ASK_WAITING_LINE
    ].join('\n')
  }

  if (Date.now() >= deadline) {
    return [
      body,
      '',
      `No answer after ${Constants.askResponseTimeoutMs / 1000}s, and it is still working.`,
      "Use 'atelier check' to watch it. Do NOT ask again — that interrupts it.",
      ASK_TIMEOUT_LINE
    ].join('\n')
  }

  return body
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
