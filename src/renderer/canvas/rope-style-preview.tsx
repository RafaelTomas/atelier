/**
 * A amostra de um desenho de conexão, fora de qualquer tela.
 *
 * Nasceu dentro do `canvas-chrome.tsx`, servindo só ao seletor de corda dos
 * controles de vista. Saiu de lá quando a tela de Configurações passou a
 * oferecer a MESMA escolha: duas cópias do traçado divergiriam no dia em que um
 * desenho novo entrasse, e a amostra que mente sobre a corda é pior que amostra
 * nenhuma. Nada mudou no desenho — é o mesmo código, num lugar que os dois
 * consumidores alcançam.
 *
 * Mora em `canvas/` porque é daqui que vem tudo de que ela depende
 * (`ropeLayers`, `geometryPath`) e porque quem a pinta é o CSS do canvas —
 * `.rope-style-preview` continua em `styles/canvas.css`.
 */
import { ROPE_STYLES, geometryPath, ropeLayers } from './rope-shapes'

/** Amostra curta, pintada pelas mesmas classes usadas no canvas. */
export function RopeStylePreview({
  id,
  compact = false
}: {
  id: (typeof ROPE_STYLES)[number]['id']
  compact?: boolean
}): JSX.Element {
  return (
    <svg
      className={`rope-style-preview${compact ? ' rope-picker-button-preview' : ''}`}
      viewBox="0 0 28 14"
      aria-hidden="true"
    >
      {ropeLayers(id).map((layer) => (
        <path
          key={layer.name || 'single'}
          className={`rope rope-shape-${id}${layer.name ? ` rope-layer-${layer.name}` : ''} rope-idle`}
          d={
            layer.geometry === 'center'
              ? ropeStylePreviewPath(id)
              : geometryPath(layer.geometry, SWATCH_POINTS, SWATCH_SCALE)
          }
        />
      ))}
    </svg>
  )
}

/**
 * A amostra do seletor é pequena demais para a hélice de canvas: a corda vai a
 * 4.5 de corpo no CSS, e o gomo acompanha pela mesma fração.
 */
const SWATCH_SCALE = 0.45
/** A mesma curva de `ropeStylePreviewPath`, amostrada — a hélice quer pontos. */
const SWATCH_POINTS = Array.from({ length: 24 }, (_, i) => {
  const t = i / 23
  const u = 1 - t
  return {
    x: u * u * u * 2 + 3 * u * u * t * 8 + 3 * u * t * t * 20 + t * t * t * 26,
    y: u * u * u * 5 + 3 * u * u * t * 12 + 3 * u * t * t * 12 + t * t * t * 5
  }
})

function ropeStylePreviewPath(id: (typeof ROPE_STYLES)[number]['id']): string {
  if (id === 'line') return 'M 2 7 H 26'
  if (id === 'circuit') return 'M 2 10 H 10 V 4 H 18 V 7 H 26'
  // Os desenhos em camadas TÊM de usar esta curva: é a mesma que o
  // `SWATCH_POINTS` amostra para a geometria derivada. Devolver outra aqui
  // colocaria a sombra da trança num traçado diferente do dos fios dela.
  if (id === 'dotted' || id === 'rope' || id === 'chain' || id === 'braid') {
    return 'M 2 5 C 8 12, 20 12, 26 5'
  }
  return 'M 2 7 C 8 2, 20 12, 26 7'
}
