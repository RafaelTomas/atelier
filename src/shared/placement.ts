/**
 * Onde uma pílula flutuante cai quando o usuário a solta.
 *
 * Funções PURAS, em `shared/` e não no renderer, por um motivo prático: a
 * geometria de "qual borda venceu" tem casos de canto e de empate que ninguém
 * consegue verificar arrastando uma dock com o mouse. Aqui elas recebem
 * números e devolvem números, e `scripts/test-placement.mjs` fixa cada escolha.
 */
import type { Placement, PlacementEdge } from './types'
import { clampOffset, isVerticalEdge } from './types'

/**
 * Folga entre a pílula e as duas pontas da borda, em px.
 *
 * ESPELHA `--pill-pad` em styles/floating.css, e a duplicação é deliberada: o
 * CSS precisa do número para posicionar sem saber o tamanho do elemento, e este
 * módulo precisa dele para responder "cabem as duas?" sem ler o DOM. Mudar um
 * sem o outro desalinha a conta em 18px — o teste de encaixe fixa o valor.
 */
export const EDGE_PAD = 18

/**
 * Faixa reservada no TOPO da janela, em px.
 *
 * O topo não é uma borda vazia como as outras: o chip do workspace mora no
 * canto esquerdo dele e os controles de vista (zoom, tema, Salvar) no direito,
 * os dois em `top: 10px` com 28px de altura — e no macOS os semáforos da janela
 * ficam na mesma faixa. Uma pílula em `top: 18px` cai exatamente em cima
 * disso, e uma barra de ferramentas que cobre o nome do workspace e o botão de
 * salvar é pior do que uma que não chega lá.
 *
 * Vale para a borda de cima (é o afastamento dela) e para o COMEÇO das bordas
 * laterais (uma pílula vertical em `offset: 0` encosta no mesmo canto). As
 * outras três pontas continuam em `EDGE_PAD`: não há nada para desviar lá.
 *
 * ESPELHA `--pill-safe-top` em tokens.css — 10 do inset, 28 da altura, 10 de ar.
 */
export const EDGE_PAD_TOP = 48

/**
 * A folga do COMEÇO da borda: a faixa reservada nas verticais (onde o começo é
 * o topo da janela), a folga comum nas horizontais.
 */
export function padStart(edge: PlacementEdge): number {
  return isVerticalEdge(edge) ? EDGE_PAD_TOP : EDGE_PAD
}

/**
 * Espaço mínimo entre duas pílulas que dividem uma borda.
 *
 * Não é estética: encostadas, as duas viram uma barra só aos olhos de quem
 * clica, e a fronteira entre "botão da dock" e "botão da rail" some.
 */
export const PILL_GAP = 12

/**
 * Até que distância de uma borda o ponteiro ainda "encaixa" nela, em px.
 *
 * Fora disso a pílula VOLTA para onde estava, em vez de escorregar para a borda
 * mais próxima. Nada de "quase encaixou": soltar no meio do canvas é quase
 * sempre um gesto abandonado, e mover a dock por engano é pior do que não mover.
 */
export const SNAP_MARGIN = 120

export interface Viewport {
  width: number
  height: number
}

/**
 * A borda vencedora para um ponto, ou `null` quando nenhuma está perto.
 *
 * **Empate no canto.** Num canto exato as distâncias horizontal e vertical são
 * iguais, e alguém tem de decidir. A escolha aqui é a HORIZONTAL (`left` /
 * `right`), e ela é arbitrária no sentido de que a outra também funcionaria —
 * o que não é arbitrário é que a escolha esteja FIXA e testada, senão o mesmo
 * gesto daria resultados diferentes conforme o arredondamento do ponteiro.
 */
export function edgeFor(x: number, y: number, vp: Viewport): PlacementEdge | null {
  const dist = {
    left: x,
    right: vp.width - x,
    top: y,
    bottom: vp.height - y
  }

  const min = Math.min(dist.left, dist.right, dist.top, dist.bottom)
  if (min > SNAP_MARGIN) return null

  // Horizontal primeiro: é o desempate declarado acima.
  if (dist.left === min) return 'left'
  if (dist.right === min) return 'right'
  if (dist.top === min) return 'top'
  return 'bottom'
}

/**
 * Onde, AO LONGO da borda vencedora, o ponteiro está — de 0 (início) a 1 (fim).
 *
 * Contínuo, e não três terços: quem larga a dock a um quinto da base espera
 * encontrá-la ali. Fração e não pixels porque é isto que a preferência guarda,
 * e uma fração sobrevive ao redimensionamento da janela.
 *
 * Numa borda horizontal (topo/base) o que conta é o x; numa vertical, o y. O
 * valor sai grampeado em [0, 1]: o ponteiro pode sair da janela no meio do
 * gesto (a captura de ponteiro continua entregando eventos), e uma fração
 * negativa colocaria a pílula fora da tela.
 */
export function offsetFor(x: number, y: number, edge: PlacementEdge, vp: Viewport): number {
  const along = isVerticalEdge(edge) ? y : x
  const total = isVerticalEdge(edge) ? vp.height : vp.width
  if (total <= 0) return 0.5
  return clampOffset(along / total)
}

/**
 * O `Placement` para um ponto solto, ou `null` para "volte para onde estava".
 */
export function placementFor(x: number, y: number, vp: Viewport): Placement | null {
  const edge = edgeFor(x, y, vp)
  if (!edge) return null
  return { edge, offset: offsetFor(x, y, edge, vp) }
}

/**
 * Onde a pílula COMEÇA, em px ao longo da borda.
 *
 * Reproduz exatamente o que o CSS faz (`floating.css`, bloco de ancoragem): o
 * inset anda pela pista e o `translate` desconta a MESMA fração do tamanho
 * próprio. O efeito é que a fração 0 encosta no começo, a 1 no fim, e a pista
 * do começo tem comprimento `total - 2*EDGE_PAD - length`.
 *
 * Está aqui, e não só no CSS, porque é impossível decidir se duas pílulas se
 * cruzam sem saber onde cada uma começa e termina.
 */
export function spanStart(
  offset: number,
  length: number,
  total: number,
  edge: PlacementEdge
): number {
  const from = padStart(edge)
  return from + clampOffset(offset) * Math.max(0, total - from - EDGE_PAD - length)
}

/** O caminho de volta: um começo em px vira a fração que o CSS entende. */
export function offsetForStart(
  start: number,
  length: number,
  total: number,
  edge: PlacementEdge
): number {
  const from = padStart(edge)
  const track = total - from - EDGE_PAD - length
  if (track <= 0) return 0
  return clampOffset((start - from) / track)
}

/**
 * O que fazer quando as duas pílulas caem na MESMA borda.
 *
 * Dividir uma borda passou a ser legítimo: a posição ao longo dela é contínua,
 * e duas peças cabem lado a lado numa base de 1920px com folga de sobra. O que
 * NÃO é legítimo é elas se sobreporem — a de baixo fica com os botões
 * inalcançáveis, e é o único estado de fato quebrado.
 *
 * Três respostas, nesta ordem:
 *
 *  - `ok`   — não se cruzam. Ninguém se move, e é o caso comum: mover a dock
 *             para a base não deve empurrar uma rail que está no canto oposto.
 *  - `push` — se cruzam e há espaço. Anda a pílula que o usuário NÃO tocou,
 *             para o lado livre mais próximo de onde ela já estava: o gesto
 *             pedido é respeitado à risca, e o efeito colateral é o menor
 *             possível.
 *  - `swap` — não cabem as duas nessa borda. Aí volta a regra antiga, a troca
 *             de bordas (ver `resolveCollision`): é reversível, não precisa de
 *             mensagem de erro, e nunca deixa as duas empilhadas.
 *
 * Comprimentos em px porque quem chama MEDE o DOM — uma pílula em coluna e a
 * mesma pílula em linha não têm o mesmo comprimento ao longo da borda, e
 * estimar isso daria uma conta errada justamente no caso que importa.
 */
export type EdgeFit = { kind: 'ok' } | { kind: 'push'; offset: number } | { kind: 'swap' }

export interface PillSpan {
  offset: number
  /** Comprimento da pílula ao longo da borda (largura nas horizontais). */
  length: number
}

export function fitAlongEdge(
  moved: PillSpan,
  other: PillSpan,
  total: number,
  edge: PlacementEdge
): EdgeFit {
  const from = padStart(edge)

  // Nem as duas juntas cabem: nenhuma posição resolve, e insistir só produziria
  // uma delas espremida contra a ponta por cima da outra.
  if (moved.length + other.length + PILL_GAP > total - from - EDGE_PAD) return { kind: 'swap' }

  const a0 = spanStart(moved.offset, moved.length, total, edge)
  const a1 = a0 + moved.length
  const b0 = spanStart(other.offset, other.length, total, edge)
  const b1 = b0 + other.length

  // Já há folga entre as duas: mexer em qualquer uma seria mexer no que o
  // usuário não pediu.
  if (b1 + PILL_GAP <= a0 || a1 + PILL_GAP <= b0) return { kind: 'ok' }

  const before = a0 - PILL_GAP - other.length
  const after = a1 + PILL_GAP
  const fitsBefore = before >= from
  const fitsAfter = after + other.length <= total - EDGE_PAD

  // A arrastada pode ter parado no meio sem deixar vão de nenhum lado — uma
  // pílula larga contra uma borda curta. A troca de bordas é a saída.
  if (!fitsBefore && !fitsAfter) return { kind: 'swap' }

  const start =
    fitsBefore && fitsAfter
      ? // O lado mais perto de onde a outra JÁ estava: o menor deslocamento que
        // resolve é o que menos surpreende quem está olhando.
        Math.abs(before - b0) <= Math.abs(after - b0)
        ? before
        : after
      : fitsBefore
        ? before
        : after

  return { kind: 'push', offset: offsetForStart(start, other.length, total, edge) }
}

/**
 * A saída de último caso quando as duas pílulas não cabem na mesma borda.
 *
 * Dividir a borda é o caminho normal (ver `fitAlongEdge`); esta função só entra
 * quando ele responde `swap`. Aí a pílula solta fica onde o usuário a pôs e a
 * outra TROCA de borda. É reversível, não precisa de mensagem de erro, e — o
 * que importa — o resultado nunca deixa as duas no mesmo lugar, que é o único
 * estado de fato quebrado.
 *
 * A troca é da BORDA, não da posição inteira: a outra pílula vai para a borda
 * que esta acabou de deixar, mantendo a posição que ela já tinha ao longo
 * dela. Trocar os deslocamentos junto moveria uma pílula que o usuário não
 * tocou por um motivo que ele não pediu.
 */
export function resolveCollision(
  moved: Placement,
  movedFrom: Placement,
  other: Placement
): { moved: Placement; other: Placement } {
  if (moved.edge !== other.edge) return { moved, other }

  // A pílula mudou de borda: a outra assume a que esta acabou de deixar.
  if (movedFrom.edge !== moved.edge) {
    return { moved, other: { edge: movedFrom.edge, offset: other.offset } }
  }

  // A pílula ANDOU ao longo da borda que já dividia com a outra, e agora não
  // cabem as duas — uma janela que encolheu, ou a dock ganhando botões. Não há
  // borda vaga "deixada para trás" para oferecer, então a outra vai para a
  // OPOSTA: determinística, sempre livre, e visivelmente diferente do que o
  // usuário acabou de fazer, o que torna o conserto óbvio.
  return { moved, other: { edge: OPPOSITE[moved.edge], offset: other.offset } }
}

const OPPOSITE: Record<PlacementEdge, PlacementEdge> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left'
}
