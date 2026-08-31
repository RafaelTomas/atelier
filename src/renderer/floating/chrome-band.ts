/**
 * A LINHA DO TOPO: quanto dela o chrome já ocupa, e como as pílulas ficam
 * sabendo disso.
 *
 * O chip do workspace (esquerda) e os controles de vista (direita) dividem a
 * faixa de cima com as pílulas horizontais. Antes elas assentavam numa segunda
 * fileira abaixo — uma altura reservada resolvia a sobreposição às custas de
 * 50px de canvas e de uma barra que ninguém pediu no meio da tela. Agora as três
 * peças moram na mesma linha, e o que impede a sobreposição é a PISTA: o trecho
 * do topo que começa depois do chip e termina antes dos controles.
 *
 * A pista é MEDIDA, não constante: o nome do workspace muda de largura a cada
 * troca de workspace, e os controles de vista ganham e perdem o grupo do Git.
 * Uma reserva fixa ou cobriria o chip de um nome longo ou desperdiçaria pista
 * no de nome curto.
 *
 * A mesma medida serve a dois consumidores, e é por isso que ela mora aqui e
 * não dentro de um componente:
 *
 *  - o CSS, pelas vars `--chrome-left-end` / `--chrome-right-end`, que
 *    posicionam a pílula sem saber o tamanho dela (ver floating.css);
 *  - a conta de colisão (`fitAmong`), que precisa dos MESMOS números para
 *    empurrar uma irmã para um vão que de fato existe.
 *
 * Se os dois divergirem, o empurrão calculado não bate com a posição desenhada
 * — daí a única fonte.
 */
import { useLayoutEffect } from 'react'
import type { PlacementEdge } from '@shared/types'
import type { EdgeReserve } from '@shared/placement'
import { PILL_GAP } from '@shared/placement'

/** Os dois seletores da linha do topo, na ordem em que ela é lida. */
const CHIP = '.canvas-chip-row'
const CONTROLS = '.view-controls'

/**
 * O quanto o chrome ocupa das duas pontas do topo, em px a partir de cada
 * ponta, com o respiro entre peças já somado.
 *
 * Zero quando a peça não está na tela: uma medida inventada reservaria pista
 * contra um obstáculo que não existe.
 */
export function measureTopChrome(): Required<EdgeReserve> {
  const chip = document.querySelector<HTMLElement>(CHIP)
  const controls = document.querySelector<HTMLElement>(CONTROLS)
  return {
    start: chip ? chip.getBoundingClientRect().right + PILL_GAP : 0,
    end: controls ? window.innerWidth - controls.getBoundingClientRect().left + PILL_GAP : 0
  }
}

/**
 * A reserva da borda — só o topo tem dono. As outras três voltam vazias, e as
 * funções de `placement.ts` caem na folga comum.
 */
export function reserveFor(edge: PlacementEdge): EdgeReserve {
  return edge === 'top' ? measureTopChrome() : {}
}

/**
 * Mantém as CSS vars da pista em dia enquanto o chrome muda de tamanho.
 *
 * `ResizeObserver` e não um efeito por render: quem muda a largura do chip é o
 * nome do workspace, e quem muda a dos controles é o zoom passando de 100% para
 * 30% — nenhum dos dois é um render DESTE componente. O `resize` da janela entra
 * porque a ponta direita é medida a partir de `innerWidth`.
 *
 * Escreve direto no `documentElement`, sem passar pela store: é o mesmo motivo
 * pelo qual o arrasto da pílula escreve `--pill-x` no elemento — um valor de
 * layout que muda sozinho não deve notificar o canvas inteiro.
 */
export function useTopChromeBand(): void {
  useLayoutEffect(() => {
    const root = document.documentElement

    const sync = (): void => {
      const { start, end } = measureTopChrome()
      root.style.setProperty('--chrome-left-end', `${Math.round(start)}px`)
      root.style.setProperty('--chrome-right-end', `${Math.round(end)}px`)
    }

    sync()

    const ro = new ResizeObserver(sync)
    for (const sel of [CHIP, CONTROLS]) {
      const el = document.querySelector(sel)
      if (el) ro.observe(el)
    }
    window.addEventListener('resize', sync)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])
}
