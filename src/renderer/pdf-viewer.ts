/**
 * O que este app sabe sobre o visor de PDF do Chromium.
 *
 * PDF aqui não é um tipo de nó: é um nó Portal apontando para `file://`, e quem
 * desenha as páginas é o visor embutido do Chromium (ver README). O visor vem
 * com uma interface que não é nossa — e a barra de miniaturas dela come quase
 * metade da largura do nó.
 *
 * O QUE FOI MEDIDO (Electron 31 / Chromium 126), porque nada disto está
 * documentado e o palpite óbvio está errado:
 *
 *   • Parâmetros de URL do Adobe — `#pagemode=none`, `#navpanes=0`,
 *     `#toolbar=0` — são IGNORADOS. O visor moderno não os implementa.
 *   • `setZoomFactor` no webview não muda nada: o corte não é em px de CSS.
 *   • Clique sintético no botão ☰ não chega ao visor: ele roda num guest
 *     separado (MimeHandlerView), fora do alcance de `sendInputEvent`.
 *   • O que decide é a LARGURA do visor, e o corte fica entre 500 e 510px:
 *     até 500 a barra não aparece; de 510 em diante ela abre sozinha.
 *
 * Por isso o nó de PDF nasce logo abaixo do corte. Não é um número mágico
 * escolhido por estética: é o maior tamanho em que o documento fica com a
 * largura inteira do nó. Alargar o nó além disso traz a barra de volta — é
 * regra do Chromium, e a única forma de escapar dela seria trocar o visor por
 * um nosso (pdf.js), que é outra decisão.
 */

/** Largura máxima do VISOR sem a barra de miniaturas, medida. */
export const PDF_SIDEBAR_BREAKPOINT = 500

/**
 * Tamanho padrão do nó. A largura desconta a borda de 1px de cada lado do card
 * (`.node`), e ainda sobra folga para o corte; a altura segue a proporção de
 * uma página em pé (√2), que é o que quase todo PDF é.
 */
export const PDF_NODE_SIZE: [number, number] = [496, 700]

/** O visor do Chromium dá conta; o editor de texto, não. */
export function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path)
}
