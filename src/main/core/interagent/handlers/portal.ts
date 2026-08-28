/**
 * `atelier portal <list|open|go|read|html|shot|close|map|click|type|key|scroll|wait|login>`
 * — o Portal visto pelo agente.
 *
 * O escopo é o mesmo das notas e dos agentes: só o que está LIGADO POR CABO ao
 * terminal chamador (connectedNodes, em ./context.ts). Um portal no outro canto
 * do canvas não existe para quem não está conectado a ele.
 *
 * `open` é a exceção deliberada: cria um portal novo e já conectado — como o
 * `note create` faz com notas.
 *
 * OS VERBOS QUE AGEM (`click`, `type`, `key`, `scroll`) EXIGEM PERMISSÃO por nó,
 * ligada pelo usuário no cabeçalho do portal — ver a Decisão C do
 * PLANO-controle-de-portal.md. Sem ela devolvem erro explicando como ligar, e
 * NUNCA abrem diálogo: o agente pode estar rodando sem ninguém olhando, e um
 * diálogo travaria o main. `map` e `wait` só leem, então passam sem permissão.
 */
import type { UUID } from '@shared/types'
import { portalPartition } from '@shared/types'
import { maskSecrets } from '@shared/vault'
import { normalizeURL } from '@shared/portal-url'
import { notifyRenderer } from '../../../ipc/notify'
import { nodeDisplayName } from '../../models/node-content'
import type { PortalTarget, WaitCondition } from '../../portal/portal-bridge'
import {
  knownKeys,
  portalClick,
  portalHTML,
  portalInfo,
  portalKey,
  portalMap,
  portalScroll,
  portalShot,
  portalText,
  portalType,
  portalWait
} from '../../portal/portal-bridge'
import { spawnPortal } from '../../portal/portal-spawn'
import { secretForPortal, valuesForPortal } from '../../vault/vault-manager'
import { connectedNodes, findConnectedNode, requireTerminalId, workspaceForTerminal } from './context'

const USAGE =
  'error: usage: atelier portal <list|open|go|read|html|shot|close|map|click|type|key|scroll|wait|login> …'

/**
 * Tudo que sai da PÁGINA para o agente passa por aqui.
 *
 * Um segredo digitado por `portal login` fica no DOM, e `read`, `html` e `map`
 * leem o DOM: sem esta passagem, o valor que o agente nunca recebeu voltaria
 * para ele no comando seguinte. Mascara-se contra os valores dos cofres ligados
 * AQUELE portal — poucos e conhecidos —, não contra o workspace inteiro.
 *
 * Isto substitui a ideia de "mascarar o value de campo password no map": a
 * árvore de acessibilidade não expõe o valor de um input de senha de forma
 * confiável, e um filtro por papel erraria nos dois sentidos. Mascarar pelo
 * valor conhecido acerta em `read`, `html` e `map` de uma vez.
 */
async function safeForAgent(portalNodeId: UUID, text: string): Promise<string> {
  const values = await valuesForPortal(portalNodeId)
  return values.length === 0 ? text : maskSecrets(text, values)
}

export async function handlePortal(args: string[], terminalId: UUID | null): Promise<string> {
  const tid = requireTerminalId(terminalId)
  if (!tid) return 'error: missing terminal ID'

  switch (args[1]) {
    case 'list':
      return listPortals(tid)
    case 'open':
      return openPortal(args, tid)
    case 'go':
      return goPortal(args, tid)
    case 'read':
      return readPortal(args, tid)
    case 'html':
      return htmlPortal(args, tid)
    case 'shot':
      return shotPortal(args, tid)
    case 'close':
      return closePortal(args, tid)
    case 'map':
      return mapPortal(args, tid)
    case 'click':
      return clickPortal(args, tid)
    case 'type':
      return typePortal(args, tid)
    case 'key':
      return keyPortal(args, tid)
    case 'scroll':
      return scrollPortal(args, tid)
    case 'wait':
      return waitPortal(args, tid)
    case 'login':
      return loginPortal(args, tid)
    default:
      return USAGE
  }
}

interface Found {
  id: UUID
  label: string
  controlEnabled: boolean
}

/** Alvo + erro padrão, repetido em quase todos os subcomandos. */
function target(tid: UUID, name: string | undefined): Found | string {
  if (!name) return USAGE
  const node = findConnectedNode(tid, name, 'portal')
  if (!node) return `error: portal '${name}' not found. Use 'atelier portal list'.`
  return {
    id: node.id,
    label: nodeDisplayName(node.content),
    controlEnabled: node.content.type === 'portal' && node.content.value.controlEnabled
  }
}

/**
 * O mesmo alvo, mas com a trava de escrita.
 *
 * A frase do erro é metade do recurso: um agente que só ouve "não pode" tenta
 * outro caminho, um agente que lê ONDE FICA O BOTÃO pede ao usuário e segue.
 */
function writable(tid: UUID, name: string | undefined): Found | string {
  const found = target(tid, name)
  if (typeof found === 'string') return found
  if (!found.controlEnabled) {
    return (
      `error: control is off for portal '${found.label}'. ` +
      'Ask the user to click the ⦾ button in that portal header to allow clicking and typing. ' +
      "Reading ('portal read', 'portal html', 'portal map', 'portal shot') works without it."
    )
  }
  return found
}

/** A trilha da Decisão C: ação sem rastro é ação que ninguém audita. */
function trail(nodeId: UUID, line: string): void {
  notifyRenderer('portal:action', { nodeId, line })
}

function listPortals(tid: UUID): string {
  const portals = connectedNodes(tid).filter((n) => n.content.type === 'portal')
  if (portals.length === 0) {
    return 'No connected portals.\nUse `atelier portal open <url>` to create one.'
  }
  const lines = ['Connected portals:']
  for (const node of portals) {
    const url = node.content.type === 'portal' ? node.content.value.currentURL : ''
    lines.push(`  ${nodeDisplayName(node.content)}  ${url}  (${node.id.slice(0, 8)})`)
  }
  return lines.join('\n')
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Qual sessão o portal novo vai usar. **Mesma origem, mesma sessão.**
 *
 * Um portal nasce com id novo, logo partição nova, logo DESLOGADO — e foi
 * exatamente assim que o primeiro `portal open` de uma página interna caiu na
 * tela de login enquanto o portal ao lado seguia autenticado. Herdar de
 * qualquer portal seria vazamento de sessão entre sites; herdar de um portal
 * conectado que já está NA MESMA ORIGEM é continuar a navegação que o usuário
 * começou. `--session` força um portal específico, `--shared` usa o pote comum.
 */
function sessionFor(
  tid: UUID,
  url: string,
  flags: Map<string, string>
): { partition?: string; note: string } {
  if (flags.has('shared')) return { partition: 'persist:atelier-portal', note: 'shared' }

  const named = flags.get('session')
  if (named) {
    const node = findConnectedNode(tid, named, 'portal')
    if (!node || node.content.type !== 'portal') return { note: `unknown portal '${named}', new session` }
    return { partition: portalPartition(node.content.value), note: `from '${nodeDisplayName(node.content)}'` }
  }

  const wanted = origin(url)
  for (const node of connectedNodes(tid)) {
    if (node.content.type !== 'portal') continue
    if (wanted && origin(node.content.value.currentURL) === wanted) {
      return {
        partition: portalPartition(node.content.value),
        note: `shared with '${nodeDisplayName(node.content)}'`
      }
    }
  }
  return { note: 'new' }
}

/** `--session "Portal"` e `--shared`, tirados dos argumentos posicionais. */
function takeFlags(args: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shared') flags.set('shared', '')
    else if (args[i] === '--session') flags.set('session', args[++i] ?? '')
    else rest.push(args[i])
  }
  return { rest, flags }
}

function openPortal(argv: string[], tid: UUID): string {
  const { rest: args, flags } = takeFlags(argv)
  if (args.length < 3) {
    return 'error: usage: atelier portal open <url> [name] [--session "Portal" | --shared]'
  }
  // A mesma normalização da barra de endereço: `localhost:5173` é o que o
  // agente vai digitar, e tem que funcionar.
  const url = normalizeURL(args[2])
  if (!url) return 'error: empty url'

  const session = sessionFor(tid, url, flags)
  const spawned = spawnPortal({ originId: tid, url, name: args[3], partition: session.partition })
  if (!spawned) return 'error: calling terminal is not on this canvas'

  const name = args[3] ?? 'Portal'
  return `Opened portal '${name}' at ${url}, connected to this terminal (session: ${session.note}).`
}

async function goPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  if (args.length < 4) return 'error: usage: atelier portal go "Portal" <url>'

  const url = normalizeURL(args[3])
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  // Escreve o conteúdo, não o webview: o nó pode estar desmontado, e ao montar
  // ele já nasce com o src certo — mesmo caminho da barra de endereço.
  ws.updateContent(found.id, (node) => {
    if (node.content.type !== 'portal') return
    node.content.value.currentURL = url
    node.content.value.source = { kind: 'url', url }
  })
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `'${found.label}' navigating to ${url}.`
}

async function readPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found

  try {
    const text = await portalText(found.id)
    const offset = Number(args[3])
    const limit = Number(args[4])
    // offset/limit em LINHAS, igual ao `note read` — não inventar convenção nova
    if (Number.isFinite(offset) && Number.isFinite(limit)) {
      return safeForAgent(found.id, text.split('\n').slice(offset, offset + limit).join('\n'))
    }
    return safeForAgent(found.id, text)
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function htmlPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  try {
    return await safeForAgent(found.id, await portalHTML(found.id, args[3]))
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function shotPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  try {
    const file = await portalShot(found.id, ws.id, args[3])
    const info = await portalInfo(found.id)
    // Caminho, não base64: o agente abre a imagem com a ferramenta dele, e o
    // terminal não engasga com um blob de dois megabytes.
    return `Captured '${info.title || found.label}' to ${file}`
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function closePortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found
  const ws = workspaceForTerminal(tid)
  if (!ws) return 'error: no active workspace'

  ws.removeNode(found.id)
  notifyRenderer('workspace:changed', { workspaceId: ws.id })
  return `Closed portal '${found.label}'.`
}

// ─── Controle: mapear e agir ─────────────────────────────────────────────────

/**
 * O alvo de um verbo: `7` (ref do último mapa) ou `--selector "…"`.
 *
 * A ref é o caminho normal (Decisão B: o rótulo que o usuário vê sobrevive ao
 * build, a classe do bundler não). O seletor continua aceito para quem já sabe
 * exatamente o que quer.
 */
function pickTarget(args: string[], from: number): PortalTarget | string {
  const at = args.indexOf('--selector')
  if (at >= 0) {
    const selector = args[at + 1]
    if (!selector) return 'error: --selector needs a CSS selector'
    return { selector }
  }
  const ref = Number(args[from])
  if (!Number.isInteger(ref) || ref < 1) {
    return "error: expected a ref number from 'atelier portal map', or --selector \"…\""
  }
  return { ref }
}

/** Só os posicionais: as flags saem para não virarem texto ou ref por acidente. */
function withoutFlags(args: string[]): string[] {
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--selector') i++
    else if (!args[i].startsWith('--')) rest.push(args[i])
  }
  return rest
}

async function mapPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found

  try {
    const map = await portalMap(found.id, args.includes('--all'))
    if (map.entries.length === 0) {
      return (
        `No interactive elements found on '${map.title || found.label}'.\n` +
        (map.offscreen > 0
          ? `${map.offscreen} are off-screen — try 'atelier portal map "${args[2]}" --all'.`
          : "The page may still be loading; try 'atelier portal wait --idle' first.")
      )
    }

    const width = String(map.entries.length).length + 2
    const lines = [
      `Interactive elements on '${map.title || found.label}' (map #${map.generation}):`
    ]
    for (const e of map.entries) {
      const label = e.label ? `"${e.label}"` : '(no label)'
      const value = e.value ? ` value="${e.value}"` : ''
      const states = e.states.length ? `  ${e.states.join(' ')}` : ''
      lines.push(`${String(e.ref).padStart(width)}  ${e.role.padEnd(9)} ${label}${value}${states}`)
    }

    // O que ficou de fora é dito, nunca omitido — um mapa que esconde metade da
    // página faz o agente concluir que o botão não existe.
    if (map.offscreen > 0 && !args.includes('--all')) {
      lines.push(`\n${map.offscreen} more are off-screen; add --all to list them.`)
    }
    if (map.truncated) lines.push('The page has more interactive elements than this listing shows.')
    if (map.iframes > 0) {
      lines.push(
        `\nThis page has ${map.iframes} iframe(s). The map only covers the main frame — ` +
          'anything inside them is not listed and cannot be clicked by ref.'
      )
    }
    lines.push(`\nRefs are valid until the page navigates. Use 'atelier portal click "${args[2]}" <ref>'.`)
    return safeForAgent(found.id, lines.join('\n'))
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function clickPortal(args: string[], tid: UUID): Promise<string> {
  const found = writable(tid, args[2])
  if (typeof found === 'string') return found
  const what = pickTarget(args, 3)
  if (typeof what === 'string') return what

  try {
    const kind = args.includes('--right') ? 'right-click' : args.includes('--double') ? 'double-click' : 'click'
    const result = await portalClick(found.id, what, {
      right: args.includes('--right'),
      double: args.includes('--double')
    })
    trail(found.id, `${kind} → ${result.label}`)
    return `Clicked ${result.label} on '${found.label}' — ${result.change}.`
  } catch (err) {
    trail(found.id, `click falhou — ${(err as Error).message}`)
    return `error: ${(err as Error).message}`
  }
}

async function typePortal(args: string[], tid: UUID): Promise<string> {
  const found = writable(tid, args[2])
  if (typeof found === 'string') return found
  const what = pickTarget(args, 3)
  if (typeof what === 'string') return what

  // Com --selector o texto é o primeiro posicional depois do nome; com ref é o
  // segundo. `withoutFlags` deixa os dois casos no mesmo lugar.
  const positional = withoutFlags(args.slice(2))
  const text = 'selector' in what ? positional[1] : positional[2]
  if (text === undefined) {
    return 'error: usage: atelier portal type "Portal" <ref|--selector S> <text> [--clear] [--enter] [--keys]'
  }

  try {
    const result = await portalType(found.id, what, text, {
      enter: args.includes('--enter'),
      keys: args.includes('--keys'),
      clear: args.includes('--clear')
    })
    trail(found.id, `type "${text}" → ${result.label}`)
    return `Typed into ${result.label} on '${found.label}' — ${result.change}.`
  } catch (err) {
    trail(found.id, `type falhou — ${(err as Error).message}`)
    return `error: ${(err as Error).message}`
  }
}

/**
 * `atelier portal login "Portal" <ref|--selector S> --vault "Cofre" --key K [--enter]`
 *
 * O terceiro caminho de uso de um segredo, ao lado do env do PTY e do
 * `atelier vault get` — e o único em que o valor é USADO sem passar pelo agente.
 * Quem digita é o main, por CDP (`Input.insertText`), que entra pelo motor do
 * navegador e não pelo JS da página nem pelo renderer.
 *
 * As travas moram no `secretForPortal` (cabo até o portal, `origin` declarada,
 * origem batendo com a da página). Aqui ficam as duas que são desta camada:
 * `writable()`, o mesmo ⦾ de `click` e `type`, e a trilha SEM o valor — o
 * `trail` publica no renderer, e é por isso que esta linha não pode conter o
 * segredo, ao contrário do `type`, que ecoa o texto que o agente já tinha.
 */
async function loginPortal(args: string[], tid: UUID): Promise<string> {
  const found = writable(tid, args[2])
  if (typeof found === 'string') return found

  const vaultName = flagValue(args, '--vault')
  const key = flagValue(args, '--key')
  if (!vaultName || !key) {
    return (
      'error: usage: atelier portal login "Portal" <ref|--selector "css"> ' +
      '--vault "Vault" --key KEY [--enter]'
    )
  }

  // Args COMPLETOS, como no `type`: é `pickTarget` quem procura o `--selector`,
  // e um array já sem flags esconderia dele justamente o que ele busca.
  const what = pickTarget(args, 3)
  if (typeof what === 'string') return what

  let pageURL: string
  try {
    pageURL = (await portalInfo(found.id)).url
  } catch (err) {
    return `error: ${(err as Error).message}`
  }

  const secret = await secretForPortal(tid, found.id, vaultName, key, pageURL)
  if (typeof secret === 'string') {
    trail(found.id, `login recusado — chave ${key}`)
    return secret
  }

  try {
    const result = await portalType(found.id, what, secret.value, {
      enter: args.includes('--enter'),
      clear: true
    })
    trail(found.id, `login → ${result.label} (chave ${key} do cofre "${secret.vault.label}")`)
    return `Filled ${result.label} on '${found.label}' from '${secret.vault.label}' — ${result.change}.`
  } catch (err) {
    trail(found.id, `login falhou — ${(err as Error).message}`)
    return `error: ${(err as Error).message}`
  }
}

/** Valor de uma flag `--nome valor`, ou null quando ausente. */
function flagValue(args: string[], flag: string): string | null {
  const at = args.indexOf(flag)
  if (at < 0) return null
  const value = args[at + 1]
  return value && !value.startsWith('--') ? value : null
}

async function keyPortal(args: string[], tid: UUID): Promise<string> {
  const found = writable(tid, args[2])
  if (typeof found === 'string') return found
  if (!args[3]) return `error: usage: atelier portal key "Portal" <${knownKeys()}>`

  try {
    const change = await portalKey(found.id, args[3])
    trail(found.id, `key ${args[3]}`)
    return `Sent ${args[3]} to '${found.label}' — ${change}.`
  } catch (err) {
    trail(found.id, `key falhou — ${(err as Error).message}`)
    return `error: ${(err as Error).message}`
  }
}

async function scrollPortal(args: string[], tid: UUID): Promise<string> {
  const found = writable(tid, args[2])
  if (typeof found === 'string') return found

  const direction = args.includes('--up')
    ? 'up'
    : args.includes('--top')
      ? 'top'
      : args.includes('--bottom')
        ? 'bottom'
        : 'down'

  // A ref é opcional aqui: sem ela rola o que está sob o centro da viewport.
  const positional = withoutFlags(args.slice(2))
  const hasRef = positional[1] !== undefined || args.includes('--selector')
  const what = hasRef ? pickTarget(args, 3) : null
  if (typeof what === 'string') return what

  try {
    const change = await portalScroll(found.id, what, { direction })
    trail(found.id, `scroll ${direction}`)
    return `'${found.label}': ${change}.`
  } catch (err) {
    trail(found.id, `scroll falhou — ${(err as Error).message}`)
    return `error: ${(err as Error).message}`
  }
}

/**
 * `wait` é leitura: não exige permissão.
 *
 * Sem ele o agente clica, lê antes da resposta chegar e conclui que o clique
 * falhou — é o erro que mais aparece em agente de navegador.
 */
async function waitPortal(args: string[], tid: UUID): Promise<string> {
  const found = target(tid, args[2])
  if (typeof found === 'string') return found

  let condition: WaitCondition = { kind: 'idle' }
  const textAt = args.indexOf('--text')
  const goneAt = args.indexOf('--gone')
  const msAt = args.indexOf('--ms')
  if (textAt >= 0) {
    if (!args[textAt + 1]) return 'error: --text needs something to look for'
    condition = { kind: 'text', text: args[textAt + 1] }
  } else if (goneAt >= 0) {
    const ref = Number(args[goneAt + 1])
    if (!Number.isInteger(ref)) return 'error: --gone needs a ref from the last map'
    condition = { kind: 'gone', ref }
  } else if (msAt >= 0) {
    const ms = Number(args[msAt + 1])
    if (!Number.isFinite(ms) || ms <= 0) return 'error: --ms needs a number of milliseconds'
    condition = { kind: 'ms', ms }
  }

  try {
    const result = await portalWait(found.id, condition)
    return `'${found.label}': ${result}.`
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}
