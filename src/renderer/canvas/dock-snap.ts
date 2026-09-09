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
import { DOCK_GAP, dockedFrame, type DockSide } from '@shared/dock'

// Reexportados: `canvas-view` e o teste importam daqui desde antes de a
// geometria mudar de casa, e o caminho do arrasto continua sendo este arquivo.
export { DOCK_GAP, dockedFrame }
export type { DockSide }

/**
 * Raio da zona de atração, em pixels de TELA.
 *
 * De tela, e não de canvas: a zona tem de ter o mesmo tamanho na mão em
 * qualquer zoom. Quem chama divide pelo zoom antes de passar adiante.
 *
 * Começou em 28 e subiu para 44 no uso: com nós grandes, a mão chega perto do
 * vizinho em movimentos largos, e uma zona estreita fazia o usuário mirar. O
 * gesto é "põe este ao lado daquele", não "acerte a linha".
 */
export const SNAP_RANGE = 44


/**
 * Quanto os dois precisam se cruzar no eixo PERPENDICULAR para o encaixe valer,
 * como fração do menor dos dois lados.
 *
 * Sem este piso, um nó passando na diagonal — que só encosta num canto — viraria
 * candidato, e o fantasma apareceria num gesto que não era um encaixe.
 */
const MIN_OVERLAP_RATIO = 0.25

/**
 * Acima desta fração da área do candidato coberta pelo nó arrastado, ele deixa
 * de ser candidato.
 *
 * Um vizinho que o nó na mão já escondeu não explica o fantasma: o usuário vê
 * um retângulo aparecer apontando para algo que não está na tela. Num canvas
 * cheio isso é a regra, não a exceção — sempre há um nó embaixo do outro.
 *
 * 0.8, e não menos, porque encaixar "empurrando para dentro" do vizinho é
 * legítimo (ver a folga negativa): num nó pequeno, esse empurrão sozinho já
 * cobre boa parte da área dele.
 */
const MAX_COVERAGE = 0.8

/**
 * Quanto um alvo NOVO precisa estar mais perto para roubar o encaixe do alvo
 * atual — 0.75 é "pelo menos 25% mais perto".
 *
 * Sem esta inércia, vizinhos a distâncias parecidas trocam a vez a cada pixel
 * do gesto e o fantasma pisca entre eles. O desempate exato não basta: num
 * canvas cheio os empates são QUASE-empates, e quase-empate é justamente o que
 * um número flutuante nunca repete duas vezes seguidas.
 */
const HYSTERESIS = 0.75


/** Um vizinho parado. `z` é o `zIndex` do nó: entre dois empilhados, encaixa-se
 * no de CIMA, que é o que o usuário está vendo. */
export interface DockCandidate {
  id: UUID
  frame: Rect
  z: number
}

export interface DockSnap {
  /** O nó parado que serviu de referência. */
  targetId: UUID
  /** De que lado DELE o arrastado vai parar. */
  side: DockSide
  /** Onde e com que tamanho o arrastado fica ao soltar. */
  frame: Rect
  /**
   * Folga que elegeu este encaixe, em pontos de canvas — sempre positiva.
   *
   * Sai daqui porque quem chama não teria como recalculá-la sem repetir a
   * escolha de lado. É o número que a etiqueta do fantasma mostra, e é o que
   * torna possível responder "por que ele pegou?" olhando a tela.
   */
  distance: number
}

/** Sobreposição de dois intervalos [aStart, aEnd] e [bStart, bEnd]. Negativa
 * quando eles nem se tocam. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
}

/** Área da interseção de dois retângulos. Zero quando não se cruzam. */
function intersection(a: Rect, b: Rect): number {
  const w = overlap(a.x, a.x + a.width, b.x, b.x + b.width)
  const h = overlap(a.y, a.y + a.height, b.y, b.y + b.height)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * O encaixe mais próximo, ou null se nenhum vizinho está ao alcance.
 *
 * `moving` já vem deslocado pelo arrasto; `min` é o piso do TIPO do nó
 * arrastado (ver node-min-size); `range` é o raio JÁ em pontos de canvas;
 * `previous` é o encaixe do quadro anterior, que ganha a inércia do HYSTERESIS.
 */
export function dockSnapFor(
  moving: Rect,
  min: [number, number],
  candidates: DockCandidate[],
  range: number,
  previous: DockSnap | null = null
): DockSnap | null {
  /** Todo encaixe possível deste quadro, já filtrado. */
  const options: { snap: DockSnap; z: number }[] = []

  for (const candidate of candidates) {
    const target = candidate.frame

    // Vizinho que o nó na mão já cobriu não é vizinho: ele não está na tela
    // para justificar o fantasma que apontaria para ele.
    const area = target.width * target.height
    if (area > 0 && intersection(moving, target) / area > MAX_COVERAGE) continue

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
      const frame = dockedFrame(moving, target, side, min)
      // O lugar tem de estar VAGO. O Windows encaixa contra a borda da tela,
      // onde não há nada; aqui o vizinho é a borda, e o outro lado dele
      // costuma estar ocupado por um terceiro nó. Prometer aquele espaço seria
      // prometer um empilhamento.
      if (occupied(frame, candidates, candidate.id)) continue
      options.push({
        snap: { targetId: candidate.id, side, frame, distance: Math.abs(gap) },
        z: candidate.z
      })
    }
  }

  if (options.length === 0) return null

  // Mais perto vence; empate vai para o de CIMA; empate de novo, para o
  // primeiro da lista — que é estável, porque a ordem dos nós é.
  let best = options[0]
  for (const option of options) {
    if (option.snap.distance < best.snap.distance) best = option
    else if (option.snap.distance === best.snap.distance && option.z > best.z) best = option
  }

  // O alvo do quadro anterior fica, a menos que o novo esteja claramente mais
  // perto. `kept` é recalculado agora — só a ESCOLHA tem inércia, nunca a
  // geometria, que continua acompanhando o mouse.
  if (previous) {
    const kept = options.find(
      (o) => o.snap.targetId === previous.targetId && o.snap.side === previous.side
    )
    if (kept && best.snap.distance >= kept.snap.distance * HYSTERESIS) return kept.snap
  }

  return best.snap
}

/**
 * Há algum nó neste retângulo, tirando o próprio alvo do encaixe?
 *
 * A tolerância de 1 ponto é contra o encosto exato: dois retângulos que
 * compartilham uma borda não estão um em cima do outro, e o arredondamento do
 * arrasto não pode transformar isso em colisão.
 */
function occupied(frame: Rect, candidates: DockCandidate[], targetId: UUID): boolean {
  for (const candidate of candidates) {
    if (candidate.id === targetId) continue
    const w = overlap(frame.x, frame.x + frame.width, candidate.frame.x, candidate.frame.x + candidate.frame.width)
    const h = overlap(frame.y, frame.y + frame.height, candidate.frame.y, candidate.frame.y + candidate.frame.height)
    if (w > 1 && h > 1) return true
  }
  return false
}
