/**
 * As peças de desenho do monitor, compartilhadas por quem mede as mesmas coisas.
 *
 * Nasceram dentro de `monitor-panel.tsx` e saíram quando a tira de borda
 * (`monitor-dock.tsx`) passou a mostrar CPU, memória e disco também. O motivo
 * da extração não é evitar teclado repetido: é que o limiar do vermelho e o
 * formato do par de bytes NÃO PODEM existir em duas versões. Duas telas que
 * medem a mesma coisa e discordam de quando ela é grave são piores do que uma
 * tela só — quem viu 89% em verde num canto e vermelho no outro deixa de
 * confiar nos dois.
 *
 * Só o que é de fato comum mora aqui. Os blocos (PC, IA, Perfis), os anéis de
 * janela e a configuração continuam no painel: a tira não os usa, e trazê-los
 * para cá faria deste arquivo um segundo painel disfarçado.
 */
import { formatBytes } from '@shared/types'

/** Acima disto a barra fica vermelha: é o aperto que muda uma decisão. */
export const DANGER_PCT = 90

/**
 * "217,6 / 222,9 GB" — a unidade UMA vez, quando as duas medidas caem nela.
 *
 * `formatBytes` dos dois lados daria "217,6 GB / 222,9 GB": dezenove caracteres
 * que, num nó de 340px, empurram a linha para fora do nó — a barra encolhe até
 * sumir e o número fica cortado no meio, que é exatamente o que a tela mostrou.
 * Repetir a unidade também não informa nada: as duas metades de uma fração de
 * disco ou de memória quase sempre estão na mesma ordem de grandeza.
 */
export function pair(used: number, total: number): string {
  const u = formatBytes(used)
  const t = formatBytes(total)
  const cut = u.indexOf(' ')
  return u.slice(cut + 1) === t.slice(t.indexOf(' ') + 1)
    ? `${u.slice(0, cut)} / ${t}`
    : `${u} / ${t}`
}

/** Rótulo, barra, número e (quando há série) o traço dos últimos minutos. */
export function Meter({
  label,
  pct,
  value,
  series,
  title
}: {
  /** null = sem leitura; a barra some e o valor mostra `—`. */
  pct: number | null
  label: string
  value: string
  series?: number[]
  title?: string
}): JSX.Element {
  const danger = pct !== null && pct >= DANGER_PCT
  return (
    <div className="monitor-row" title={title}>
      <span className="monitor-label">{label}</span>
      <span className={danger ? 'monitor-bar is-danger' : 'monitor-bar'}>
        <span className="monitor-fill" style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      {series && series.length > 1 && <Sparkline series={series} danger={danger} />}
      <span className="monitor-value">{value}</span>
    </div>
  )
}

/**
 * O histórico como um traço. SVG inline, sem biblioteca: são duas dezenas de
 * pontos numa caixa de 44×14, e um gráfico de verdade custaria mais bytes que o
 * resto do widget inteiro.
 *
 * A escala do eixo Y é FIXA em 0–100%, não ajustada aos dados: um traço
 * auto-escalado faria uma oscilação de 2% parecer um pico, que é o oposto do
 * que se quer ver aqui.
 */
export function Sparkline({
  series,
  danger,
  width = 44,
  height = 14
}: {
  series: number[]
  danger: boolean
  /**
   * A caixa do traço. O painel usa a de 44×14 em que a peça nasceu; a tira de
   * borda pede uma menor, e passar a medida é mais honesto do que reescrever o
   * mesmo SVG com outros números.
   */
  width?: number
  height?: number
}): JSX.Element {
  const points = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * width
      const y = height - (Math.max(0, Math.min(100, v)) / 100) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      className={danger ? 'monitor-spark is-danger' : 'monitor-spark'}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <polyline points={points} fill="none" strokeWidth="1" />
    </svg>
  )
}
