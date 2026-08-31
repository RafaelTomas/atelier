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
 * anéis, o custo somado dos agentes, a janela de SESSÃO com quanto falta para
 * ela reabrir e — só quando é outra e está mais cheia — a janela mais apertada.
 * Não a lista de contas: com três contas, três linhas de anéis numa borda
 * deixam de ser legíveis, e essa é a leitura que o popover faz bem.
 *
 * A janela de sessão ganhou lugar fixo porque é a única das duas que muda uma
 * decisão dentro do expediente — a semanal reabre num prazo com que ninguém faz
 * nada hoje. E o percentual sozinho não basta: "88%" não diz se o aperto passa
 * em vinte minutos ou em quatro horas, e é essa resposta que decide entre
 * esperar e trocar de conta. Daí o prazo ao lado, e não só no `title`.
 *
 * O limiar do vermelho e o formato do par de bytes vêm de `monitor-parts.tsx`,
 * compartilhados com o painel: duas telas que medem a mesma coisa e discordam
 * de quando ela é grave são piores do que uma tela só.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AccountRow, DockSummary, UsageWindow } from '@shared/agent-usage'
import {
  activeWindows,
  dockSummary,
  groupByAccount,
  mergeReading,
  untilReset
} from '@shared/agent-usage'
import { DEFAULT_CLAUDE_ACCOUNT_ID, formatBytes } from '@shared/types'
import { PlacementTargets } from './floating/placement-targets'
import { PillMenu } from './floating/pill-menu'
import { usePill } from './floating/use-pill'
import type { MonitorBlocks } from './panels/monitor-panel'
import { MonitorPanel } from './panels/monitor-panel'
import { DANGER_PCT, Gauge, pair } from './panels/monitor-parts'
import { store, useStore } from './state/store'
import { DEFAULT_INTERVAL, useSystemStats } from './state/use-system-stats'

export function MonitorDock(): JSX.Element {
  // Arrastar, menu de contexto e troca de borda: o mesmo comportamento da dock
  // e da rail, pelo mesmo hook.
  const pill = usePill('monitor')
  // Sem `history`: as métricas passaram do traço para o anel (ver `Cell`), e o
  // histórico não tem quem o desenhe aqui. O popover, quando abre, monta o
  // painel com o hook dele — o traço dos últimos minutos continua existindo lá.
  const { stats } = useSystemStats('', DEFAULT_INTERVAL)

  const pc = useMemo(() => {
    const memPct = stats && stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null
    const diskPct = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : null
    return { memPct, diskPct }
  }, [stats])

  const ai = useMonitorDockAI()

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * Quais blocos e com que cadência o POPOVER mostra.
   *
   * Local, e não preferência: a cadência configurável e persistida ficou para
   * depois de propósito (mexer nisso antes de alguém pedir é inventar
   * preferência), e `blocks` é o mesmo caso. O que o `onChange` do painel edita
   * aqui vale enquanto o popover está aberto — não é o `view` de um nó, e
   * também não é disco.
   */
  const [blocks, setBlocks] = useState<MonitorBlocks>('both')
  const [interval, setIntervalMs] = useState(DEFAULT_INTERVAL)

  // Fecha em clique fora e no Esc. `mousedown` (não `click`) para o popover
  // sumir antes de o canvas processar o arrasto embaixo dele — a mesma regra
  // dos menus da dock.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

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
        ref={rootRef}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={pill.onPointerDown}
        onContextMenu={pill.onContextMenu}
      >
        {/* A tira INTEIRA é o gatilho do popover: numa borda, um botão de abrir
            ao lado das leituras roubaria a largura de uma métrica. O arrasto
            continua funcionando porque o clique só vira gesto depois de 4px —
            ver DRAG_SLOP em use-placement.ts. */}
        <button
          type="button"
          className="monitor-dock-strip"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Recursos da máquina e dos agentes — clique para o painel inteiro"
          onClick={() => setOpen((v) => !v)}
        >
          {/* `cpuPct` nulo é a primeira amostra depois de ligar o timer: não há
              delta ainda, e um 0% ali seria um número que ninguém mediu. */}
          <Cell
            label="CPU"
            pct={stats?.cpuPct ?? null}
            title={
              stats
                ? `CPU · Atelier em ${stats.appCpuPct}% e ${formatBytes(stats.appMemBytes)}`
                : 'CPU · aguardando a primeira amostra'
            }
          />
          <Cell
            label="MEM"
            pct={pc.memPct}
            title={stats ? `memória · ${pair(stats.memUsed, stats.memTotal)}` : 'memória'}
          />
          {/* Zeros = `statfs` falhou (volume de rede caído, caminho apagado) e a
              célula mostra `—` em vez de um anel vazio. */}
          <Cell
            label="DSK"
            pct={pc.diskPct}
            title={
              stats && stats.diskTotal > 0
                ? `${stats.diskPath} · ${pair(stats.diskUsed, stats.diskTotal)}`
                : 'disco sem leitura'
            }
          />

          {/* Só aparece quando há o que dizer: sem agente publicando custo e sem
              conta com leitura, o traço e dois `—` ocupariam metade da tira para
              informar nada. */}
          {(ai.costUsd !== null || ai.session !== null || ai.tightest !== null) && (
            <>
              <span className="monitor-dock-sep" />
              <span className="monitor-dock-ai">
                {ai.costUsd !== null && (
                  <span
                    className="monitor-dock-cost"
                    title="soma dos agentes deste canvas que publicam custo"
                  >
                    ${ai.costUsd.toFixed(2)}
                  </span>
                )}
                {/* A janela de SESSÃO primeiro, com o prazo: é a que decide se
                    dá para abrir mais um agente agora. */}
                {ai.session && <WindowCell window={ai.session} kind="session" />}
                {/* A mais apertada só quando ela é OUTRA e está acima da de
                    sessão. Repetir a mesma janela em duas caixinhas gastaria
                    largura para dizer duas vezes a mesma coisa, e mostrar uma
                    semanal mais folgada que a de sessão não muda decisão
                    nenhuma. */}
                {ai.tightest &&
                  ai.tightest.window !== ai.session?.window &&
                  ai.tightest.pct > (ai.session?.pct ?? -1) && (
                    <WindowCell window={ai.tightest} kind="tightest" />
                  )}
              </span>
            </>
          )}
        </button>

        {/* O painel de VERDADE, o mesmo componente do nó — não uma segunda
            implementação que pudesse discordar dele. Abre contra a borda pela
            conta que os menus da dock já usam (ver monitor-dock.css). */}
        {open && (
          <div
            className="monitor-dock-popover"
            role="dialog"
            data-edge={pill.placement.edge}
            // Sem isto, um `pointerdown` num `select` do painel armaria o
            // arrasto da pílula e a tira sairia andando com o menu aberto.
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <MonitorPanel
              blocks={blocks}
              intervalMs={interval}
              onChange={(patch) => {
                if (patch.blocks) setBlocks(patch.blocks)
                if (patch.interval) setIntervalMs(Number(patch.interval))
              }}
            />
          </div>
        )}
      </div>

      {pill.menu && (
        <PillMenu
          x={pill.menu.x}
          y={pill.menu.y}
          current={pill.placement}
          fallback={pill.fallback}
          onPick={pill.apply}
          onClose={pill.closeMenu}
          // A segunda ponta da alternância. A primeira é o item da dock, e as
          // duas nasceram no mesmo passo: "Ocultar" sem caminho de volta é o
          // estado ruim que o plano das docks móveis deixou registrado.
          extra={{ label: 'Ocultar a tira', run: () => void store.setMonitorDockVisible(false) }}
        />
      )}
    </>
  )
}

/**
 * Uma métrica na tira: o medidor com o número DENTRO, e a sigla ao lado (ou
 * embaixo, quando a tira está em pé — mas isso é assunto do CSS).
 *
 * O anel no lugar do traço, e o motivo é o que cada um responde. O sparkline
 * conta a HISTÓRIA dos últimos minutos; a tira é olhada de relance para saber
 * "quanto já foi do que dá", e para isso o traço obriga a estimar a altura da
 * ponta contra uma escala invisível. O anel é o mesmo desenho que o painel usa
 * nas janelas de conta — a tira deixou de ter dois vocabulários de medida, um
 * para a máquina e outro para as contas. O histórico continua a um clique, no
 * popover.
 *
 * O número foi para dentro do anel nas DUAS orientações, e não só na coluna
 * estreita onde ele não cabia ao lado. Duas peças em vez de três é menos coisa
 * para o olho percorrer, e o valor passa a ser lido no mesmo lugar em que o aro
 * já estava sendo olhado. De quebra some o motivo original da largura reservada
 * — o número não está mais no fluxo, então ele não pode mais esticar a célula e
 * fazer a pílula refluir a cada amostra.
 */
function Cell({ label, pct, title }: { label: string; pct: number | null; title: string }): JSX.Element {
  const danger = pct !== null && pct >= DANGER_PCT
  return (
    <span className={danger ? 'monitor-dock-cell is-danger' : 'monitor-dock-cell'} title={title}>
      <Gauge pct={pct} size={32} />
      <span className="monitor-dock-label">{label}</span>
    </span>
  )
}

/**
 * O agregado de IA da tira: quanto já custou, e qual janela fecha primeiro.
 *
 * Nada é coletado aqui — os dois canais (o que o agente PUBLICA pela
 * `statusLine` e o que o raspador de tela consegue ler) já chegam na store, e
 * as leituras guardadas vieram do disco no boot. Este hook é só o recorte, e
 * ele é o MESMO que os blocos IA e Perfis do painel fazem: a tira e o popover
 * não podem discordar sobre o total quando os dois estão abertos lado a lado.
 *
 * A conta que resolve `accountId` é a de `configDirFor` no main, repetida aqui
 * pelo mesmo motivo que no `AccountsBlock`: uma conta apagada cai na padrão, e
 * divergir faria a tira creditar o consumo a alguém que não existe mais.
 */
function useMonitorDockAI(): DockSummary {
  const {
    workspace,
    claudeAccounts,
    claudeAccountUsage,
    codexAccountUsage,
    terminalStatus,
    terminalUsage
  } = useStore()

  return useMemo(() => {
    const known = new Set(claudeAccounts.map((a) => a.id))
    const rows: AccountRow[] = []
    for (const node of workspace?.nodes ?? []) {
      if (node.content.type !== 'terminal') continue
      const id = node.content.value.claudeAccountId
      rows.push({
        accountId: id && known.has(id) ? id : DEFAULT_CLAUDE_ACCOUNT_ID,
        reading: mergeReading(terminalUsage[node.id], terminalStatus[node.id])
      })
    }

    const accounts = groupByAccount(rows, claudeAccountUsage)

    // A conta do Codex entra na mesma disputa: o bloco de Perfis já a mostra ao
    // lado das do Claude, e uma tira que ignorasse a janela mais apertada só
    // porque ela é do Codex discordaria do popover aberto logo acima dela.
    //
    // Sem `subscribeCodexAccount` aqui de propósito: a tira usa o que a store
    // JÁ tem — a leitura guardada que veio do boot, ou a viva se algum painel
    // de contas estiver aberto. Assinar em permanência é um custo que esta
    // rodada não decidiu pagar, e a alternativa seria a tira ligar um canal do
    // App Server por conta própria.
    if (
      codexAccountUsage.available &&
      codexAccountUsage.authMode !== 'api-key' &&
      codexAccountUsage.source !== 'none'
    ) {
      accounts.push({
        accountId: 'codex',
        limits: activeWindows(codexAccountUsage.limits),
        // O Codex não publica custo por sessão — `null` é "não sei", e somá-lo
        // como zero baixaria o total que a tira mostra.
        costUsd: null,
        live: 0,
        at: codexAccountUsage.at,
        source: codexAccountUsage.source
      })
    }

    return dockSummary(
      rows.map((r) => r.reading),
      accounts
    )
  }, [
    workspace,
    claudeAccounts,
    claudeAccountUsage,
    codexAccountUsage,
    terminalStatus,
    terminalUsage
  ])
}

/**
 * Uma janela de limite na tira — "◕ 5h 62% · 1h12".
 *
 * O anel é o mesmo das métricas de máquina e o mesmo do painel: "quanto já foi"
 * tem um desenho só no app inteiro.
 *
 * O PRAZO só acompanha a janela de sessão, e é a diferença que justifica a
 * caixinha existir. "62%" sozinho não diz se o aperto passa em vinte minutos ou
 * em quatro horas — e é essa resposta que decide entre esperar e trocar de
 * conta. Na janela semanal o prazo fica no `title`: um "6d03h" ao lado do
 * percentual gastaria largura para informar um prazo com que ninguém faz nada
 * hoje.
 *
 * O relógio se atualiza sozinho porque a tira já re-renderiza a cada amostra do
 * monitor — sem timer próprio para um texto que muda de minuto em minuto.
 */
function WindowCell({
  window: w,
  kind
}: {
  window: UsageWindow
  /** `session` mostra o prazo na tira; `tightest` o deixa no title. */
  kind: 'session' | 'tightest'
}): JSX.Element {
  const falta = untilReset(w.resetsAt)
  const what =
    kind === 'session'
      ? 'a janela de sessão mais apertada entre as contas'
      : 'a janela mais apertada entre as contas'
  return (
    <span
      className={w.pct >= DANGER_PCT ? 'monitor-dock-window is-danger' : 'monitor-dock-window'}
      title={falta ? `${w.window}: ${what} — reabre em ${falta}` : `${w.window}: ${what}`}
    >
      <Gauge pct={w.pct} size={28} />
      <span className="monitor-dock-window-name">{w.window}</span>
      {/* A pista do prazo é reservada mesmo sem prazo — `—` e não nada. Uma
          janela raspada da tela chega sem `resetsAt`, e deixar a coluna sumir
          faria a caixinha encolher e a tira refluir quando a leitura seguinte a
          trouxesse de volta. É a mesma regra do `—` das métricas. */}
      {kind === 'session' && (
        <span
          className="monitor-dock-window-reset"
          title={falta ? `reabre em ${falta}` : 'sem prazo publicado para esta janela'}
        >
          {falta ?? '—'}
        </span>
      )}
    </span>
  )
}
