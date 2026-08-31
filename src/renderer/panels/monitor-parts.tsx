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
 * Só o que é de fato comum mora aqui. Os blocos (PC, IA, Perfis) e a
 * configuração continuam no painel: a tira não os usa, e trazê-los para cá
 * faria deste arquivo um segundo painel disfarçado.
 *
 * O `Donut` desceu para cá numa segunda rodada, pelo mesmo argumento: a tira
 * passou a medir CPU, memória e disco com o MESMO anel que o painel usa nas
 * janelas de conta. Duas telas que desenham "quanto já foi" de jeitos
 * diferentes obrigam a reaprender o desenho ao trocar de canto.
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

/**
 * O anel de progresso: o trilho inteiro é o limite, e o arco é o quanto já foi.
 * SVG inline pelo mesmo motivo do sparkline — são dois círculos numa caixa de
 * 14px, e uma biblioteca de gráfico custaria mais que o widget inteiro.
 *
 * `pct` nulo desenha SÓ o trilho. Um anel de 0% e um anel sem leitura ficariam
 * idênticos na tela — e o painel inteiro se apoia em não confundir "não gastei"
 * com "não sei".
 *
 * O `viewBox` é sempre 14: quem muda é o tamanho RENDERIZADO, e a espessura do
 * traço vem do CSS em unidades do viewBox, então o anel engorda junto com a
 * caixa em vez de virar um aro fino de 20px.
 */
export function Donut({
  pct,
  stale,
  size = 13
}: {
  pct: number | null
  stale: boolean
  /** Lado da caixa em px. O painel usa 13; a tira de borda pede um pouco mais. */
  size?: number
}): JSX.Element {
  const r = 5
  const circumference = 2 * Math.PI * r
  const filled = pct === null ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * circumference
  const cls = [
    'monitor-donut',
    pct !== null && pct >= DANGER_PCT ? 'is-danger' : '',
    stale ? 'is-stale' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <svg className={cls} viewBox="0 0 14 14" width={size} height={size} aria-hidden="true">
      <circle className="monitor-donut-track" cx="7" cy="7" r={r} />
      {pct !== null && (
        <circle
          className="monitor-donut-fill"
          cx="7"
          cy="7"
          r={r}
          // Começa no topo, e não às 3 horas: um anel que enche a partir da
          // direita não é lido como progresso.
          transform="rotate(-90 7 7)"
          strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`}
        />
      )}
    </svg>
  )
}

/**
 * O anel com o NÚMERO no centro — a variante grande do `Donut`.
 *
 * Existe para a tira EM PÉ. Deitada, a célula tem largura de sobra e o
 * percentual cabe ao lado do anel; numa coluna de 44px, "CPU" e "30%" em linhas
 * separadas viram duas fileiras de texto de 9px empilhadas sob um aro pequeno —
 * três informações competindo pela mesma faixa estreita. Com o número DENTRO do
 * anel, a medida vira uma peça só: o aro diz quanto foi, o número diz quanto é,
 * e sobra a linha de baixo para a sigla.
 *
 * O `viewBox` é 36 e o raio, 15.9155 — o valor em que a circunferência dá
 * exatamente 100. Com ele o `stroke-dasharray` recebe o percentual CRU, sem
 * conta nenhuma, e o desenho passa a ser lido no código do mesmo jeito que na
 * tela. É outro viewBox que o `Donut` de propósito: com 14 unidades, o furo do
 * meio não comporta quatro caracteres sem o traço do aro invadir o texto.
 */
export function Gauge({
  pct,
  size = 34
}: {
  /** null = sem leitura: só o trilho, e `—` no lugar do número. */
  pct: number | null
  /** Lado da caixa em px. */
  size?: number
}): JSX.Element {
  const r = 15.9155
  const value = pct === null ? 0 : Math.max(0, Math.min(100, pct))
  const danger = pct !== null && pct >= DANGER_PCT
  // Em 100% o `%` não cabe com três dígitos, e o dígito é o que importa: o anel
  // cheio já diz que a unidade é o limite inteiro.
  const text = pct === null ? '—' : value >= 99.5 ? '100' : `${Math.round(value)}%`

  return (
    <svg
      className={danger ? 'monitor-gauge is-danger' : 'monitor-gauge'}
      viewBox="0 0 36 36"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <circle className="monitor-gauge-track" cx="18" cy="18" r={r} />
      {pct !== null && (
        <circle
          className="monitor-gauge-fill"
          cx="18"
          cy="18"
          r={r}
          // Começa no topo, como no `Donut`: um anel que enche a partir da
          // direita não é lido como progresso.
          transform="rotate(-90 18 18)"
          strokeDasharray={`${value.toFixed(1)} 100`}
        />
      )}
      <text
        className="monitor-gauge-text"
        x="18"
        y="18"
        // `central` e não `middle`: o segundo alinha pela metade do x-height e
        // deixaria o número um fio acima do centro do aro.
        dominantBaseline="central"
        textAnchor="middle"
        // Em unidades do viewBox, não px: é isto que faz o número crescer junto
        // com a caixa em vez de virar uma formiga num anel grande. 10 é o maior
        // valor em que `100` ainda deixa ar entre o texto e o aro — em 11 os
        // dois se encostam e o medidor parece apertado.
        fontSize={10}
      >
        {text}
      </text>
    </svg>
  )
}
