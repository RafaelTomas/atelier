/**
 * Encaixe de um nó na lateral de outro durante o arrasto — o gesto do Windows.
 *
 * Montar um par no canvas (terminal + editor, portal + nota) era alinhar no
 * olho e depois puxar as alças até os dois terem a mesma altura. Duas tarefas
 * manuais para uma intenção só: "põe este ao lado daquele, do mesmo tamanho".
 *
 * A regra é a do Aero Snap, com uma diferença que vem do canvas: aqui não há
 * borda de tela para encostar, então o vizinho FAZ o papel da borda. Quem se
 * ajusta é sempre o nó na mão — o que está parado nunca muda, porque ele é a
 * referência que o usuário escolheu ao arrastar na direção dele.
 *
 * Só o eixo do encaixe é igualado: encostar pela lateral iguala a ALTURA e
 * preserva a largura; por cima ou por baixo iguala a LARGURA e preserva a
 * altura. Igualar os dois eixos jogaria fora a proporção que o usuário deu ao
 * nó num gesto que ele pediu por outro motivo.
 *
 * Geometria pura: nada de React, nada de DOM. É o que deixa `scripts/
 * test-dock-snap.mjs` verificar os empates e os pisos sem um mouse.
 */
import type { Rect, UUID } from '@shared/types'

/**
 * Raio da zona de atração, em pixels de TELA.
 *
 * De tela, e não de canvas: a zona tem de ter o mesmo tamanho na mão em
 * qualquer zoom. Quem chama divide pelo zoom antes de passar adiante.
 */
export const SNAP_RANGE = 28

/** Respiro entre os dois encaixados. Colado de verdade (0) faz as duas bordas
 * virarem uma linha grossa só, e o par lê como um nó rachado no meio. */
export const DOCK_GAP = 12

/**
 * Quanto os dois precisam se cruzar no eixo PERPENDICULAR para o encaixe valer,
 * como fração do menor dos dois lados.
 *
 * Sem este piso, um nó passando na diagonal — que só encosta num canto — viraria
 * candidato, e o fantasma apareceria num gesto que não era um encaixe.
 */
const MIN_OVERLAP_RATIO = 0.25

export type DockSide = 'left' | 'right' | 'top' | 'bottom'

export interface DockSnap {
  /** O nó parado que serviu de referência. */
  targetId: UUID
  /** De que lado DELE o arrastado vai parar. */
  side: DockSide
  /** Onde e com que tamanho o arrastado fica ao soltar. */
  frame: Rect
}

/** Sobreposição de dois intervalos [aStart, aEnd] e [bStart, bEnd]. Negativa
 * quando eles nem se tocam. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
}

/**
 * O encaixe mais próximo, ou null se nenhum vizinho está ao alcance.
 *
 * `moving` já vem deslocado pelo arrasto; `min` é o piso do TIPO do nó
 * arrastado (ver node-min-size); `range` é o raio JÁ em pontos de canvas.
 */
export function dockSnapFor(
  moving: Rect,
  min: [number, number],
  candidates: { id: UUID; frame: Rect }[],
  range: number
): DockSnap | null {
  let best: DockSnap | null = null
  let bestDistance = Infinity

  for (const candidate of candidates) {
    const target = candidate.frame

    // Sobreposição no eixo perpendicular a cada tipo de encaixe.
    const vertical = overlap(
      moving.y,
      moving.y + moving.height,
      target.y,
      target.y + target.height
    )
    const horizontal = overlap(moving.x, moving.x + moving.width, target.x, target.x + target.width)
    const sideOk = vertical >= Math.min(moving.height, target.height) * MIN_OVERLAP_RATIO
    const stackOk = horizontal >= Math.min(moving.width, target.width) * MIN_OVERLAP_RATIO

    // Onde os dois centros estão um em relação ao outro. É o que decide QUAL
    // lado o gesto está pedindo: sem isto, um nó em cima do outro satisfaria a
    // folga dos quatro lados ao mesmo tempo.
    const dx = moving.x + moving.width / 2 - (target.x + target.width / 2)
    const dy = moving.y + moving.height / 2 - (target.y + target.height / 2)

    // Folga entre as bordas que se encaram. Negativa = já entrou por cima do
    // vizinho, e continua valendo: empurrar para dentro é como o Windows deixa
    // o usuário confirmar o encaixe sem mirar num fio de cabelo.
    const gaps: { side: DockSide; gap: number; ok: boolean }[] = [
      { side: 'right', gap: moving.x - (target.x + target.width), ok: sideOk && dx > 0 },
      { side: 'left', gap: target.x - (moving.x + moving.width), ok: sideOk && dx < 0 },
      { side: 'bottom', gap: moving.y - (target.y + target.height), ok: stackOk && dy > 0 },
      { side: 'top', gap: target.y - (moving.y + moving.height), ok: stackOk && dy < 0 }
    ]

    for (const { side, gap, ok } of gaps) {
      if (!ok || gap > range || gap < -range) continue
      const distance = Math.abs(gap)
      // `<` e não `<=`: em empate exato fica o primeiro da lista, e a ordem dos
      // nós é estável — o fantasma não pode piscar entre dois vizinhos.
      if (distance >= bestDistance) continue
      bestDistance = distance
      best = { targetId: candidate.id, side, frame: dockedFrame(moving, target, side, min) }
    }
  }

  return best

  /** O frame final: iguala o eixo do encaixe, preserva o outro, cola no lado. */
  function dockedFrame(source: Rect, target: Rect, side: DockSide, floor: [number, number]): Rect {
    if (side === 'left' || side === 'right') {
      // O piso do TIPO vence o tamanho do vizinho: um terminal não encolhe até
      // a altura de um botão só porque encostou nele. O fantasma mostra o
      // tamanho REAL que o nó vai ter, inclusive quando o piso segura.
      const height = Math.max(target.height, floor[1])
      const width = Math.max(source.width, floor[0])
      const x = side === 'right' ? target.x + target.width + DOCK_GAP : target.x - width - DOCK_GAP
      return { x, y: target.y, width, height }
    }
    const width = Math.max(target.width, floor[0])
    const height = Math.max(source.height, floor[1])
    const y = side === 'bottom' ? target.y + target.height + DOCK_GAP : target.y - height - DOCK_GAP
    return { x: target.x, y, width, height }
  }
}
