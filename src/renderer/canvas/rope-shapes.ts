import type { Point, RopeStyleId } from '@shared/types'

export const ROPE_STYLES: { id: RopeStyleId; label: string; physics: boolean }[] = [
  // `dotted` é o traçado com que as conexões nasceram e segue sendo o padrão;
  // `rope` é a corda torcida. Os dois nomes já trocaram de dono uma vez — o
  // rótulo ao lado do id é o que evita a próxima confusão.
  { id: 'dotted', label: 'Pontilhada', physics: true },
  { id: 'rope', label: 'Corda', physics: true },
  { id: 'chain', label: 'Corrente', physics: true },
  { id: 'braid', label: 'Trança', physics: true },
  { id: 'cable', label: 'Cabo', physics: true },
  { id: 'circuit', label: 'Circuito', physics: false },
  { id: 'neon', label: 'Neon', physics: true },
  { id: 'line', label: 'Reta', physics: false }
]

/**
 * Traços EMPILHADOS de um desenho, do fundo para a frente.
 *
 * Corda, corrente e trança precisam disto; os outros cinco não. Uma corda de
 * fibra é sombra, borda, corpo, gomo e brilho; uma corrente são duas fileiras
 * de elos alternados; uma trança são dois fios que se cruzam. Nenhum deles
 * cabe num `stroke` só. Quem não está aqui continua sendo um path único, com a
 * className exata de antes, para não pagar por uma estrutura que não usa.
 */
/**
 * De onde sai o `d` de um traço.
 *
 * `center` é a corda que a física entrega. O resto é geometria DERIVADA dela:
 * um tracejado só sabe cortar o traço em ângulo reto, e nem corda torcida, nem
 * elo, nem trança têm um ângulo reto sequer. Todos eles precisam de um caminho
 * próprio, medido contra a tangente local.
 */
export type RopeGeometry =
  | 'center'
  | 'spiral'
  | 'chain-a'
  | 'chain-b'
  | 'braid-a'
  | 'braid-b'
  | 'braid-a-front'

export interface RopeLayer {
  name: string
  geometry: RopeGeometry
}

const LAYERED: Partial<Record<RopeStyleId, RopeLayer[]>> = {
  rope: [
    { name: 'shadow', geometry: 'center' },
    { name: 'core', geometry: 'center' },
    { name: 'body', geometry: 'center' },
    { name: 'ribs', geometry: 'spiral' },
    { name: 'sheen', geometry: 'spiral' }
  ],
  // Os elos alternam deitado/de perfil, e cada um é uma curva fechada. Sem
  // preenchimento, os contornos se cruzam na sobreposição — é assim que um
  // desenho de corrente diz "engatado" sem precisar recortar nada.
  // Sem traço `center` aqui: uma corrente é VAZADA entre os elos, e uma sombra
  // seguindo a linha do meio aparece como uma barra sólida ligando um elo ao
  // outro — exatamente o que a corrente não tem. A profundidade vem da fileira
  // de perfil, que é mais escura.
  chain: [
    { name: 'link-b', geometry: 'chain-b' },
    { name: 'link-a', geometry: 'chain-a' }
  ],
  /**
   * A ordem aqui É o trançado. O fio A inteiro, o fio B inteiro por cima, e
   * então SÓ a metade da frente do A de volta ao topo: onde A está na frente
   * ele cobre o B, onde está atrás continua coberto. Sem esse terceiro traço
   * um dos fios passaria sempre por cima e o desenho viraria dois riscos
   * paralelos ondulados.
   */
  braid: [
    { name: 'shadow', geometry: 'center' },
    { name: 'strand-a', geometry: 'braid-a' },
    { name: 'strand-b', geometry: 'braid-b' },
    { name: 'strand-a-front', geometry: 'braid-a-front' }
  ]
}

const SINGLE: RopeLayer[] = [{ name: '', geometry: 'center' }]

/** Um traço só, sem classe de camada, para os cinco desenhos simples. */
export function ropeLayers(style: RopeStyleId): RopeLayer[] {
  return LAYERED[style] ?? SINGLE
}

interface Walker {
  total: number
  /** Ponto, normal (tangente girada 90°) e tangente a `s` unidades do início. */
  at: (s: number) => { p: Point; n: Point; t: Point }
}

/**
 * Percorre a polilinha da física em COMPRIMENTO DE ARCO.
 *
 * Os três desenhos derivados dependem disto pela mesma razão: a corda chega em
 * segmentos de tamanhos diferentes, e um elo ou um gomo espaçado por ÍNDICE
 * ficaria apertado nas curvas e esticado nas retas. Espaçar por distância é o
 * que mantém o passo constante enquanto a corda balança.
 */
function walk(points: Point[]): Walker | null {
  if (points.length < 2) return null
  const acc: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  }
  const total = acc[acc.length - 1]
  if (total <= 0) return null

  return {
    total,
    at: (s) => {
      const dist = Math.min(Math.max(s, 0), total)
      let i = 1
      while (i < acc.length - 1 && acc[i] < dist) i++
      const a = points[i - 1]
      const b = points[i]
      const span = acc[i] - acc[i - 1] || 1
      const k = (dist - acc[i - 1]) / span
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      return {
        p: { x: a.x + dx * k, y: a.y + dy * k },
        n: { x: -dy / len, y: dx / len },
        t: { x: dx / len, y: dy / len }
      }
    }
  }
}

const f = (v: number): string => v.toFixed(2)

/**
 * Raio, passo e inclinação da hélice, em unidades de canvas.
 *
 * Casados à mão com `--rope-w: 10` do CSS, e a conta que importa é esta: o fio
 * é desenhado com traço GROSSO e ponta redonda, então ele já ocupa meia
 * espessura para cada lado do seu eixo. O raio é o quanto esse eixo passeia
 * para os lados — pequeno de propósito. Somar raio e meia espessura tem de dar
 * quase a metade do corpo: um pouco a menos deixa a corda reta demais, um
 * pouco a mais e o fio fura a borda e vira zíper.
 *
 * O passo é maior que a espessura do fio para sobrar o vão escuro entre um
 * gomo e o próximo — sem esse vão não há gomo, há um tubo liso.
 */
const RIB_RADIUS = 2
const RIB_PITCH = 7
/** Quanto o gomo avança enquanto cruza a corda — é o que dá o ângulo. */
const RIB_LEAN = 6.2

/**
 * Os gomos da corda: um traço diagonal por passo, cruzando o corpo de uma
 * borda à outra enquanto avança.
 *
 * Sai da polilinha da física, e não das duas âncoras, porque a diagonal tem de
 * ser medida contra a TANGENTE local — uma corda que balança e cai muda de
 * direção o tempo todo, e um ângulo fixo em tela viraria anel na parte de
 * baixo da curva.
 */
export function ropeSpiralPath(points: Point[], scale = 1): string {
  const w = walk(points)
  if (!w) return ''
  const { total, at } = w
  const radius = RIB_RADIUS * scale
  const pitch = RIB_PITCH * scale
  const lean = RIB_LEAN * scale

  let d = ''
  // Uma folga curta nas duas pontas: o gomo não nasce em cima da ponta redonda
  // do corpo (deixaria farpa para fora), mas a folga é pequena para a corda não
  // terminar num coto liso, que é o que denuncia o desenho de perto.
  const margin = pitch * 0.25
  for (let s = margin; s < total - lean - margin; s += pitch) {
    const start = at(s)
    const end = at(s + lean)
    const mid = at(s + lean / 2)
    const x0 = start.p.x - start.n.x * radius
    const y0 = start.p.y - start.n.y * radius
    const x1 = end.p.x + end.n.x * radius
    const y1 = end.p.y + end.n.y * radius
    // O controle no centro arqueia o gomo: é o que faz o fio parecer contornar
    // um cilindro em vez de cortar um retângulo.
    d += `M ${x0.toFixed(2)} ${y0.toFixed(2)} Q ${mid.p.x.toFixed(2)} ${mid.p.y.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)} `
  }
  return d.trim()
}

/**
 * CORRENTE — o passo é MENOR que o elo, de propósito: é a sobreposição que
 * engata um no outro. Elos encostados ponta com ponta seriam contas de colar.
 */
const LINK_HALF = 5.8
const LINK_PITCH = 7.8
/**
 * Deitado mostra o furo; de perfil é quase uma barra. A alternância é a
 * corrente.
 *
 * A razão comprimento/largura é o que mais decide se o desenho lê como
 * corrente: perto de 1 o elo vira anel, e uma fileira de anéis é colar. Elo de
 * verdade é alongado — daqui saem uns 2,6 para 1.
 */
const LINK_WIDE = 2.2
const LINK_EDGE = 0.78

/**
 * Um elo: contorno FECHADO em volta do ponto, alongado na tangente, com
 * LATERAIS RETAS e as duas pontas em meia-volta.
 *
 * A lateral reta é o detalhe que faz a corrente parecer corrente. Uma elipse
 * curva o tempo todo e o olho lê bolha; elo de metal é reto no meio e só dobra
 * nas pontas, que é onde ele abraça o vizinho.
 *
 * Fechado e sem preenchimento porque é o contorno que engata: onde dois elos se
 * sobrepõem, os dois contornos aparecem cruzados, que é exatamente como se
 * desenha corrente à mão.
 */
function link(p: Point, t: Point, n: Point, half: number, wide: number): string {
  // O trecho reto é o que sobra do comprimento depois das duas meias-voltas.
  const straight = Math.max(half - wide, 0)
  const tx = t.x * straight
  const ty = t.y * straight
  const nx = n.x * wide
  const ny = n.y * wide
  const w = f(wide)
  // Uma meia-volta de raio `wide` fecha cada ponta: `A` com rx = ry e o MESMO
  // sentido nas duas, para o elo sair convexo em qualquer direção da corda.
  // O sentido é 0, e não 1: com 1 as duas meias-voltas dobram para DENTRO e
  // cada elo vira um "I" de viga, que é o oposto de um elo.
  return (
    'M ' + f(p.x + tx + nx) + ' ' + f(p.y + ty + ny) +
    ' A ' + w + ' ' + w + ' 0 0 0 ' + f(p.x + tx - nx) + ' ' + f(p.y + ty - ny) +
    ' L ' + f(p.x - tx - nx) + ' ' + f(p.y - ty - ny) +
    ' A ' + w + ' ' + w + ' 0 0 0 ' + f(p.x - tx + nx) + ' ' + f(p.y - ty + ny) +
    ' Z '
  )
}

/** `parity` 0 = os elos deitados; 1 = os de perfil, entre eles. */
export function chainPath(points: Point[], parity: 0 | 1, scale = 1): string {
  const w = walk(points)
  if (!w) return ''
  const half = LINK_HALF * scale
  const pitch = LINK_PITCH * scale
  const wide = (parity === 0 ? LINK_WIDE : LINK_EDGE) * scale

  let d = ''
  let i = 0
  for (let s = half; s <= w.total - half; s += pitch, i++) {
    if (i % 2 !== parity) continue
    const at = w.at(s)
    d += link(at.p, at.t, at.n, half, wide)
  }
  return d.trim()
}

/**
 * TRANÇA de dois fios: cada um é a linha central deslocada na normal, e os dois
 * andam meio período fora de fase — é isso que os faz cruzar.
 *
 * Profundidade é o SENO e deslocamento lateral é o COSSENO, de propósito: assim
 * o fio troca de frente para trás exatamente onde cruza o eixo, que é onde os
 * dois se encontram. Usar a mesma função para as duas coisas faria a troca
 * acontecer na borda, longe do cruzamento, e a trança se desmancharia.
 *
 * `frontOnly` devolve só os trechos em que o fio está na FRENTE; é esse pedaço,
 * redesenhado por cima do outro, que produz o passa-por-cima/passa-por-baixo.
 */
const BRAID_RADIUS = 2.8
const BRAID_PERIOD = 15
const BRAID_STEP = 1.2

export function braidPath(
  points: Point[],
  phase: 0 | 1,
  frontOnly = false,
  scale = 1
): string {
  const w = walk(points)
  if (!w) return ''
  const radius = BRAID_RADIUS * scale
  const period = BRAID_PERIOD * scale
  const step = BRAID_STEP * scale
  const shift = phase * Math.PI

  let d = ''
  let open = false
  for (let s = 0; s <= w.total; s += step) {
    const angle = (s / period) * Math.PI * 2 + shift
    if (frontOnly && Math.sin(angle) <= 0) {
      open = false
      continue
    }
    const at = w.at(s)
    const off = radius * Math.cos(angle)
    d += (open ? 'L ' : 'M ') + f(at.p.x + at.n.x * off) + ' ' + f(at.p.y + at.n.y * off) + ' '
    open = true
  }
  return d.trim()
}

/** O `d` de um traço derivado. `center` não passa por aqui: usa a corda crua. */
export function geometryPath(
  geometry: RopeGeometry,
  points: Point[],
  scale = 1
): string {
  switch (geometry) {
    case 'spiral':
      return ropeSpiralPath(points, scale)
    case 'chain-a':
      return chainPath(points, 0, scale)
    case 'chain-b':
      return chainPath(points, 1, scale)
    case 'braid-a':
      return braidPath(points, 0, false, scale)
    case 'braid-b':
      return braidPath(points, 1, false, scale)
    case 'braid-a-front':
      return braidPath(points, 0, true, scale)
    default:
      return ''
  }
}

/**
 * Geometria dos traçados sem física. Eles dependem só das duas âncoras para
 * acompanhar um arrasto sem criar estado intermediário nem acordar o Verlet.
 */
export function shapePath(style: RopeStyleId, a: Point, b: Point): string {
  if (style === 'circuit') {
    if (a.y === b.y) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`

    // Um desvio mínimo preserva a saída horizontal mesmo quando as pontas
    // estão na mesma coluna. O raio encolhe só quando o trecho não comporta 12px.
    const directionX = b.x < a.x ? -1 : 1
    const directionY = b.y < a.y ? -1 : 1
    const horizontalDistance = Math.abs(b.x - a.x)
    const middleX =
      horizontalDistance >= 80
        ? (a.x + b.x) / 2
        : a.x + directionX * (horizontalDistance + 40)
    const radius = Math.min(
      12,
      Math.abs(middleX - a.x),
      Math.abs(b.x - middleX),
      Math.abs(b.y - a.y) / 2
    )
    return [
      `M ${a.x} ${a.y}`,
      `H ${middleX - directionX * radius}`,
      `Q ${middleX} ${a.y} ${middleX} ${a.y + directionY * radius}`,
      `V ${b.y - directionY * radius}`,
      `Q ${middleX} ${b.y} ${middleX + directionX * radius} ${b.y}`,
      `H ${b.x}`
    ].join(' ')
  }

  // `line` é o chamador normal. O fallback também mantém um path válido
  // se esta função receber por engano um dos estilos entregues pelo Verlet.
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
}
