/**
 * O que o agente consegue ver de dentro de um Portal.
 *
 * Tudo passa por `wakeGuest`: um portal fora da viewport ou com zoom abaixo do
 * congelamento não tem webview montado, e para um agente "não montado" é o mesmo
 * que não funcionar. Acordar sob demanda custa um processo pelo tempo da leitura
 * — contra N processos vivos o tempo todo (Decisão C do plano).
 *
 * NÃO EXISTE `eval` AQUI, DE PROPÓSITO. Executar JavaScript arbitrário numa
 * sessão autenticada, ainda mais com a partição herdada do popup, transforma um
 * prompt mal formulado em ação autenticada. Ler é o caso real: o agente quer ver
 * o que o usuário está vendo.
 *
 * DESDE O 2026-08-27-PLANO-controle-de-portal.md O AGENTE TAMBÉM AGE — e a frase acima
 * continua inteira. `map`/`click`/`type`/`key`/`scroll`/`wait` passam pelo CDP
 * (core/portal/portal-cdp.ts), que fala com o motor do navegador em vez de
 * injetar script na origem, e só rodam em portal com `controlEnabled` ligado
 * pelo usuário. `eval` segue fora, com ou sem permissão: a permissão libera
 * verbos fechados, não um interpretador.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { log } from '../logger'
import { paths } from '../persistence/paths'
import type { MapEntry } from './portal-cdp'
import { lookupRef, pointOf, rememberMap, send, waitForNetworkIdle } from './portal-cdp'
import { wakeGuest } from './portal-registry'

/** Teto do que volta para o terminal. Página grande vira scrollback inútil. */
const MAX_CHARS = 200_000

export interface PortalInfo {
  url: string
  title: string
  loading: boolean
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text
  return `${text.slice(0, MAX_CHARS)}\n\n[… truncado em ${MAX_CHARS} caracteres]`
}

/** Mensagem única para o caso "não consegui falar com este portal". */
function asleep(nodeId: UUID): Error {
  return new Error(
    `portal ${nodeId.slice(0, 8)} não respondeu: a página pode estar carregando, ou o nó foi removido do canvas`
  )
}

/** Texto visível da página — o que o usuário leria, não o HTML. */
export async function portalText(nodeId: UUID): Promise<string> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)

  const text = (await guest.executeJavaScript(
    'document.body ? document.body.innerText : ""'
  )) as string

  // PDF, imagem e afins são renderizados por um plugin do Chromium: há página,
  // mas não há DOM para ler. Dizer isso vale mais que devolver string vazia.
  if (!text || text.trim().length === 0) {
    const info = await portalInfo(nodeId)
    return `[sem texto legível em ${info.url} — se for PDF ou imagem, use 'atelier portal shot']`
  }
  return truncate(text)
}

/** HTML da página inteira, ou só do primeiro elemento que casar com o seletor. */
export async function portalHTML(nodeId: UUID, selector?: string): Promise<string> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)

  const code = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null })()`
    : 'document.documentElement.outerHTML'

  const html = (await guest.executeJavaScript(code)) as string | null
  if (html === null) throw new Error(`nenhum elemento casa com '${selector}'`)
  return truncate(html)
}

export async function portalInfo(nodeId: UUID): Promise<PortalInfo> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)
  return { url: guest.getURL(), title: guest.getTitle(), loading: guest.isLoading() }
}

/**
 * Captura em PNG. Devolve o CAMINHO, não base64: o agente lê a imagem com a
 * ferramenta dele, e o terminal não engasga com um blob de dois megabytes.
 */
export async function portalShot(
  nodeId: UUID,
  workspaceId: UUID,
  destination?: string
): Promise<string> {
  const guest = await wakeGuest(nodeId)
  if (!guest) throw asleep(nodeId)

  const image = await guest.capturePage()
  if (image.isEmpty()) throw new Error('a captura voltou vazia — o portal pode estar minimizado')

  let file = destination
  if (!file) {
    const dir = paths.shotsDir(workspaceId)
    await mkdir(dir, { recursive: true })
    file = join(dir, `${nodeId.slice(0, 8)}-${Date.now()}.png`)
  }

  await writeFile(file, image.toPNG())
  log.info('portal', `captura de ${nodeId.slice(0, 8)} em ${file}`)
  return file
}

// ─── Controle: mapa, verbos e espera ─────────────────────────────────────────

/**
 * Papéis que valem uma linha no mapa.
 *
 * A lista é fechada de propósito: um mapa que devolvesse tudo voltaria a ser
 * HTML cru com outro nome. São os papéis que respondem a clique ou digitação —
 * mais os primos óbvios dos do plano (`searchbox` é `textbox`, `menuitemradio`
 * é `menuitem`), que sairiam de fora por acidente de vocabulário, não de
 * intenção.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'textbox',
  'searchbox',
  'checkbox',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'option'
])

/** Estados que mudam a decisão do agente — o resto é ruído na linha. */
const REPORTED_STATES = ['selected', 'checked', 'expanded', 'pressed', 'disabled', 'required']

/**
 * Quantos candidatos do AX tree chegam a medir caixa.
 *
 * Cada medição é um round-trip de CDP; uma SPA grande tem centenas de nós
 * interativos e mapear todos custaria segundos para devolver uma lista que
 * ninguém lê. O corte é dito na saída, nunca escondido.
 */
const MAX_CANDIDATES = 300

export interface PortalMap {
  title: string
  url: string
  generation: number
  entries: (MapEntry & { rect: { x: number; y: number; w: number; h: number } })[]
  /** Quantos candidatos ficaram de fora por caírem fora da viewport. */
  offscreen: number
  truncated: boolean
  iframes: number
}

interface AXNode {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
}

function axText(field: { value?: unknown } | undefined): string {
  const v = field?.value
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

/** Quantos `<iframe>` a página tem — o mapa só cobre o frame principal. */
async function countIframes(nodeId: UUID): Promise<number> {
  try {
    const doc = await send<{ root: { nodeId: number } }>(nodeId, 'DOM.getDocument', { depth: 0 })
    const found = await send<{ nodeIds: number[] }>(nodeId, 'DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: 'iframe,frame'
    })
    return found.nodeIds.length
  } catch {
    return 0
  }
}

/**
 * A lista numerada dos elementos interativos (Decisão B).
 *
 * O endereçamento é por REFERÊNCIA DE ACESSIBILIDADE, não por seletor CSS:
 * numa SPA as classes vêm do bundler e não sobrevivem a um build, enquanto o
 * rótulo acessível é o mesmo texto que o usuário lê na tela. Trinta linhas
 * legíveis no lugar de 200 000 caracteres de HTML minificado.
 */
export async function portalMap(nodeId: UUID, all = false): Promise<PortalMap> {
  const info = await portalInfo(nodeId)

  const { nodes } = await send<{ nodes: AXNode[] }>(nodeId, 'Accessibility.getFullAXTree')
  const candidates = nodes.filter(
    (n) => !n.ignored && n.backendDOMNodeId && INTERACTIVE_ROLES.has(axText(n.role))
  )
  const truncated = candidates.length > MAX_CANDIDATES

  const metrics = await send<{
    cssLayoutViewport?: { clientWidth: number; clientHeight: number }
  }>(nodeId, 'Page.getLayoutMetrics')
  const vw = metrics.cssLayoutViewport?.clientWidth ?? 0
  const vh = metrics.cssLayoutViewport?.clientHeight ?? 0

  const entries: PortalMap['entries'] = []
  let offscreen = 0

  for (const node of candidates.slice(0, MAX_CANDIDATES)) {
    const backendNodeId = node.backendDOMNodeId as number
    let box: { model?: { content: number[] } }
    try {
      box = await send(nodeId, 'DOM.getBoxModel', { backendNodeId })
    } catch {
      // Nó já saiu do DOM entre a árvore e a medição: não é erro, é SPA.
      continue
    }
    const q = box.model?.content
    if (!q) continue

    const x = Math.min(q[0], q[2], q[4], q[6])
    const y = Math.min(q[1], q[3], q[5], q[7])
    const w = Math.max(q[0], q[2], q[4], q[6]) - x
    const h = Math.max(q[1], q[3], q[5], q[7]) - y
    if (w < 1 || h < 1) continue

    // Fora da viewport ainda é clicável (o `click` rola até lá), mas listar a
    // página inteira devolve o rodapé de uma SPA infinita. `--all` pede tudo.
    const visible = vw === 0 || (x + w > 0 && y + h > 0 && x < vw && y < vh)
    if (!visible) {
      offscreen++
      if (!all) continue
    }

    const states: string[] = []
    for (const prop of node.properties ?? []) {
      if (!REPORTED_STATES.includes(prop.name)) continue
      const value = prop.value?.value
      if (value === true) states.push(prop.name)
      else if (typeof value === 'string' && value !== 'false') states.push(`${prop.name}=${value}`)
    }

    entries.push({
      ref: entries.length + 1,
      backendNodeId,
      role: axText(node.role),
      label: axText(node.name),
      value: axText(node.value) || null,
      states,
      rect: { x, y, w, h }
    })
  }

  const generation = await rememberMap(nodeId, entries)
  return {
    title: info.title,
    url: info.url,
    generation,
    entries,
    offscreen,
    truncated,
    iframes: await countIframes(nodeId)
  }
}

/** Alvo de um verbo: uma ref do último mapa, ou um seletor CSS explícito. */
export type PortalTarget = { ref: number } | { selector: string }

/** `{ backendNodeId, label }` do alvo, seja ele ref ou seletor. */
async function resolveTarget(
  nodeId: UUID,
  target: PortalTarget
): Promise<{ backendNodeId: number; label: string }> {
  if ('ref' in target) {
    const entry = lookupRef(nodeId, target.ref)
    return {
      backendNodeId: entry.backendNodeId,
      label: entry.label ? `${entry.role} "${entry.label}"` : `${entry.role} #${entry.ref}`
    }
  }

  const doc = await send<{ root: { nodeId: number } }>(nodeId, 'DOM.getDocument', { depth: 0 })
  const found = await send<{ nodeId: number }>(nodeId, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: target.selector
  })
  if (!found.nodeId) throw new Error(`nenhum elemento casa com '${target.selector}'`)
  const described = await send<{ node: { backendNodeId: number } }>(nodeId, 'DOM.describeNode', {
    nodeId: found.nodeId
  })
  return { backendNodeId: described.node.backendNodeId, label: target.selector }
}

/**
 * O que mudou depois da ação.
 *
 * Existe para o agente saber se o clique surtiu efeito SEM gastar um `shot`:
 * URL nova e título novo são o sinal barato, e quando nenhum dos dois mudou
 * dizer isso também é informação.
 */
async function changeSince(
  nodeId: UUID,
  before: PortalInfo
): Promise<string> {
  // A troca de página não é instantânea; um respiro curto evita reportar
  // "nada mudou" na navegação que já começou.
  await sleep(250)
  const after = await portalInfo(nodeId).catch(() => before)
  const bits: string[] = []
  if (after.url !== before.url) bits.push(`URL agora ${after.url}`)
  if (after.title !== before.title) bits.push(`título agora '${after.title}'`)
  if (after.loading) bits.push('página carregando')
  return bits.length ? bits.join('; ') : 'sem mudança de URL ou título'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

export interface ClickOptions {
  right?: boolean
  double?: boolean
}

/**
 * Clique de verdade: `Input.dispatchMouseEvent` no centro da caixa.
 *
 * É o par pressionar/soltar que o Chromium entrega ao mesmo lugar que o mouse
 * do usuário — `isTrusted` verdadeiro, menu nativo abrindo, `<select>`
 * respondendo. Um `el.click()` de script não faz nada disso (Decisão A).
 */
export async function portalClick(
  nodeId: UUID,
  target: PortalTarget,
  options: ClickOptions = {}
): Promise<{ label: string; change: string }> {
  const { backendNodeId, label } = await resolveTarget(nodeId, target)
  const before = await portalInfo(nodeId)
  const { x, y } = await pointOf(nodeId, backendNodeId)

  const button = options.right ? 'right' : 'left'
  const base = { x, y, button, buttons: options.right ? 2 : 1 }
  const rounds = options.double ? 2 : 1
  for (let i = 1; i <= rounds; i++) {
    await send(nodeId, 'Input.dispatchMouseEvent', {
      ...base,
      type: 'mousePressed',
      clickCount: i
    })
    await send(nodeId, 'Input.dispatchMouseEvent', {
      ...base,
      type: 'mouseReleased',
      clickCount: i
    })
  }

  return { label, change: await changeSince(nodeId, before) }
}

export interface TypeOptions {
  /** Tecla por tecla, para campo que só reage a `keydown` (máscara, autocomplete). */
  keys?: boolean
  enter?: boolean
  /** Apaga o que já estava no campo antes de escrever. */
  clear?: boolean
}

/**
 * Foca o campo e escreve. `Input.insertText` é o caminho rápido e correto.
 *
 * ATENÇÃO AO `--clear`: `insertText` escreve NO CURSOR, não no lugar do valor.
 * Num campo que já tem "tst", digitar "XYZ" deixa "XYZtst" — medido no spike da
 * Etapa 0. Quem quer substituir precisa selecionar tudo antes, e é isso que o
 * `clear` faz, pelo comando de edição nativo em vez de um Ctrl+A que depende do
 * sistema operacional.
 */
export async function portalType(
  nodeId: UUID,
  target: PortalTarget,
  text: string,
  options: TypeOptions = {}
): Promise<{ label: string; change: string }> {
  const { backendNodeId, label } = await resolveTarget(nodeId, target)
  const before = await portalInfo(nodeId)

  // Clicar antes de focar: campo de SPA costuma montar o editor real só no
  // clique, e `DOM.focus` sozinho escreveria num input que ainda não existe.
  const { x, y } = await pointOf(nodeId, backendNodeId)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send(nodeId, 'Input.dispatchMouseEvent', { x, y, button: 'left', buttons: 1, type, clickCount: 1 })
  }
  await send(nodeId, 'DOM.focus', { backendNodeId }).catch(() => {})

  if (options.clear) {
    await send(nodeId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      commands: ['selectAll']
    })
    await send(nodeId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
  }

  if (options.keys) {
    for (const ch of text) {
      await send(nodeId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await send(nodeId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  } else {
    await send(nodeId, 'Input.insertText', { text })
  }

  if (options.enter) await portalKey(nodeId, 'Enter')
  return { label, change: await changeSince(nodeId, before) }
}

/**
 * Teclas nomeadas.
 *
 * A tabela é fechada: `Input.dispatchKeyEvent` precisa do código virtual certo
 * para que a página reaja, e adivinhar a partir do nome erra em silêncio —
 * a tecla "chega" e nada acontece.
 */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
}

export function knownKeys(): string {
  return Object.values(KEYS)
    .map((k) => k.key.trim() || 'Space')
    .join(', ')
}

export async function portalKey(nodeId: UUID, name: string): Promise<string> {
  const spec = KEYS[name.toLowerCase()]
  if (!spec) throw new Error(`tecla '${name}' desconhecida. Conhecidas: ${knownKeys()}`)

  const before = await portalInfo(nodeId)
  const common = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode
  }
  await send(nodeId, 'Input.dispatchKeyEvent', {
    ...common,
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    ...(spec.text ? { text: spec.text } : {})
  })
  await send(nodeId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' })
  return changeSince(nodeId, before)
}

export interface ScrollOptions {
  direction: 'up' | 'down' | 'top' | 'bottom'
}

/** Um pulo de rolagem — meia tela, o mesmo que uma roda de mouse dá em três batidas. */
const SCROLL_STEP = 400
/** Quantas rodadas o `--top`/`--bottom` gasta antes de desistir. */
const SCROLL_TO_END = 24

/**
 * Rolagem por roda de mouse.
 *
 * Sem `Runtime` não existe `window.scrollTo`, e é bom que não exista: a roda
 * rola o container que está SOB O CURSOR, que é o que o usuário faria — numa
 * SPA com painel interno, `scrollTo` rolaria a página errada.
 */
export async function portalScroll(
  nodeId: UUID,
  target: PortalTarget | null,
  options: ScrollOptions
): Promise<string> {
  let at = { x: 0, y: 0 }
  if (target) {
    const { backendNodeId } = await resolveTarget(nodeId, target)
    at = await pointOf(nodeId, backendNodeId)
  } else {
    const metrics = await send<{
      cssLayoutViewport?: { clientWidth: number; clientHeight: number }
    }>(nodeId, 'Page.getLayoutMetrics')
    at = {
      x: (metrics.cssLayoutViewport?.clientWidth ?? 800) / 2,
      y: (metrics.cssLayoutViewport?.clientHeight ?? 600) / 2
    }
  }

  const toEnd = options.direction === 'top' || options.direction === 'bottom'
  const sign = options.direction === 'up' || options.direction === 'top' ? -1 : 1
  const rounds = toEnd ? SCROLL_TO_END : 1

  for (let i = 0; i < rounds; i++) {
    await send(nodeId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: at.x,
      y: at.y,
      deltaX: 0,
      deltaY: sign * SCROLL_STEP
    })
  }
  return toEnd
    ? `rolado até o ${options.direction === 'top' ? 'topo' : 'fim'}`
    : `rolado ${SCROLL_STEP}px para ${sign < 0 ? 'cima' : 'baixo'}`
}

export type WaitCondition =
  | { kind: 'idle' }
  | { kind: 'text'; text: string }
  | { kind: 'gone'; ref: number }
  | { kind: 'ms'; ms: number }

/** Teto absoluto: um `wait` que não termina trava o agente, não a página. */
export const WAIT_CEILING_MS = 30_000
/** Silêncio de rede que conta como "assentou". */
const IDLE_QUIET_MS = 500
/** Intervalo das condições que só dá para checar perguntando de novo. */
const POLL_MS = 250

export async function portalWait(nodeId: UUID, condition: WaitCondition): Promise<string> {
  if (condition.kind === 'ms') {
    const ms = Math.min(condition.ms, WAIT_CEILING_MS)
    await sleep(ms)
    return `esperou ${ms}ms`
  }

  if (condition.kind === 'idle') {
    const result = await waitForNetworkIdle(nodeId, IDLE_QUIET_MS, WAIT_CEILING_MS)
    return result === 'idle'
      ? 'a página assentou (sem tráfego de rede)'
      : `ainda havia tráfego depois de ${WAIT_CEILING_MS / 1000}s — siga com cautela`
  }

  const deadline = Date.now() + WAIT_CEILING_MS
  while (Date.now() < deadline) {
    if (condition.kind === 'text') {
      const text = await portalText(nodeId).catch(() => '')
      if (text.includes(condition.text)) return `'${condition.text}' apareceu na página`
    } else {
      const entry = lookupRef(nodeId, condition.ref)
      const still = await elementStillThere(nodeId, entry.backendNodeId)
      if (!still) return `ref ${condition.ref} sumiu da página`
    }
    await sleep(POLL_MS)
  }

  return condition.kind === 'text'
    ? `'${condition.text}' não apareceu em ${WAIT_CEILING_MS / 1000}s`
    : `ref ${condition.ref} ainda está na página depois de ${WAIT_CEILING_MS / 1000}s`
}

/** Nó removido do DOM não tem mais caixa — e `getBoxModel` erra em vez de mentir. */
async function elementStillThere(nodeId: UUID, backendNodeId: number): Promise<boolean> {
  try {
    const box = await send<{ model?: { content: number[] } }>(nodeId, 'DOM.getBoxModel', {
      backendNodeId
    })
    return !!box.model
  } catch {
    return false
  }
}
