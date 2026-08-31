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
 * anéis, o NOME da conta em foco, a janela de SESSÃO dela com quanto falta para
 * reabrir e — só quando é outra e está mais cheia — a janela mais apertada.
 * Não a lista de contas: com três contas, três linhas de anéis numa borda
 * deixam de ser legíveis, e essa é a leitura que o popover faz bem.
 *
 * ─── O nome da conta, no lugar do custo ───
 *
 * A tira mostrava o custo somado dos agentes ali. Ele saiu, e não por falta de
 * espaço: um `$3,02` ao lado de dois percentuais convida a ler os três como se
 * fossem da mesma coisa, e não são — o custo é dos agentes DESTE canvas, as
 * janelas são das CONTAS. Pior, o número mudava a decisão de ninguém: quem olha
 * a tira quer saber se dá para abrir mais um agente agora, e o total gasto não
 * responde isso. Ele continua no popover, no bloco IA, onde está ao lado do que
 * o explica.
 *
 * No lugar dele entrou a pergunta que os percentuais deixavam sem resposta: de
 * QUEM são. Com duas contas abertas, `5h 61%` numa borda é um número órfão — o
 * usuário não sabe se está olhando a conta em que ele está trabalhando ou a
 * outra. O nome é o mínimo para o percentual significar alguma coisa, e ele é
 * também o botão: clicar troca a conta que a tira mostra, sem passar pelo
 * painel.
 *
 * A escolha é PERSISTIDA (`monitorDockAccountId`, em preferences.json) porque é
 * escolha, não estado de sessão: quem trabalha com duas contas alterna entre
 * elas o dia inteiro, e uma tira que voltasse ao padrão a cada abertura do app
 * esqueceria justamente o que se pediu para ela lembrar. O padrão `''` é a
 * conta AUTOMÁTICA — a mais apertada do momento —, que é o comportamento com
 * que a tira nasceu; a diferença é que agora ela diz de quem é o número.
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
import type { AccountRow, AccountUsage, UsageWindow } from '@shared/agent-usage'
import {
  activeWindows,
  agoLabel,
  groupByAccount,
  mergeReading,
  pickWindows,
  tightestAccount,
  untilReset
} from '@shared/agent-usage'
import { DEFAULT_CLAUDE_ACCOUNT_ID, formatBytes } from '@shared/types'
import { IconChevronDown } from './icons'
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

  useEffect(() => {
    // A tira assina, e agora isso é barato: do outro lado, assinar liga um
    // OBSERVADOR DE ARQUIVO nos rollouts do Codex (ver codex-rollout.ts), não um
    // subprocesso nem um relógio. O comentário que morava aqui dizia que
    // assinar em permanência era um custo que aquela rodada não decidiu pagar —
    // era verdade enquanto assinar significava levantar o App Server.
    //
    // E ela precisa assinar: a tira pode ser o único monitor montado na sessão,
    // e depender do cache do boot faria uma leitura velha parecer atual. O
    // ref-count do main compartilha o canal com o popover, quando os dois estão
    // abertos.
    void store.subscribeCodexAccount()
    return () => {
      void store.unsubscribeCodexAccount()
    }
  }, [])

  const pc = useMemo(() => {
    const memPct = stats && stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null
    const diskPct = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : null
    return { memPct, diskPct }
  }, [stats])

  const accounts = useMonitorDockAccounts()
  const { monitorDockAccountId } = useStore()

  /**
   * A conta em foco: a escolhida, ou a mais apertada quando não há escolha.
   *
   * O id que não bate com conta nenhuma cai na automática — é o caso da conta
   * apagada depois de escolhida, e também o do refresh de contas que ainda não
   * voltou. A alternativa seria a tira ficar vazia sem dizer por quê.
   */
  const focus = useMemo(() => {
    const chosen = accounts.find((a) => a.id === monitorDockAccountId)
    if (chosen) return chosen
    const best = tightestAccount(accounts.map((a) => a.usage).filter(isUsage))
    return accounts.find((a) => a.id === best?.accountId) ?? null
  }, [accounts, monitorDockAccountId])

  const windows = useMemo(() => pickWindows(focus?.usage?.limits ?? []), [focus])

  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
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
    if (!open && !picking) return
    const close = (): void => {
      setOpen(false)
      setPicking(false)
    }
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, picking])

  return (
    <>
      {/* Os alvos só existem durante o gesto: fora dele são quatro retângulos
          pintados sobre o canvas sem motivo. */}
      {pill.dragging && <PlacementTargets hot={pill.hot} />}
      <div
        // `monitor-dock`, e não `monitor`: a classe `.monitor` é do PAINEL, e
        // ela traz `overflow-y: auto` — numa pílula isso recorta tudo o que
        // abre para fora dela (o popover, o menu de contas), que ficam no DOM,
        // com posição certa, e invisíveis. Ver PILL_CLASS em use-pill.ts.
        className={
          pill.dragging ? 'floating pill monitor-dock is-dragging' : 'floating pill monitor-dock'
        }
        data-edge={pill.placement.edge}
        // A posição AO LONGO da borda é contínua: vai por CSS var, não por um
        // atributo de três valores (ver styles/floating.css).
        style={{ '--pill-offset': String(pill.placement.offset) } as React.CSSProperties}
        ref={rootRef}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={pill.onPointerDown}
        onContextMenu={pill.onContextMenu}
      >
        {/* A tira é uma linha de PEÇAS, e quase toda ela abre o popover: numa
            borda, um botão de abrir ao lado das leituras roubaria a largura de
            uma métrica. O chip da conta é a exceção — ele tem destino próprio,
            e por isso é um botão irmão e não um `<span>` clicável dentro do
            outro (botão dentro de botão não existe em HTML).

            O arrasto continua funcionando em todos eles porque o clique só vira
            gesto depois de 4px — ver DRAG_SLOP em use-placement.ts. */}
        <div className="monitor-dock-strip">
          <button
            type="button"
            className="monitor-dock-part"
            aria-haspopup="dialog"
            aria-expanded={open}
            title="Recursos da máquina — clique para o painel inteiro"
            onClick={() => setOpen((v) => !v)}
          >
            {/* `cpuPct` nulo é a primeira amostra depois de ligar o timer: não
                há delta ainda, e um 0% ali seria um número que ninguém mediu. */}
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
            {/* Zeros = `statfs` falhou (volume de rede caído, caminho apagado) e
                a célula mostra `—` em vez de um anel vazio. */}
            <Cell
              label="DSK"
              pct={pc.diskPct}
              title={
                stats && stats.diskTotal > 0
                  ? `${stats.diskPath} · ${pair(stats.diskUsed, stats.diskTotal)}`
                  : 'disco sem leitura'
              }
            />
          </button>

          {/* O bloco das contas só aparece quando há conta para nomear. Sem
              nenhuma, o traço e um chip vazio ocupariam metade da tira para
              informar nada. */}
          {accounts.length > 0 && (
            <>
              <span className="monitor-dock-sep" />
              <button
                type="button"
                className={
                  monitorDockAccountId ? 'monitor-dock-account' : 'monitor-dock-account is-auto'
                }
                aria-haspopup="menu"
                aria-expanded={picking}
                title={accountTitle(focus, monitorDockAccountId !== '')}
                onClick={() => {
                  setPicking((v) => !v)
                  setOpen(false)
                }}
              >
                <span className="monitor-dock-account-name">
                  {focus ? focus.label : 'sem leitura'}
                </span>
                <IconChevronDown size={9} />
              </button>

              {/* As janelas da conta em foco. Sem leitura elas somem inteiras —
                  um anel vazio afirmaria 0%, que é diferente de "não sei". */}
              {(windows.session !== null || windows.tightest !== null) && (
                <button
                  type="button"
                  className="monitor-dock-part"
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  title={`limites de ${focus?.label ?? 'conta'} — clique para o painel inteiro`}
                  onClick={() => setOpen((v) => !v)}
                >
                  {/* A janela de SESSÃO primeiro, com o prazo: é a que decide se
                      dá para abrir mais um agente agora. */}
                  {windows.session && <WindowCell window={windows.session} kind="session" />}
                  {/* A mais apertada só quando ela é OUTRA e está acima da de
                      sessão. Repetir a mesma janela em duas caixinhas gastaria
                      largura para dizer duas vezes a mesma coisa, e mostrar uma
                      semanal mais folgada que a de sessão não muda decisão
                      nenhuma. */}
                  {windows.tightest &&
                    windows.tightest.window !== windows.session?.window &&
                    windows.tightest.pct > (windows.session?.pct ?? -1) && (
                      <WindowCell window={windows.tightest} kind="tightest" />
                    )}
                </button>
              )}
            </>
          )}
        </div>

        {/* O menu de contas. Abre contra a borda pela mesma conta do popover —
            as duas peças herdam o `--pill-offset` da pílula. */}
        {picking && (
          <div
            className="monitor-dock-popover monitor-dock-accounts"
            role="menu"
            data-edge={pill.placement.edge}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <AccountItem
              label="Automática"
              hint="a conta mais apertada do momento"
              checked={monitorDockAccountId === ''}
              onPick={() => {
                void store.setMonitorDockAccount('')
                setPicking(false)
              }}
            />
            {accounts.map((account) => (
              <AccountItem
                key={account.id}
                label={account.label}
                hint={accountHint(account)}
                checked={monitorDockAccountId === account.id}
                onPick={() => {
                  void store.setMonitorDockAccount(account.id)
                  setPicking(false)
                }}
              />
            ))}
          </div>
        )}

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
 * Uma conta como a tira a vê: um nome e, quando existe, a leitura dela.
 *
 * A conta SEM leitura continua na lista de propósito — ela é escolhível. Quem
 * acabou de criar a segunda conta e quer a tira nela não deveria ter de abrir
 * um terminal primeiro só para o nome aparecer no menu.
 */
interface DockAccount {
  id: string
  label: string
  /** `null` = a conta existe e não há o que dizer sobre ela. */
  usage: AccountUsage | null
}

/** Estreita o `(AccountUsage | null)[]` do `map` sem um `as` no meio do caminho. */
function isUsage(u: AccountUsage | null): u is AccountUsage {
  return u !== null
}

/**
 * As contas da tira, com a leitura de cada uma.
 *
 * Nada é coletado aqui — os dois canais (o que o agente PUBLICA pela
 * `statusLine` e o que o raspador de tela consegue ler) já chegam na store, e
 * as leituras guardadas vieram do disco no boot. Este hook é só o recorte, e
 * ele é o MESMO que os blocos IA e Perfis do painel fazem: a tira e o popover
 * não podem discordar sobre uma conta quando os dois estão abertos lado a lado.
 *
 * A conta que resolve `accountId` é a de `configDirFor` no main, repetida aqui
 * pelo mesmo motivo que no `AccountsBlock`: uma conta apagada cai na padrão, e
 * divergir faria a tira creditar o consumo a alguém que não existe mais.
 */
function useMonitorDockAccounts(): DockAccount[] {
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

    const byId = new Map(groupByAccount(rows, claudeAccountUsage).map((a) => [a.accountId, a]))
    const out: DockAccount[] = []

    // A do Codex primeiro, como no bloco de Perfis: uma tira que a listasse
    // depois discordaria do popover aberto logo acima dela.
    if (codexAccountUsage.available && codexAccountUsage.authMode !== 'api-key') {
      out.push({
        id: 'codex',
        label: 'Codex',
        usage:
          codexAccountUsage.source === 'none'
            ? null
            : {
                accountId: 'codex',
                limits: activeWindows(codexAccountUsage.limits),
                // O Codex não publica custo por sessão — `null` é "não sei", e
                // um zero aqui viraria uma afirmação que ninguém mediu.
                costUsd: null,
                live: 0,
                at: codexAccountUsage.at,
                source: codexAccountUsage.source
              }
      })
    }

    for (const account of claudeAccounts) {
      out.push({ id: account.id, label: account.label, usage: byId.get(account.id) ?? null })
    }

    return out
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
 * O `title` do chip. Diz DUAS coisas que o nome sozinho não diz: se a conta foi
 * fixada ou eleita pela tira, e de quando é a leitura — um percentual guardado
 * no boot é verdadeiro sem ser de agora, e essa diferença muda o quanto se
 * confia nele.
 */
function accountTitle(account: DockAccount | null, fixed: boolean): string {
  const how = fixed
    ? 'conta fixada — clique para trocar'
    : 'conta escolhida sozinha, a mais apertada — clique para fixar uma'
  if (!account) return `nenhuma conta com leitura — ${how}`
  const when =
    account.usage === null || account.usage.source === 'none'
      ? 'sem leitura'
      : account.usage.source === 'stored'
        ? `última leitura ${agoLabel(account.usage.at) ?? 'guardada'}`
        : `medindo agora${account.usage.live > 0 ? ` · ${account.usage.live} agente(s)` : ''}`
  return `${account.label} · ${when} — ${how}`
}

/** A linha de apoio de cada item do menu: o que já se sabe daquela conta. */
function accountHint(account: DockAccount): string {
  const usage = account.usage
  if (!usage || usage.limits.length === 0) return 'sem leitura'
  const windows = usage.limits.map((w) => `${w.window} ${Math.round(w.pct)}%`).join(' · ')
  return usage.source === 'stored' ? `${windows} · ${agoLabel(usage.at) ?? 'guardado'}` : windows
}

/**
 * Um item do menu de contas. `menuitemradio` e não `menuitem`: a escolha é
 * exclusiva e o leitor de tela precisa saber qual está valendo — é a mesma
 * informação que o ✓ dá para quem enxerga.
 */
function AccountItem({
  label,
  hint,
  checked,
  onPick
}: {
  label: string
  hint: string
  checked: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={checked ? 'monitor-dock-account-item is-on' : 'monitor-dock-account-item'}
      onClick={onPick}
    >
      <span className="monitor-dock-account-item-label">{label}</span>
      <span className="monitor-dock-account-item-hint">{hint}</span>
    </button>
  )
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
