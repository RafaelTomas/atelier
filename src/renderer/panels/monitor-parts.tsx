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
import type { ReactNode } from 'react'
import { activeWindows, agoLabel, untilReset } from '@shared/agent-usage'
import type { AccountUsage, UsageWindow } from '@shared/agent-usage'
import { formatBytes, formatTokens } from '@shared/types'
import type { ClaudeAccountInfo, CodexAccountUsage } from '@shared/types'
import { accountLabel } from '../claude-accounts'

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

// ─── Contas ─────────────────────────────────────────────────────────────────

/**
 * As janelas que o Claude Code publica, na ordem em que ele as publica.
 *
 * Escrita aqui, e não derivada da leitura, porque a COLUNA existe mesmo quando
 * a conta não tem leitura: sem isso, a conta parada teria uma linha mais curta
 * que a das outras e os anéis não se alinhariam de uma linha para a seguinte.
 * Espelha a ordem fixa de `parseStatusLine`.
 */
const WINDOWS = ['5h', '7d'] as const

/**
 * A linha de uma conta do Claude — compartilhada pela tira do monitor e pela
 * tela de Configurações. Nasceu no painel de monitor e saiu de lá quando a
 * tela de Configurações precisou da MESMA leitura: duas versões da linha que
 * discordassem de quando uma conta está "sem login" seriam piores que uma só.
 *
 * Os dois anéis existem sempre, mesmo vazios: eles são a COLUNA da tabela, e
 * uma conta sem leitura precisa ocupar a mesma largura das outras para as
 * linhas continuarem comparáveis de relance — que é a única coisa que se faz
 * com este bloco.
 *
 * `actions` é o único ponto em que a tela de Configurações diverge do painel:
 * lá a linha só mostra; aqui ela também deixa renomear e remover. Um slot
 * opcional no fim da linha resolve isso sem duplicar o resto do desenho —
 * ausente, o painel de monitor continua pixel a pixel igual a antes.
 */
export function AccountLine({
  account,
  usage,
  actions
}: {
  account: ClaudeAccountInfo
  usage?: AccountUsage
  /** Controles extra no fim da linha (renomear, remover) — a tela de Configurações usa; o painel não. */
  actions?: ReactNode
}): JSX.Element {
  const source = usage?.source ?? 'none'
  const ago = source === 'stored' ? agoLabel(usage?.at) : null

  // O que a linha inteira diz, para quem parar o mouse nela: quem é a conta,
  // quantos agentes dela estão abertos e quanto eles já custaram nesta sessão.
  const parts = [accountLabel(account)]
  if (usage && usage.live > 0) parts.push(`${usage.live} terminal(is) aberto(s)`)
  if (usage && usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(2)} nesta sessão`)

  return (
    <li className="monitor-account">
      {/* Mesma gramática do ponto do bloco IA: cheio = medido agora, vazado =
          última leitura conhecida, apagado = sem leitura nenhuma. */}
      <span
        className={`monitor-source is-${source}`}
        title={
          source === 'live'
            ? 'medindo agora — há terminal aberto nesta conta'
            : source === 'stored'
              ? `última leitura conhecida${ago ? `, ${ago}` : ''} — sem terminal aberto nesta conta`
              : 'sem leitura desta conta'
        }
      />
      <span className="monitor-account-name" title={parts.join(' · ')}>
        {account.label}
      </span>
      {/* Sem login não há janela para medir, e o vazio aqui tem uma causa que o
          usuário resolve — dizê-la vale mais que dois anéis apagados. */}
      {!account.authenticated && <span className="monitor-account-warn">sem login</span>}
      {WINDOWS.map((name) => (
        <WindowDonut
          key={name}
          name={name}
          limit={usage?.limits.find((l) => l.window === name) ?? null}
          ago={ago}
        />
      ))}
      {actions}
    </li>
  )
}

/** O anel de uma janela e o nome dela — "◕ 5h". */
export function WindowDonut({
  name,
  limit,
  ago
}: {
  name: string
  /** null = esta conta não tem leitura válida desta janela. */
  limit: UsageWindow | null
  /** Idade da leitura, quando ela é a guardada. */
  ago: string | null
}): JSX.Element {
  const falta = limit ? untilReset(limit.resetsAt) : null
  const title = !limit
    ? `${name}: sem leitura`
    : [
        `${name} ${Math.round(limit.pct)}%`,
        falta ? `reabre em ${falta}` : null,
        ago // só a leitura guardada tem idade; a viva é de agora
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <span className="monitor-window-cell" title={title}>
      <Donut pct={limit?.pct ?? null} stale={ago !== null} />
      <span className="monitor-window-name">{name}</span>
    </span>
  )
}

/** A linha da conta do Codex — só existe uma, então o "nome" é fixo. */
export function CodexAccountLine({ usage }: { usage: CodexAccountUsage }): JSX.Element {
  const windows = activeWindows(usage.limits)
  const source = usage.source
  const danger = usage.spendControlReached === true || usage.rateLimitReachedType !== null
  const lifetimeTokens = usage.tokenUsage?.summary.lifetimeTokens ?? null
  const label =
    usage.authMode === 'api-key'
      ? 'limites da API não disponíveis aqui'
      : source === 'none'
        ? 'sem leitura'
        : [usage.planType, lifetimeTokens !== null ? `${formatTokens(lifetimeTokens)} tok` : null]
            .filter(Boolean)
            .join(' · ') || 'Codex'
  const title = [
    usage.planType ? `plano ${usage.planType}` : null,
    usage.authMode ? `auth ${usage.authMode}` : null,
    usage.credits?.unlimited ? 'créditos sem limite' : usage.credits?.balance ? `créditos ${usage.credits.balance}` : null,
    lifetimeTokens !== null ? `${lifetimeTokens.toLocaleString('pt-BR')} tokens na conta` : null,
    usage.tokenUsage?.summary.peakDailyTokens !== null && usage.tokenUsage?.summary.peakDailyTokens !== undefined
      ? `pico diário ${usage.tokenUsage.summary.peakDailyTokens.toLocaleString('pt-BR')}`
      : null,
    usage.rateLimitReachedType ? `limite atingido: ${usage.rateLimitReachedType}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className={danger ? 'monitor-account is-danger' : 'monitor-account'}>
      <span
        className={`monitor-source is-${source === 'live' ? 'live' : source === 'stored' ? 'stored' : 'none'}`}
        title={
          source === 'live'
            ? 'publicado pelo Codex App Server'
            : source === 'stored'
              ? 'última leitura Codex guardada'
              : 'sem leitura Codex'
        }
      />
      <span className="monitor-account-name" title={title || label}>
        Codex
      </span>
      <span className="monitor-account-warn">{label}</span>
      {usage.authMode === 'api-key'
        ? null
        : (windows.length > 0
            ? windows
            : [
                { window: '5h', pct: Number.NaN, resetsAt: null },
                { window: '7d', pct: Number.NaN, resetsAt: null }
              ]
          ).map((limit) => (
            <WindowDonut
              key={`${limit.bucketId ?? ''}-${limit.window}`}
              name={limit.window}
              limit={Number.isFinite(limit.pct) ? limit : null}
              ago={source === 'stored' ? agoLabel(usage.at) : null}
            />
          ))}
    </li>
  )
}
