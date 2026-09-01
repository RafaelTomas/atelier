/**
 * Monitor de recursos — três blocos: PC, IA e Perfis.
 *
 * Responde as três perguntas que o canvas deixava sem resposta: "a máquina
 * aguenta mais um agente?", "quanto já gastei?" e "em qual conta ainda me
 * sobra janela?". A segunda tinha o dado, mas espalhado pelo rodapé de cada nó
 * de terminal — com seis agentes na tela, ler seis rodapés não é ler nada.
 *
 * A terceira é a que o bloco de PERFIS acrescenta, e o recorte dela é outro: o
 * limite de 5h e o de 7d são da CONTA, não do terminal. Dois agentes na mesma
 * conta consomem a mesma janela, e três contas na tela são três janelas
 * independentes — é a diferença entre "aquele agente está caro" e "não abro
 * mais nada nesta conta hoje".
 *
 * Fica em `panels/`, e não em `nodes/`, pelo mesmo caminho que `ProjectPanel` e
 * `GitPanel` percorreram: a rail pode querer o mesmo painel depois, e um painel
 * que já nasce independente da casca não precisa ser extraído mais tarde.
 *
 * As amostras NÃO passam pela store — ver `use-system-stats.ts`, que é onde a
 * regra está escrita.
 *
 * O medidor, o sparkline e o par de bytes moram em `monitor-parts.tsx`: a tira
 * de borda mede as mesmas coisas, e o limiar do vermelho não pode divergir
 * entre as duas telas.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AccountRow, AgentReading } from '@shared/agent-usage'
import { aggregateLimits, groupByAccount, mergeReading, sumCost, untilReset } from '@shared/agent-usage'
import type { UUID } from '@shared/types'
import { DEFAULT_CLAUDE_ACCOUNT_ID, formatBytes, formatTokens } from '@shared/types'
import { IconPlus, IconReload } from '../icons'
import { store, useStore } from '../state/store'
import { DEFAULT_INTERVAL, INTERVALS, useSystemStats } from '../state/use-system-stats'
import { AccountLine, CodexAccountLine, DANGER_PCT, Meter, pair } from './monitor-parts'

export type MonitorBlocks = 'pc' | 'ai' | 'accounts' | 'both'

interface Props {
  /** `view.blocks` do nó. */
  blocks?: MonitorBlocks
  /** `view.interval` do nó, em ms. */
  intervalMs?: number
  /** `view.disk` do nó. Vazio = o `workingDirectory` do workspace, no main. */
  diskPath?: string
  /** Ausente = o painel não oferece a configuração (uso fora de um nó). */
  onChange?: (patch: { blocks?: MonitorBlocks; interval?: string }) => void
}

export function MonitorPanel({
  blocks = 'both',
  intervalMs = DEFAULT_INTERVAL,
  diskPath = '',
  onChange
}: Props): JSX.Element {
  const { stats, history } = useSystemStats(diskPath, intervalMs)

  return (
    <div className="monitor">
      {(blocks === 'pc' || blocks === 'both') && <PCBlock stats={stats} history={history} />}
      {(blocks === 'ai' || blocks === 'both') && <AIBlock />}
      {(blocks === 'accounts' || blocks === 'both') && <AccountsBlock />}

      {onChange && (
        <div className="monitor-config">
          <select
            className="monitor-select"
            value={blocks}
            onChange={(e) => onChange({ blocks: e.target.value as MonitorBlocks })}
            title="Quais blocos mostrar"
          >
            <option value="both">PC + IA + contas</option>
            <option value="pc">só PC</option>
            <option value="ai">só IA</option>
            <option value="accounts">só contas</option>
          </select>
          <select
            className="monitor-select"
            value={String(intervalMs)}
            onChange={(e) => onChange({ interval: e.target.value })}
            title="Período de amostragem"
          >
            {INTERVALS.map((ms) => (
              <option key={ms} value={String(ms)}>
                {ms / 1000}s
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

// ─── Bloco PC ─────────────────────────────────────────────────────────────────

function PCBlock({
  stats,
  history
}: {
  stats: ReturnType<typeof useSystemStats>['stats']
  history: ReturnType<typeof useSystemStats>['history']
}): JSX.Element {
  const memPct = stats && stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null
  const diskPct = stats && stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : null

  return (
    <section className="monitor-block">
      <h4 className="monitor-title">PC</h4>

      {/* `cpuPct` nulo é a primeira amostra depois de ligar o timer: não há
          delta ainda, e um 0% ali seria um número que ninguém mediu. */}
      <Meter
        label="CPU"
        pct={stats?.cpuPct ?? null}
        value={stats?.cpuPct === null || stats === null ? '—' : `${stats.cpuPct}%`}
        series={history.cpu}
      />

      {/* Some no Windows, onde `os.loadavg()` devolve 0 sem significado — um
          "0,00" na tela seria lido como "sem carga". */}
      {stats?.loadAvg !== null && stats !== null && (
        <div className="monitor-row monitor-row-plain">
          <span className="monitor-label">Carga</span>
          <span className="monitor-value">{stats.loadAvg?.toFixed(2).replace('.', ',')}</span>
        </div>
      )}

      <Meter
        label="Memória"
        pct={memPct}
        value={stats ? pair(stats.memUsed, stats.memTotal) : '—'}
        series={history.mem}
      />

      {/* Zeros = `statfs` falhou (volume de rede caído, caminho apagado). O
          resto da amostra continua válido, então só esta linha mostra `—`. */}
      <Meter
        label="Disco"
        pct={diskPct}
        value={stats && stats.diskTotal > 0 ? pair(stats.diskUsed, stats.diskTotal) : '—'}
        title={stats?.diskPath}
      />

      {/* O "quanto EU custo", em uma linha: com oito terminais abertos, a
          pergunta não é quanto o sistema usa, é se o culpado é o Atelier. */}
      <div className="monitor-row monitor-row-plain monitor-app">
        <span className="monitor-label">Atelier</span>
        <span className="monitor-value">
          {stats ? `${stats.appCpuPct}% · ${formatBytes(stats.appMemBytes)}` : '—'}
        </span>
      </div>
    </section>
  )
}

// ─── Bloco IA ─────────────────────────────────────────────────────────────────

/**
 * Uma linha por terminal, o agregado das janelas de limite e o custo somado.
 *
 * Duas fontes por trás de cada linha, e a diferença entre elas é o assunto de
 * `shared/agent-usage.ts`: o que o agente PUBLICA pela `statusLine` (modelo,
 * contexto com o tamanho da janela, custo, limites com hora de reset) e o que
 * `scanAgentStatus` consegue RASPAR da tela. A publicada vence sempre; a
 * raspada é o que sobra para Codex, Antigravity e OpenCode, que não têm
 * `statusLine`. Um ponto ao lado do nome diz de qual delas veio a linha.
 *
 * Coleta nenhuma acontece aqui: os dois canais já chegam na store. Este bloco é
 * só a vista — e a vista continua se recusando a somar TOKENS entre agentes.
 * Custo, sim: dólar é a mesma unidade em todo agente.
 */
function AIBlock(): JSX.Element {
  const { workspace, terminalStatus, terminalUsage } = useStore()

  const rows = useMemo(() => {
    const nodes = workspace?.nodes ?? []
    return nodes
      .filter((n) => n.content.type === 'terminal')
      .map((n) => ({
        id: n.id as UUID,
        name: n.content.type === 'terminal' ? n.content.value.name : '',
        reading: mergeReading(terminalUsage[n.id], terminalStatus[n.id])
      }))
  }, [workspace, terminalStatus, terminalUsage])

  const windows = useMemo(() => aggregateLimits(rows.map((r) => r.reading)), [rows])
  const total = useMemo(() => sumCost(rows.map((r) => r.reading)), [rows])

  return (
    <section className="monitor-block">
      <h4 className="monitor-title">
        IA
        {/* O agregado é o MÁXIMO de cada janela, nunca a soma: a pergunta é
            "qual das minhas janelas está mais apertada". O prazo vem junto —
            "7d 58%" sem hora de reset é um número sem validade. */}
        {windows.map((w) => {
          const falta = untilReset(w.resetsAt)
          return (
            <span
              key={w.window}
              className={w.pct >= DANGER_PCT ? 'monitor-window is-danger' : 'monitor-window'}
              title={
                falta
                  ? `maior ${w.window} entre os agentes — reabre em ${falta}`
                  : `maior ${w.window} entre os agentes`
              }
            >
              {w.window} {Math.round(w.pct)}%{falta ? ` · ${falta}` : ''}
            </span>
          )
        })}
        {/* A ÚNICA soma honesta deste painel. `null` quando ninguém publicou
            custo: um "US$ 0,00" ali seria "não gastei nada" quando o certo é
            "não sei" — a diferença que o raspador de tela nunca soube marcar. */}
        {total !== null && (
          <span className="monitor-window monitor-cost" title="soma dos agentes que publicam custo">
            ${total.toFixed(2)}
          </span>
        )}
      </h4>

      {rows.length === 0 ? (
        <p className="monitor-empty">nenhum terminal neste canvas</p>
      ) : (
        <ul className="monitor-agents">
          {rows.map((r) => (
            <AgentRow key={r.id} name={r.name} reading={r.reading} />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * A linha de um agente.
 *
 * Os números são de UM agente e ficam juntos dele, na unidade que ele publicou
 * — é a razão de a linha existir em vez de um total. `—` significa "este agente
 * não publicou", nunca "zero".
 */
function AgentRow({ name, reading }: { name: string; reading: AgentReading }): JSX.Element {
  const ctx = reading.contextPct
  return (
    <li className="monitor-agent">
      {/* O ponto marca a PROCEDÊNCIA. Um número raspado da tela vale menos que
          um publicado pelo agente, e quem olha o painel merece saber quando
          está lendo uma leitura de segunda mão. */}
      <span
        className={`monitor-source is-${reading.source}`}
        title={
          reading.source === 'statusline'
            ? 'publicado pelo agente (statusLine)'
            : reading.source === 'app-server'
              ? 'publicado pelo Codex App Server'
            : reading.source === 'screen'
              ? 'lido da tela do agente — sem statusLine neste preset'
              : 'sem leitura'
        }
      />
      <span className="monitor-agent-name" title={reading.model ? `${name} · ${reading.model}` : name}>
        {name}
      </span>
      {/* O modelo só aparece quando o agente o publica: adivinhá-lo pelo nome
          que o usuário deu ao nó seria inventar. */}
      {reading.model && <span className="monitor-agent-model">{reading.model}</span>}
      <span
        className="monitor-agent-ctx"
        title={
          reading.contextWindowSize
            ? `janela de ${formatTokens(reading.contextWindowSize)} tokens`
            : undefined
        }
      >
        {ctx !== null ? `${Math.round(ctx)}%` : '—'}
      </span>
      <span className="monitor-agent-tok">
        {reading.tokens !== null ? formatTokens(reading.tokens) : '—'}
      </span>
      <span className="monitor-agent-cost">
        {reading.costUsd !== null ? `$${reading.costUsd.toFixed(2)}` : '—'}
      </span>
    </li>
  )
}

// ─── Bloco Perfis ─────────────────────────────────────────────────────────────

/**
 * Uma linha por CONTA do Claude, com o anel de cada janela de limite.
 *
 * A pergunta que este bloco responde não é a do bloco IA. Lá, cada linha é um
 * processo e o agregado é o máximo entre todos — a leitura certa quando os
 * agentes podem estar em contas diferentes. Aqui a unidade é a conta, porque é
 * ela que tem o limite: dois agentes na mesma conta gastam a MESMA janela, e o
 * usuário que troca de conta para continuar trabalhando precisa ver as duas
 * lado a lado antes de escolher em qual abre o próximo.
 *
 * Nada é coletado aqui. As leituras vivas já estão na store (`terminalUsage`),
 * e as guardadas vieram do disco no boot (`claudeAccountUsage`) — a decisão de
 * qual das duas vale, e de quando uma leitura guardada venceu, é de
 * `groupByAccount`, em shared/agent-usage.ts.
 *
 * ─── O que este bloco NÃO faz ───
 *
 * Não sonda a API. Uma conta sem terminal aberto e sem leitura válida mostra
 * anéis vazios, e o ↻ relê o que já existe — buscar o percentual de verdade
 * exigiria uma chamada por conta, gasta da mesma janela que o painel mede.
 */
function AccountsBlock(): JSX.Element {
  const { workspace, claudeAccounts, claudeAccountUsage, codexAccountUsage, terminalStatus, terminalUsage } = useStore()
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')

  useEffect(() => {
    void store.subscribeCodexAccount()
    return () => {
      void store.unsubscribeCodexAccount()
    }
  }, [])

  const usage = useMemo(() => {
    // Conta que não existe mais cai na padrão — a MESMA regra do `configDirFor`
    // no main, que é quem decide de fato onde o PTY vai subir. Divergir aqui
    // faria o painel creditar o consumo a uma conta que já foi apagada.
    const known = new Set(claudeAccounts.map((a) => a.id))
    const resolve = (id: string | null): string =>
      id && known.has(id) ? id : DEFAULT_CLAUDE_ACCOUNT_ID

    const rows: AccountRow[] = []
    for (const node of workspace?.nodes ?? []) {
      if (node.content.type !== 'terminal') continue
      rows.push({
        accountId: resolve(node.content.value.claudeAccountId),
        reading: mergeReading(terminalUsage[node.id], terminalStatus[node.id])
      })
    }
    return new Map(groupByAccount(rows, claudeAccountUsage).map((a) => [a.accountId, a]))
  }, [workspace, claudeAccounts, claudeAccountUsage, terminalStatus, terminalUsage])

  async function create(): Promise<void> {
    const name = label.trim()
    if (!name) return
    await store.createClaudeAccount(name)
    setLabel('')
    setAdding(false)
  }

  return (
    <section className="monitor-block">
      <h4 className="monitor-title">
        Contas de IA
        <span className="monitor-title-actions">
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Reler contas Claude e limites Codex"
            onClick={() => {
              void store.refreshClaudeAccounts()
              void store.refreshCodexAccount()
            }}
          >
            <IconReload size={12} />
          </button>
          <button
            type="button"
            className="icon-btn ghost-btn"
            title="Adicionar conta"
            onClick={() => setAdding((v) => !v)}
          >
            <IconPlus size={12} />
          </button>
        </span>
      </h4>

      {adding && (
        <div className="monitor-account-add">
          <input
            autoFocus
            className="monitor-input"
            placeholder="Nome da conta (ex: Trabalho)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
              if (e.key === 'Escape') setAdding(false)
              // O canvas escuta teclas globais; sem isto, digitar aqui
              // dispararia atalhos de ferramenta.
              e.stopPropagation()
            }}
          />
        </div>
      )}

      {codexAccountUsage.available && (
        <>
          <div className="monitor-account-section">Codex</div>
          <ul className="monitor-accounts">
            <CodexAccountLine usage={codexAccountUsage} />
          </ul>
        </>
      )}

      <div className="monitor-account-section">Claude</div>

      {claudeAccounts.length === 0 ? (
        <p className="monitor-empty">contas não carregadas</p>
      ) : (
        <ul className="monitor-accounts">
          {claudeAccounts.map((account) => (
            <AccountLine key={account.id} account={account} usage={usage.get(account.id)} />
          ))}
        </ul>
      )}
    </section>
  )
}

