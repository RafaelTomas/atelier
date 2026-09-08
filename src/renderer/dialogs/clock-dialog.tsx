/**
 * Diálogo do relógio — o lápis da barra de ações, mesmo caminho do botão.
 *
 * Mesma casca do diálogo de botão (Esc fecha, rascunho local, nada gravado até
 * confirmar). Edita um RASCUNHO: Cancelar não toca na corrida em andamento nem
 * no cabo — o `onSubmit` é o único momento em que qualquer coisa sai daqui.
 *
 * ─── Por que é organizado por MODO ──────────────────────────────────────────
 *
 * A versão anterior mostrava os três modos configuráveis de uma vez: quem abria
 * o lápis de um pomodoro via um campo de duração de timer que não tinha efeito
 * nenhum ali. Aqui o seletor de modo vem primeiro e o corpo mostra APENAS a
 * seção do modo selecionado — o formulário passa a descrever um aparelho num
 * estado, e não a união de quatro.
 *
 * O formato 12/24 h fica FORA das seções de modo, junto do seletor: ele vale
 * para todo modo que mostra hora (relógio e alarme), e enfiá-lo numa das duas
 * seções o esconderia da outra.
 *
 * ─── Por que o alvo do cabo mora aqui ───────────────────────────────────────
 *
 * A conexão não é parte de `ClockConfig` — é uma `Connection` do workspace. Mas
 * é a única coisa que transforma o nó num agendador, e o diálogo era MUDO sobre
 * ela: quem abria o lápis não descobria nem que o cabo existia. Pior, nos modos
 * relógio e cronômetro o cabo nunca dispara (`emitsEvents`), e nada na tela
 * dizia isso.
 *
 * Por isso o alvo entra no rascunho como qualquer campo: sai daqui pelo
 * `onSubmit`, e é a store que traduz "mudou o alvo" em cortar e ligar cabo.
 */
import { useEffect, useState } from 'react'
import type { CanvasNode, UUID } from '@shared/types'
import { buttonActionSummary, clockFireBlock, readButtonConfig } from '@shared/types'
import type { ClockConfig, ClockMode } from '@shared/clock'
import {
  ALARM_ALL_DAYS,
  ALARM_ONCE,
  ALARM_WEEKDAYS,
  CLOCK_MODES,
  alarmCountdown,
  clockModeLabel,
  defaultClockConfig,
  emitsEvents,
  formatDuration,
  nextAlarmAt,
  setAlarm,
  setHour12,
  setMode,
  setPomodoroDurations,
  setTimerDuration
} from '@shared/clock'
import { eligibleClockTargets } from '../canvas/connection-preview'
import { useStore } from '../state/store'

interface Props {
  /** O nó que está sendo editado — precisa dele para filtrar o próprio cabo. */
  nodeId: UUID
  /** Rascunho de partida. `null` = o nó ainda está no padrão. */
  initial: ClockConfig | null
  /** O botão hoje cabeado a este relógio, ou `null`. */
  initialTarget: UUID | null
  onCancel: () => void
  onSubmit: (config: ClockConfig, target: UUID | null) => void
}

export function ClockDialog({
  nodeId,
  initial,
  initialTarget,
  onCancel,
  onSubmit
}: Props): JSX.Element {
  const { workspace } = useStore()
  const [draft, setDraft] = useState<ClockConfig>(() => initial ?? defaultClockConfig())
  const [target, setTarget] = useState<UUID | null>(initialTarget)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const nodes = workspace?.nodes ?? []
  const connections = workspace?.connections ?? []
  // O botão JÁ cabeado não passa pelo filtro de elegibilidade (o relógio está
  // ocupado — por ele mesmo), então entra na lista à parte: sem isto o alvo
  // atual desapareceria do `<select>` que deveria mostrá-lo selecionado.
  const current = nodes.find((n) => n.id === target) ?? null
  const options = eligibleClockTargets(nodeId, nodes, connections)
  const choices = current && !options.some((n) => n.id === current.id) ? [current, ...options] : options
  // TODOS os botões do canvas, e não só os elegíveis: os barrados aparecem
  // desabilitados com o motivo, porque a pergunta que uma lista curta produz é
  // "onde está o meu botão?", e a resposta tem de estar onde o usuário olhou.
  const blocked = nodes.filter(
    (n) =>
      n.content.type === 'widget' &&
      n.content.value.kind === 'button' &&
      !choices.some((c) => c.id === n.id)
  )

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-label="Editar Relógio" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Editar Relógio</h2>

        <div className="modal-body">
          <div className="tab-pane">
            <div className="field-row">
              <label className="field-label">Modo</label>
              <div className="segmented is-small">
                {CLOCK_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={draft.mode === mode ? 'segment is-active' : 'segment'}
                    onClick={() => setDraft((d) => setMode(d, mode))}
                  >
                    {clockModeLabel(mode)}
                  </button>
                ))}
              </div>
            </div>

            {/* Só nos dois modos que mostram HORA. Num cronômetro ou num timer
                não há nada para ser 12 ou 24 horas. */}
            {(draft.mode === 'clock' || draft.mode === 'alarm') && (
              <div className="field-row">
                <label className="field-label">Formato</label>
                <div className="segmented is-small">
                  {([false, true] as const).map((h12) => (
                    <button
                      key={String(h12)}
                      type="button"
                      className={draft.hour12 === h12 ? 'segment is-active' : 'segment'}
                      onClick={() => setDraft((d) => setHour12(d, h12))}
                    >
                      {h12 ? '12 horas' : '24 horas'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {draft.mode === 'alarm' && <AlarmSection draft={draft} setDraft={setDraft} />}

            {draft.mode === 'timer' && (
              <>
                <span className="section-label">Timer</span>
                <DurationField
                  label="Duração"
                  ms={draft.timer.durationMs}
                  onChange={(ms) => setDraft((d) => setTimerDuration(d, ms))}
                />
                <p className="field-hint">
                  Editar a duração não mexe num timer que já está correndo —
                  zere antes para a mudança valer.
                </p>
              </>
            )}

            {draft.mode === 'pomodoro' && (
              <>
                <span className="section-label">Pomodoro</span>
                <DurationField
                  label="Foco"
                  ms={draft.pomodoro.focusMs}
                  onChange={(ms) => setDraft((d) => setPomodoroDurations(d, ms, d.pomodoro.breakMs))}
                />
                <DurationField
                  label="Pausa"
                  ms={draft.pomodoro.breakMs}
                  onChange={(ms) => setDraft((d) => setPomodoroDurations(d, d.pomodoro.focusMs, ms))}
                />
                <p className="field-hint">
                  Editar uma duração não mexe num pomodoro que já está
                  correndo — zere antes para a mudança valer.
                </p>
              </>
            )}

            {(draft.mode === 'clock' || draft.mode === 'stopwatch') && (
              <p className="field-hint">
                {draft.mode === 'clock'
                  ? 'O relógio mostra a hora do sistema e não tem o que configurar além do formato.'
                  : 'O cronômetro conta tempo de parede. Iniciar, pausar, volta e zerar são gestos do nó.'}
              </p>
            )}

            <TargetSection
              draft={draft}
              target={target}
              setTarget={setTarget}
              current={current}
              choices={choices}
              blocked={blocked}
            />
          </div>
        </div>

        <div className="modal-divider" />

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn is-primary" onClick={() => onSubmit(draft, target)}>
            Salvar
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Domingo primeiro, para casar com `Date.getDay()` e com o bit 0 da máscara. */
const DAY_CHIPS = [
  { bit: 0, short: 'D', name: 'domingo' },
  { bit: 1, short: 'S', name: 'segunda' },
  { bit: 2, short: 'T', name: 'terça' },
  { bit: 3, short: 'Q', name: 'quarta' },
  { bit: 4, short: 'Q', name: 'quinta' },
  { bit: 5, short: 'S', name: 'sexta' },
  { bit: 6, short: 'S', name: 'sábado' }
]

const ALARM_WEEKEND_MASK = 0b1000001

/**
 * Horário, dias e a frase do próximo disparo.
 *
 * A frase é o coração da coisa: ela transforma "480 minutos e cinco bits" numa
 * data que se confere de relance, e é derivada do RASCUNHO — muda enquanto o
 * usuário mexe nos chips, antes de salvar. Sem ela, a única forma de conferir
 * um alarme seria esperar a hora e ver se toca.
 */
function AlarmSection({
  draft,
  setDraft
}: {
  draft: ClockConfig
  setDraft: React.Dispatch<React.SetStateAction<ClockConfig>>
}): JSX.Element {
  const now = Date.now()
  const a = draft.alarm
  const hh = String(Math.floor(a.minutesOfDay / 60)).padStart(2, '0')
  const mm = String(a.minutesOfDay % 60).padStart(2, '0')

  const applyDays = (days: number): void => {
    setDraft((d) => setAlarm(d, d.alarm.minutesOfDay, days, Date.now()))
  }

  return (
    <>
      <span className="section-label">Alarme</span>

      <div className="field-row">
        <label className="field-label" htmlFor="clock-alarm-time">
          Horário
        </label>
        {/* `type="time"` nativo: teclado numérico, máscara e validação de
            graça. Dois `<select>` de hora e minuto seriam 84 opções para
            digitar quatro dígitos. */}
        <input
          id="clock-alarm-time"
          className="field-input"
          type="time"
          value={`${hh}:${mm}`}
          onChange={(e) => {
            const [h, m] = e.target.value.split(':').map(Number)
            if (!Number.isFinite(h) || !Number.isFinite(m)) return
            setDraft((d) => setAlarm(d, h * 60 + m, d.alarm.days, Date.now()))
          }}
        />
      </div>

      <div className="field-row">
        <span className="field-label">Repete</span>
        <div className="alarm-days" role="group" aria-label="Dias da semana">
          {DAY_CHIPS.map((day, index) => {
            const on = (a.days & (1 << day.bit)) !== 0
            return (
              <button
                // O índice entra na chave porque três letras se repetem (S, Q, S):
                // `short` sozinho não identifica o chip.
                key={`${day.short}-${index}`}
                type="button"
                className={on ? 'alarm-day is-on' : 'alarm-day'}
                aria-pressed={on}
                title={day.name}
                onClick={() => applyDays(a.days ^ (1 << day.bit))}
              >
                {day.short}
              </button>
            )
          })}
        </div>
      </div>

      {/* "Seg a sex" é o caso dominante de processo agendado, e chegar nele com
          sete cliques seria hostil. */}
      <div className="field-row">
        <span className="field-label" />
        <div className="alarm-presets">
          <button type="button" className="btn is-small" onClick={() => applyDays(ALARM_WEEKDAYS)}>
            Dias úteis
          </button>
          <button type="button" className="btn is-small" onClick={() => applyDays(ALARM_ALL_DAYS)}>
            Todos
          </button>
          <button type="button" className="btn is-small" onClick={() => applyDays(ALARM_WEEKEND_MASK)}>
            Fim de semana
          </button>
          <button type="button" className="btn is-small" onClick={() => applyDays(ALARM_ONCE)}>
            Uma vez
          </button>
        </div>
      </div>

      <p className="field-hint">
        {a.state === 'armed' ? (
          <>
            Próximo disparo: {nextOccurrenceLabel(draft, now)} ({alarmCountdown(draft, now)}).
          </>
        ) : (
          <>
            Desarmado — nada vai disparar. Armado, o próximo seria{' '}
            {nextOccurrenceLabel(draft, now)} ({alarmCountdown(draft, now)}). Armar é um gesto do
            nó: o botão fica na barra do relógio.
          </>
        )}
      </p>

      {a.days === ALARM_ONCE && (
        <p className="field-hint">
          Sem nenhum dia marcado o alarme toca UMA vez e se desarma sozinho.
        </p>
      )}

      {a.missedAt > 0 && (
        <p className="field-hint">
          O horário de {new Date(a.missedAt).toLocaleString()} passou com o Atelier fechado e nada
          foi disparado — um comando pode não fazer mais sentido horas depois. Salvar limpa o
          aviso; Cancelar o mantém.
        </p>
      )}
    </>
  )
}

/** `amanhã, seg 08/09 às 08:00` — data civil, que é como se confere um alarme. */
function nextOccurrenceLabel(config: ClockConfig, now: number): string {
  // Armado, a ocorrência ESPERADA é a que o checkpoint guarda — é ela que vai
  // disparar, e recalcular mostraria outra data se o horário acabou de mudar no
  // rascunho. Desarmado, `nextAlarmAt` prevê a próxima direto da agenda: ele
  // deriva de `minutesOfDay`/`days` e não olha o estado, então serve ao
  // rascunho sem precisar fingir que ele está armado.
  const at = config.alarm.state === 'armed' && config.alarm.armedAt > 0
    ? config.alarm.armedAt
    : nextAlarmAt(config, now)
  if (at <= 0) return 'nunca'
  const date = new Date(at)
  const today = new Date(now)
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000
  )
  const when = days === 0 ? 'hoje' : days === 1 ? 'amanhã' : null
  const civil = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit'
  }).format(date)
  const hour = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: config.hour12
  }).format(date)
  return when ? `${when}, ${civil} às ${hour}` : `${civil} às ${hour}`
}

/**
 * A que o relógio está ligado, e como trocar.
 *
 * O vazio é EXPLICATIVO, não silencioso: "este relógio não dispara nada" é a
 * informação que faltava, e é ela que faz o usuário entender por que o alarme
 * dele não fez nada.
 */
function TargetSection({
  draft,
  target,
  setTarget,
  current,
  choices,
  blocked
}: {
  draft: ClockConfig
  target: UUID | null
  setTarget: (id: UUID | null) => void
  current: CanvasNode | null
  choices: CanvasNode[]
  /** Botões do canvas que este relógio NÃO pode disparar, com o motivo à vista. */
  blocked: CanvasNode[]
}): JSX.Element {
  const summary = (node: CanvasNode): string => {
    if (node.content.type !== 'widget') return node.id.slice(0, 8)
    const config = readButtonConfig(node.content.value.view)
    return `${config.label || 'botão'} — ${clip(buttonActionSummary(config), 40)}`
  }

  /** O que o botão escolhido faz, inteiro — aqui há largura e quebra de linha. */
  const chosen = current?.content.type === 'widget' ? readButtonConfig(current.content.value.view) : null

  return (
    <>
      <span className="section-label">Ao disparar</span>

      {!emitsEvents(draft) && (
        <p className="field-hint">
          No modo {clockModeLabel(draft.mode)} o cabo nunca dispara — use Alarme, Timer ou
          Pomodoro para o botão rodar sozinho.
        </p>
      )}

      <div className="field-row">
        <label className="field-label" htmlFor="clock-target">
          Conectado a
        </label>
        <select
          id="clock-target"
          className="field-input"
          value={target ?? ''}
          onChange={(e) => setTarget((e.target.value || null) as UUID | null)}
        >
          <option value="">Nada — este relógio não dispara</option>
          {choices.map((node) => (
            <option key={node.id} value={node.id}>
              {summary(node)}
            </option>
          ))}
          {/* `disabled`, e não ausente: o botão continua visível na lista onde
              o usuário foi procurá-lo, com o motivo no próprio rótulo.

              Aqui o rótulo é só nome + motivo, sem o resumo da ação: o que
              importa numa opção que não dá para escolher é POR QUE não dá, e
              cada caractere a mais alarga o popup inteiro. */}
          {blocked.map((node) => (
            <option key={node.id} value={node.id} disabled>
              {buttonLabel(node)} — {blockLabel(node)}
            </option>
          ))}
        </select>
      </div>

      {chosen && (
        <p className="field-hint">
          <strong>{chosen.label || 'botão'}</strong> {buttonActionSummary(chosen)}
        </p>
      )}

      {blocked.length > 0 && (
        <p className="field-hint">
          {blocked.length === 1 ? 'Um botão está' : `${blocked.length} botões estão`} na lista mas
          não podem ser escolhidos. Num que <strong>pede confirmação</strong>, marque no lápis dele
          “…mas um relógio pode disparar sem confirmar” — a confirmação do clique continua valendo.
          Um botão <strong>proposto por um agente</strong> precisa do seu Aceitar no nó primeiro.
        </p>
      )}

      {target && !current && (
        <p className="field-hint">O botão que estava aqui não está mais no canvas.</p>
      )}

      {!target && choices.length === 0 && blocked.length === 0 && (
        <p className="field-hint">
          Não há nenhum botão neste canvas. Crie um — ele é o que o relógio vai apertar no
          horário.
        </p>
      )}

      {!target && choices.length > 0 && (
        <p className="field-hint">
          Este relógio não dispara nada. Escolha um botão para ele rodar no horário.
        </p>
      )}

      <p className="field-hint">
        Nada dispara com o Atelier fechado: um horário que vence com o app desligado é
        reconhecido na abertura, mas o comando não roda retroativamente.
      </p>
    </>
  )
}

/**
 * O motivo, em duas palavras, para caber no rótulo de uma `<option>`.
 *
 * O caso `null` existe porque a lista de barrados é "todo botão que não entrou
 * nas escolhas", e a elegibilidade é do `canLink` — se ele passar a recusar por
 * um motivo novo, este rótulo diz a verdade genérica em vez de inventar uma
 * confirmação que o botão não pede.
 */
function blockLabel(node: CanvasNode): string {
  if (node.content.type !== 'widget' || node.content.value.kind !== 'button') {
    return 'não pode ser disparado por um relógio'
  }
  switch (clockFireBlock(readButtonConfig(node.content.value.view))) {
    case 'pending':
      return 'aguarda seu aceite'
    case 'confirm':
      return 'pede confirmação'
    default:
      return 'não pode ser disparado por um relógio'
  }
}

/** O nome do botão, sem o que ele faz. */
function buttonLabel(node: CanvasNode): string {
  if (node.content.type !== 'widget') return node.id.slice(0, 8)
  return readButtonConfig(node.content.value.view).label || 'botão'
}

/**
 * Corta um resumo para caber no rótulo de uma `<option>`.
 *
 * Não é preciosismo de layout: o popup de um `<select>` nativo se dimensiona
 * pela opção MAIS LONGA, e um botão de agente carrega um prompt de vários
 * parágrafos no resumo. Sem o corte, a lista abria mais larga que a janela
 * inteira e escondia o próprio diálogo. O texto completo do botão ESCOLHIDO
 * aparece abaixo do campo, onde há largura e quebra de linha.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const HOUR_MS = 3_600_000
const MIN_MS = 60_000
const SEC_MS = 1_000

/**
 * Três campos h/m/s sobre um valor em milissegundos. O clamp e o piso de um
 * segundo são do módulo puro; aqui só se recompõe o total e se mostra o
 * resultado já normalizado (`formatDuration`), para o usuário ver onde o limite
 * o pegou.
 */
function DurationField({
  label,
  ms,
  onChange
}: {
  label: string
  ms: number
  onChange: (ms: number) => void
}): JSX.Element {
  const h = Math.floor(ms / HOUR_MS)
  const m = Math.floor((ms % HOUR_MS) / MIN_MS)
  const s = Math.floor((ms % MIN_MS) / SEC_MS)

  const part = (next: { h?: number; m?: number; s?: number }): void => {
    const nh = next.h ?? h
    const nm = next.m ?? m
    const ns = next.s ?? s
    onChange(nh * HOUR_MS + nm * MIN_MS + ns * SEC_MS)
  }

  const num = (raw: string): number => {
    const n = Math.floor(Number(raw))
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  return (
    <div className="field-row">
      <label className="field-label">{label}</label>
      <div className="clock-duration">
        <input className="field-input" type="number" min={0} value={h} onChange={(e) => part({ h: num(e.target.value) })} />
        <span>h</span>
        <input className="field-input" type="number" min={0} max={59} value={m} onChange={(e) => part({ m: num(e.target.value) })} />
        <span>m</span>
        <input className="field-input" type="number" min={0} max={59} value={s} onChange={(e) => part({ s: num(e.target.value) })} />
        <span>s</span>
      </div>
      <span className="field-hint">{formatDuration(ms)}</span>
    </div>
  )
}
