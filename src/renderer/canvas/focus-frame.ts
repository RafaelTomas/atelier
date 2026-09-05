/**
 * A geometria do MODO FOCO — o retângulo que um nó ocupa quando o duplo clique
 * o amplia.
 *
 * Fica separado do canvas, e sem uma linha de React, pelo mesmo motivo de
 * `node-min-size.ts`: é conta, e conta se verifica por fora do Electron
 * (scripts/test-focus.mjs). O que o canvas faz com o retângulo — véu, zoom
 * travado, gestos mudos — é problema de lá.
 *
 * TUDO aqui pressupõe ZOOM 1, que é o que o canvas fixa ao entrar no foco. Com
 * o zoom em 1 um ponto de canvas é um pixel de tela, e a conta vira aritmética
 * de janela: nenhuma multiplicação por escala aparece abaixo, e é de propósito.
 */
import type { CanvasNode, NodeContent, Point, Rect } from '@shared/types'

/** Respiro entre o nó em foco e a borda da janela. */
export const FOCUS_MARGIN = 48

/**
 * Teto de crescimento dos nós que mantêm a proporção.
 *
 * Um botão de 88×88 esticado para a tela inteira não revela nada — ele não tem
 * conteúdo escondido para mostrar, só um rótulo que ficaria do tamanho de um
 * cartaz. 3× é o ponto em que ele vira um alvo confortável sem virar outra
 * coisa.
 */
export const FOCUS_MAX_SCALE = 3

/**
 * O andar do modo foco: o véu em `FOCUS_Z - 1`, o nó em `FOCUS_Z`.
 *
 * Os zIndex dos nós vêm de `maxZ + 1` a cada trazer-para-frente, então crescem
 * de um em um pela vida do workspace e vivem nas dezenas. Um milhão é folga
 * suficiente para não haver empate, e baixo o bastante para não competir com o
 * cromo da janela (o `.modal-backdrop` dos diálogos está em 200, e ele deve
 * mesmo cobrir o foco: um diálogo é a única coisa mais urgente que ele).
 */
export const FOCUS_Z = 1_000_000

/**
 * Quem cresce mantendo a PROPORÇÃO em vez de preencher.
 *
 * É a mesma lista de `isChromeless` (node-shell.tsx), e não por acaso: o que
 * não tem moldura também não tem conteúdo que se beneficie de mais área — um
 * botão, um relógio e um rótulo de texto têm um desenho de tamanho fixo dentro.
 * O resto (terminal, portal, editor, tabela, nota, cofre, árvore, painéis) é
 * painel: mais área é mais linha à vista, e preencher é o que se quer.
 */
export function keepsAspect(content: NodeContent): boolean {
  if (content.type === 'text') return true
  if (content.type !== 'widget') return false
  return content.value.kind === 'button' || content.value.kind === 'clock'
}

/** A janela, do jeito que o viewport a descreve. */
export interface FocusView {
  origin: Point
  width: number
  height: number
}

/**
 * O retângulo do nó em foco, em coordenadas de canvas.
 *
 * A área disponível é a janela menos a margem dos dois lados. Painel toma ela
 * inteira; os de proporção fixa crescem pelo menor dos três fatores — o que
 * cabe em largura, o que cabe em altura e o teto — o que também garante que um
 * nó já maior que a tela ENCOLHE para caber, em vez de vazar pelas bordas.
 *
 * O resultado sai sempre centralizado: o que sobra da área vira margem dos dois
 * lados, e não tudo de um lado só (mesma regra do `viewport.fit`).
 */
export function focusFrame(node: CanvasNode, view: FocusView): Rect {
  const availWidth = Math.max(1, view.width - FOCUS_MARGIN * 2)
  const availHeight = Math.max(1, view.height - FOCUS_MARGIN * 2)

  let width = availWidth
  let height = availHeight

  if (keepsAspect(node.content)) {
    const { width: w, height: h } = node.frame
    // Nó de área zero não tem proporção para manter — cai no preenchimento, que
    // é o único resultado definido para ele.
    if (w > 0 && h > 0) {
      const scale = Math.min(availWidth / w, availHeight / h, FOCUS_MAX_SCALE)
      width = w * scale
      height = h * scale
    }
  }

  // Arredondado, e não por capricho: uma caixa de largura fracionária faz o
  // Chromium rasterizar o conteúdo entre dois pixels, e num terminal de 12px
  // isso aparece como texto borrado — o mesmo sintoma que o `will-change`
  // permanente causava (ver canvas.css, "Promoção a camada").
  return {
    x: Math.round(view.origin.x + (view.width - width) / 2),
    y: Math.round(view.origin.y + (view.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height)
  }
}
