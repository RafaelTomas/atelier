/**
 * A tira de recursos na borda — a terceira pílula flutuante.
 *
 * O monitor já existia como NÓ de canvas, e é ali que ele some: um widget de
 * 340×380 sai de vista no pan, encolhe no zoom e é desmontado pela
 * virtualização por viewport. A pergunta que ele responde — "a máquina aguenta
 * mais um agente?" — é de fundo permanente, não de "vou até lá ver". Ela
 * precisa estar no campo de visão enquanto se trabalha, e um nó não garante
 * isso.
 *
 * Não é uma barra fixa: o canvas já tem uma gramática de peças flutuantes
 * movíveis, e uma faixa presa no topo seria a única coisa na tela que o usuário
 * NÃO pode mover. Como pílula, o vidro, a sombra, a ancoragem, a transição, os
 * alvos de encaixe e o menu das doze posições vêm todos de graça.
 *
 * ─── Uma amostra a cada 2s, com os olhos abertos ───
 *
 * Esta é a decisão que custa alguma coisa, e ela foi tomada de propósito. Antes
 * da tira, o timer do main só vivia enquanto houvesse um nó de monitor
 * VISÍVEL: a virtualização desmontava o hook fora da tela e o ref-count zerava
 * sozinho. A tira é assinante PERMANENTE — o timer passa a viver enquanto a
 * janela estiver aberta.
 *
 * O custo é aceito por três razões, e nenhuma delas é "é pouco":
 *
 *  - a amostra NÃO passa pela store (a regra está escrita em
 *    `use-system-stats.ts`), então ela não re-renderiza o canvas: quem
 *    re-renderiza é esta tira, e só ela;
 *  - o próprio painel MEDE esse custo e o mostra — a linha "Atelier" do bloco
 *    PC existe exatamente para o usuário ver quanto o app consome, esta
 *    assinatura incluída;
 *  - quem não quiser paga ZERO. `monitorDockVisible: false` não esconde a tira
 *    com CSS: o componente não é montado (ver canvas-view.tsx), o hook não
 *    existe, o `subscribe` não acontece e o comportamento antigo volta inteiro.
 *
 * A cadência é fixa em `DEFAULT_INTERVAL`, como a do nó. Torná-la configurável
 * e persistida antes de alguém pedir seria inventar preferência.
 *
 * ─── O que a tira mostra, e o que ela não mostra ───
 *
 * Uma LINHA de leituras, não o painel de três blocos: CPU, memória e disco em
 * medidores finos, o custo somado dos agentes e a janela mais apertada entre as
 * contas. Não a lista de contas — com três contas, três anéis numa borda deixam
 * de ser legíveis, e essa é a leitura que o popover faz bem.
 *
 * O limiar do vermelho e o formato do par de bytes vêm de `monitor-parts.tsx`,
 * compartilhados com o painel: duas telas que medem a mesma coisa e discordam
 * de quando ela é grave são piores do que uma tela só.
 */
import { useMemo } from 'react'
import { formatBytes } from '@shared/types'
import { PlacementTargets } from './floating/placement-targets'
import { PillMenu } from './floating/pill-menu'
import { usePill } from './floating/use-pill'
import { DANGER_PCT, Sparkline, pair } from './panels/monitor-parts'
import { DEFAULT_INTERVAL, useSystemStats } from './state/use-system-stats'

export function MonitorDock(): JSX.Element {
  // Arrastar, menu de contexto e troca de borda: o mesmo comportamento da dock
  // e da rail, pelo mesmo hook.
  const pill = usePill('monitor')
  const { stats, history } = useSystemStats('', DEFAULT_INTERVAL)

  const pc = useMemo(() => {
    const memPct = stats && stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null
    const diskPct = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : null
    return { memPct, diskPct }
  }, [stats])

  return (
    <>
      {/* Os alvos só existem durante o gesto: fora dele são quatro retângulos
          pintados sobre o canvas sem motivo. */}
      {pill.dragging && <PlacementTargets hot={pill.hot} />}
      <div
        className={pill.dragging ? 'floating pill monitor is-dragging' : 'floating pill monitor'}
        data-edge={pill.placement.edge}
        // A posição AO LONGO da borda é contínua: vai por CSS var, não por um
        // atributo de três valores (ver styles/floating.css).
        style={{ '--pill-offset': String(pill.placement.offset) } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={pill.onPointerDown}
        onContextMenu={pill.onContextMenu}
      >
        <div className="monitor-dock-strip">
          {/* `cpuPct` nulo é a primeira amostra depois de ligar o timer: não há
              delta ainda, e um 0% ali seria um número que ninguém mediu. */}
          <Cell
            label="CPU"
            pct={stats?.cpuPct ?? null}
            series={history.cpu}
            title={
              stats
                ? `CPU · Atelier em ${stats.appCpuPct}% e ${formatBytes(stats.appMemBytes)}`
                : 'CPU · aguardando a primeira amostra'
            }
          />
          <Cell
            label="MEM"
            pct={pc.memPct}
            series={history.mem}
            title={stats ? `memória · ${pair(stats.memUsed, stats.memTotal)}` : 'memória'}
          />
          {/* Sem traço: o disco não anda em quatro minutos, e um sparkline reto
              ocuparia largura para não dizer nada. Zeros = `statfs` falhou
              (volume de rede caído, caminho apagado) e a célula mostra `—`. */}
          <Cell
            label="DSK"
            pct={pc.diskPct}
            title={
              stats && stats.diskTotal > 0
                ? `${stats.diskPath} · ${pair(stats.diskUsed, stats.diskTotal)}`
                : 'disco sem leitura'
            }
          />
        </div>
      </div>

      {pill.menu && (
        <PillMenu
          x={pill.menu.x}
          y={pill.menu.y}
          current={pill.placement}
          fallback={pill.fallback}
          onPick={pill.apply}
          onClose={pill.closeMenu}
        />
      )}
    </>
  )
}

/**
 * Uma métrica na tira: traço, rótulo e percentual.
 *
 * A LARGURA é fixa por célula, e isso não é acabamento. Sem ela, `9%` virando
 * `100%` muda a largura do número, a pílula reflui e a tira pisca na borda a
 * cada amostra — de dois em dois segundos, para sempre, no canto do olho de
 * quem está trabalhando. A largura mora no CSS (`monitor-dock.css`), que é
 * quem conhece a fonte.
 */
function Cell({
  label,
  pct,
  series,
  title
}: {
  label: string
  /** null = sem leitura. O traço some e o número vira `—`, nunca `0%`. */
  pct: number | null
  series?: number[]
  title: string
}): JSX.Element {
  const danger = pct !== null && pct >= DANGER_PCT
  return (
    <span className={danger ? 'monitor-dock-cell is-danger' : 'monitor-dock-cell'} title={title}>
      {series && series.length > 1 && (
        // Menor que o do painel: numa borda de 34px de altura, a caixa de 44×14
        // do nó empurraria o rótulo e o número para fora da pílula.
        <Sparkline series={series} danger={danger} width={26} height={10} />
      )}
      <span className="monitor-dock-label">{label}</span>
      <span className="monitor-dock-pct">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </span>
  )
}
