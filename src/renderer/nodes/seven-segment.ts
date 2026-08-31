/**
 * O mostrador de SETE SEGMENTOS do nó de relógio.
 *
 * Por que desenhar, e não usar uma fonte: um display de LED de verdade não é um
 * corpo de letra, é uma grade de sete barras onde as APAGADAS continuam
 * visíveis — é o fantasma do "8" atrás de cada dígito que faz um painel parecer
 * um painel. Nenhuma fonte entrega isso: ela desenha só o que está aceso.
 * Empacotar um `.woff` de sete segmentos resolveria a forma e não o fantasma, e
 * ainda acrescentaria um binário ao repositório para uma peça só.
 *
 * ─── Uma fonte de verdade para dois caminhos de escrita ──────────────────────
 *
 * Este mostrador tem DOIS escritores, e é isso que dita o formato do módulo:
 *
 *   • o React, no primeiro quadro do widget;
 *   • o `ClockCoordinator`, uma vez por segundo, direto no DOM — porque o tique
 *     não pode passar pelo React (ver clock-widget.tsx).
 *
 * Duas implementações do mesmo desenho divergiriam no primeiro ajuste, e a
 * divergência apareceria como um piscar de meio segundo na montagem. Então a
 * verdade é UMA: esta função devolve uma STRING de HTML, o coordenador a joga em
 * `innerHTML` e o componente React a entrega por `dangerouslySetInnerHTML`. É o
 * uso legítimo desse atributo — a string não tem entrada de usuário nenhuma, só
 * os caracteres que o `escapeSegmentText` abaixo aceita.
 *
 * ─── Custo ───────────────────────────────────────────────────────────────────
 *
 * Um `innerHTML` por segundo por relógio VISÍVEL, e só quando o texto muda de
 * fato (o coordenador compara antes de escrever). São alguns nós e uma string
 * de poucos KB: mais caro que um `textContent`, muito mais barato que um render
 * do React, e sem tocar na store nem na árvore do canvas.
 */

/** As sete barras, na ordem canônica `a` (topo) → `g` (meio). */
type Segment = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'

const ORDER: Segment[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

/**
 * Quais barras acendem em cada dígito. É a tabela de um decodificador BCD de
 * verdade, e a razão de estar escrita à mão: derivá-la seria mais código do que
 * as dez linhas que ela tem.
 */
const DIGITS: Record<string, Segment[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'd', 'e', 'g'],
  '3': ['a', 'b', 'c', 'd', 'g'],
  '4': ['b', 'c', 'f', 'g'],
  '5': ['a', 'c', 'd', 'f', 'g'],
  '6': ['a', 'c', 'd', 'e', 'f', 'g'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g']
}

/**
 * A geometria, numa caixa de 24×44.
 *
 * As pontas são chanfradas (seis vértices por barra, não quatro): num display
 * real as barras são trapézios que quase se tocam nas quinas, e o vão em V
 * entre elas é o que distingue um sete segmentos de um desenho de palitos.
 */
const THICK = 2

function horizontal(y: number): string {
  const x1 = 4
  const x2 = 20
  return [
    [x1, y],
    [x1 + THICK, y - THICK],
    [x2 - THICK, y - THICK],
    [x2, y],
    [x2 - THICK, y + THICK],
    [x1 + THICK, y + THICK]
  ]
    .map((p) => p.join(','))
    .join(' ')
}

function vertical(x: number, y1: number, y2: number): string {
  return [
    [x, y1],
    [x + THICK, y1 + THICK],
    [x + THICK, y2 - THICK],
    [x, y2],
    [x - THICK, y2 - THICK],
    [x - THICK, y1 + THICK]
  ]
    .map((p) => p.join(','))
    .join(' ')
}

const POINTS: Record<Segment, string> = {
  a: horizontal(3),
  b: vertical(21, 5, 20),
  c: vertical(21, 24, 39),
  d: horizontal(41),
  e: vertical(3, 24, 39),
  f: vertical(3, 5, 20),
  g: horizontal(22)
}

/**
 * Um dígito. As SETE barras são sempre desenhadas; a classe é que decide quais
 * estão acesas — é daí que vem o fantasma do "8" por trás do número.
 */
function digit(char: string): string {
  const lit = new Set(DIGITS[char] ?? [])
  const bars = ORDER.map(
    (seg) =>
      `<polygon class="seg${lit.has(seg) ? ' on' : ''}" points="${POINTS[seg]}"/>`
  ).join('')
  return `<svg class="sseg-digit" viewBox="0 0 24 44" aria-hidden="true">${bars}</svg>`
}

/** Dois pontos entre os grupos. Estreito: separador não é dígito. */
function colon(): string {
  return (
    '<svg class="sseg-colon" viewBox="0 0 8 44" aria-hidden="true">' +
    '<circle class="seg on" cx="4" cy="16" r="2.4"/>' +
    '<circle class="seg on" cx="4" cy="30" r="2.4"/>' +
    '</svg>'
  )
}

/** A vírgula dos centésimos do cronômetro — um ponto só, embaixo. */
function comma(): string {
  return (
    '<svg class="sseg-colon" viewBox="0 0 8 44" aria-hidden="true">' +
    '<circle class="seg on" cx="4" cy="39" r="2.4"/>' +
    '</svg>'
  )
}

/**
 * O texto do mostrador como HTML de segmentos.
 *
 * Aceita apenas o que os formatadores de `shared/clock.ts` produzem: dígitos,
 * `:` e `,`. Qualquer outro caractere é IGNORADO em silêncio, e é de propósito —
 * esta string vai para `innerHTML`, então o conjunto fechado de entradas é o que
 * torna isso seguro sem um passo de escape. Nada digitado pelo usuário passa por
 * aqui: a edição usa um `<input>` comum.
 */
export function segmentMarkup(text: string): string {
  let out = ''
  for (const char of text) {
    if (char >= '0' && char <= '9') out += digit(char)
    else if (char === ':') out += colon()
    else if (char === ',' || char === '.') out += comma()
  }
  return out
}

/** O atributo que um readout usa para pedir segmentos em vez de texto cru. */
export const SEGMENT_ATTR = 'data-clock-segments'
