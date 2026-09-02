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
