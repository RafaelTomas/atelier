/**
 * Onde um nó criado pelo main nasce: perto de quem o pediu, e num lugar VAZIO.
 *
 * Extraído do portal-spawn quando o `atelier recruit` passou a criar terminais
 * pelo mesmo caminho. A regra é a mesma para todos e não depende do tipo do
 * nó — o que muda é só o tamanho, que entra por parâmetro.
 *
 * A busca era uma cascata diagonal de 12 tentativas que, esgotada, devolvia a
 * 13ª posição SEM testar sobreposição. Num canvas povoado isso empilhava: o nó
 * novo nascia invisível debaixo de outro. Apareceu quando o `atelier node`
 * passou a criar vários nós seguidos para montar um canvas — cinco comandos, e
 * três nós em cima de vizinhos.
 *
 * O que existe no lugar é uma busca em ANÉIS ao redor do ponto preferido, na
 * ordem em que se lê o canvas: primeiro a coluna à direita, depois a fileira
 * abaixo, depois a esquerda, depois acima. O primeiro retângulo livre ganha.
 * Assim o nó cai perto — um "vazio" a 2000px de distância é geometricamente
 * correto e inútil para quem está olhando.
 */
import type { CanvasNode, Rect } from '@shared/types'
import { dockedFrame, type DockSide } from '@shared/dock'
import type { WorkspaceManager } from './state/workspace-manager'

/** Folga entre o pai e o filho. */
const GAP = 60

/** Passo da malha de busca. Igual ao grid do canvas ×2,5 — encosta sem colar. */
const STEP = 40

/** Até onde procurar antes de desistir: 40 anéis × 40px ≈ 1600px de raio. */
const MAX_RINGS = 40

interface Size {
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

function collides(taken: Rect[], at: Point, size: Size): boolean {
  return taken.some(
    (r) =>
      at.x < r.x + r.width &&
      at.x + size.width > r.x &&
      at.y < r.y + r.height &&
      at.y + size.height > r.y
  )
}

/**
 * Os pontos a distância de Chebyshev `r` do centro, em passos da malha, na
 * ordem de leitura: lado DIREITO primeiro, depois a base, depois a esquerda,
 * por fim o topo — e, dentro de cada lado, do MEIO para as pontas.
 *
 * As duas ordens importam, e a segunda foi um defeito. Varrendo o lado direito
 * de cima para baixo, o primeiro ponto livre de um anel largo é a quina de
 * CIMA: o nó novo aparecia na diagonal superior, não ao lado de quem o pediu.
 * Do meio para as pontas, o vizinho direto ganha, que é o que alguém olhando o
 * canvas espera.
 *
 * Trocar isso muda o layout de todo canvas montado por agente — é decisão de
 * produto, não detalhe de implementação.
 */
function* ringOffsets(r: number): Generator<[number, number]> {
  if (r === 0) {
    yield [0, 0]
    return
  }
  // Do meio para as pontas: 0, -1, 1, -2, 2, … até ±r.
  const doMeio: number[] = [0]
  for (let d = 1; d <= r; d++) doMeio.push(-d, d)

  for (const dy of doMeio) yield [r, dy]
  for (const dx of doMeio) if (Math.abs(dx) !== r) yield [dx, r]
  for (const dy of doMeio) if (Math.abs(dy) !== r) yield [-r, dy]
  for (const dx of doMeio) if (Math.abs(dx) !== r) yield [dx, -r]
}

/**
 * O primeiro ponto livre a partir de `preferred`, ou null se nem o raio máximo
 * bastar. PURA: recebe retângulos, devolve ponto — é o que a torna testável
 * sem canvas, sem workspace e sem Electron.
 */
export function firstFreeSpot(taken: Rect[], preferred: Point, size: Size): Point | null {
  for (let r = 0; r <= MAX_RINGS; r++) {
    for (const [dx, dy] of ringOffsets(r)) {
      const at = { x: preferred.x + dx * STEP, y: preferred.y + dy * STEP }
      if (!collides(taken, at, size)) return at
    }
  }
  return null
}

/** O que já ocupa espaço no canvas. */
export function occupiedRects(ws: WorkspaceManager): Rect[] {
  return ws.nodes.map((n) => n.frame)
}

export function freeSpotRightOf(ws: WorkspaceManager, origin: CanvasNode, size: Size): Point {
  const taken = occupiedRects(ws)
  const preferred = { x: origin.frame.x + origin.frame.width + GAP, y: origin.frame.y }
  return firstFreeSpot(taken, preferred, size) ?? belowEverything(taken, preferred.x)
}

/**
 * O plano B quando nem o raio máximo tem vaga: abaixo do nó mais baixo do
 * canvas, onde nada pode haver. Longe e feio, mas nunca em cima de ninguém —
 * e um canvas que enche 1600px em todas as direções já pede a mão do usuário.
 *
 * Canvas vazio devolve a própria coluna: sem nós, não há nada abaixo de quê.
 */
function belowEverything(taken: Rect[], x: number): Point {
  let bottom = -Infinity
  for (const r of taken) bottom = Math.max(bottom, r.y + r.height)
  return { x, y: Number.isFinite(bottom) ? bottom + GAP : 0 }
}

/**
 * O que está em `at`, se algo estiver. É a resposta que uma recusa de `--at`
 * precisa dar: "ocupado" sem dizer por quem obriga o agente a adivinhar.
 */
export function nodeAt(ws: WorkspaceManager, at: Point, size: Size): CanvasNode | null {
  return (
    ws.nodes.find((n) =>
      collides([n.frame], at, size)
    ) ?? null
  )
}

/**
 * `--at x,y` para QUALQUER verbo que cria nó.
 *
 * Vivia dentro de handlers/node.ts, onde `node create` era o único caminho que
 * aceitava posição. O resto dos verbos — nota, tabela, imagem, quadro, cofre,
 * portal, editor, botão, recruit — nascia sempre ao lado do chamador, e um
 * agente montando um canvas tinha que criar e depois mover, um por um. Pior:
 * quatro deles (tabela, imagem, quadro, botão) calculavam o ponto na mão, como
 * `caller.x + width + 60`, sem passar por `firstFreeSpot` — então dois nós
 * seguidos nasciam NO MESMO lugar, um invisível debaixo do outro. Este módulo
 * é o único lugar onde essa decisão mora agora.
 */
export type AtFlag = Point | 'invalid' | null

/** `--under`, `--above`, `--left-of`, `--right-of` — o nome do vizinho e o lado. */
export interface DockFlag {
  side: DockSide
  name: string
}

export interface Placement {
  at: AtFlag
  dock: DockFlag | null
}

const DOCK_FLAGS: Record<string, DockSide> = {
  '--under': 'bottom',
  '--above': 'top',
  '--left-of': 'left',
  '--right-of': 'right'
}

/**
 * Tira `--at x,y` e os quatro de encaixe dos argumentos, devolvendo o resto
 * intacto — os handlers continuam lendo os posicionais como sempre.
 */
export function takePlacementFlags(args: string[]): { rest: string[]; placement: Placement } {
  const rest: string[] = []
  let at: AtFlag = null
  let dock: DockFlag | null = null
  for (let i = 0; i < args.length; i++) {
    const side = DOCK_FLAGS[args[i]]
    if (args[i] === '--at') {
      const raw = args[++i] ?? ''
      const parts = raw.split(',').map((p) => Number(p.trim()))
      at = parts.length === 2 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1] } : 'invalid'
    } else if (side) {
      dock = { side, name: args[++i] ?? '' }
    } else rest.push(args[i])
  }
  return { rest, placement: { at, dock } }
}

/** Compatibilidade: quem só quer o `--at`. */
export function takeAtFlag(args: string[]): { rest: string[]; at: AtFlag } {
  const { rest, placement } = takePlacementFlags(args)
  return { rest, at: placement.at }
}

export interface PlacementContext {
  /** Resolve o vizinho pelo nome, com a mesma busca do resto do handler. */
  find: (name: string) => CanvasNode | null
  displayName: (node: CanvasNode) => string
  /** Piso do TIPO do nó que está nascendo — ver core/node-sizes. */
  floor?: [number, number]
}

/**
 * O retângulo onde o nó novo vai nascer, ou a recusa a imprimir.
 *
 * Três caminhos, e a ordem é a da intenção mais explícita para a mais frouxa:
 *
 *   `--under "Nó"`  encaixa no vizinho: mesma LARGURA dele, a folga do arrasto,
 *                   alinhado pela borda esquerda. É o gesto do canvas escrito
 *                   como comando — e é o que faz a nota explicativa de um nó
 *                   nascer com a cara de legenda dele, em vez de um retângulo
 *                   de 260 solto embaixo de um terminal de 560.
 *   `--at x,y`      cai exatamente ali, e RECUSA se estiver ocupado.
 *   nada            primeiro vão livre ao lado de quem chamou.
 *
 * As duas recusas dizem QUEM está no caminho: "ocupado" sem nome obriga o
 * agente a adivinhar, e adivinhar no canvas do usuário é como se empilha.
 */
export function resolveFrame(
  ws: WorkspaceManager,
  origin: CanvasNode,
  size: Size,
  placement: Placement,
  ctx: PlacementContext
): { frame: Rect } | { error: string } {
  const { at, dock } = placement

  if (at && dock) {
    return { error: 'error: --at and --under/--above/--left-of/--right-of are two ways to say where. Pick one.' }
  }

  if (dock) {
    if (!dock.name) return { error: 'error: --under takes the name of the node to dock against.' }
    const alvo = ctx.find(dock.name)
    if (!alvo) {
      return {
        error: `error: '${dock.name}' not found. Name reaches what is cabled to you; anything else needs the 8-char id.`
      }
    }
    const frame = dockedFrame({ x: 0, y: 0, ...size }, alvo.frame, dock.side, ctx.floor ?? [0, 0])
    const ocupado = nodeAt(ws, frame, frame)
    if (ocupado && ocupado.id !== alvo.id) return { error: ocupadoMsg(ocupado, frame, ctx.displayName) }
    return { frame }
  }

  if (at === 'invalid') {
    return { error: 'error: --at takes two numbers, as in `--at 12400,8900`.' }
  }
  if (at) {
    const ocupado = nodeAt(ws, at, size)
    if (ocupado) return { error: ocupadoMsg(ocupado, { ...at, ...size }, ctx.displayName) }
    return { frame: { ...at, ...size } }
  }
  return { frame: { ...freeSpotRightOf(ws, origin, size), ...size } }
}

function ocupadoMsg(
  ocupado: CanvasNode,
  pedido: Rect,
  displayName: (node: CanvasNode) => string
): string {
  return [
    `error: (${Math.round(pedido.x)},${Math.round(pedido.y)}) is taken by '${displayName(ocupado)}'`,
    `(${ocupado.content.type}, ${ocupado.id.slice(0, 8)}) at`,
    `(${ocupado.frame.x},${ocupado.frame.y}) ${ocupado.frame.width}×${ocupado.frame.height}.`,
    'Run `atelier node map` for what is where, or drop the placement flag to let',
    'the canvas find a free spot next to this terminal.'
  ].join(' ')
}

/** Compatibilidade com quem ainda só posiciona por `--at`. */
export function resolveSpot(
  ws: WorkspaceManager,
  origin: CanvasNode,
  size: Size,
  at: AtFlag,
  displayName: (node: CanvasNode) => string
): { spot: Point } | { error: string } {
  const r = resolveFrame(ws, origin, size, { at, dock: null }, { find: () => null, displayName })
  return 'error' in r ? r : { spot: { x: r.frame.x, y: r.frame.y } }
}
