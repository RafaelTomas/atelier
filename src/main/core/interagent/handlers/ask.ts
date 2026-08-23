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
  terminals.write(target.id, prompt.replace(/\r?\n$/, '') + '\r')
  log.debug('ask', `prompt enviado a ${target.id.slice(0, 8)}: ${prompt.slice(0, 50)}`)

  const output = await waitForIdle(target.id, baseline)
  if (connection) setConnectionStatus(connection.id, 'idle')

  return output.trim() || '(agent produced no output)'
}

/**
 * Espera o agente parar de produzir saída. Sonda a cada 250 ms: barato e
 * suficiente, já que a condição de parada é temporal.
 */
async function waitForIdle(id: UUID, baseline: number): Promise<string> {
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
  const body = stripPrompt(fresh)

  return timedOut
    ? `${body}\n\n(timed out after ${Constants.askResponseTimeoutMs / 1000}s — agent may still be working; use 'atelier check')`
    : body
}

/** Remove o eco do próprio prompt e sequências ANSI. */
function stripPrompt(text: string): string {
  return stripAnsi(text)
    .split('\n')
    .slice(1) // primeira linha é o eco do prompt
    .join('\n')
    .trimEnd()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
