/**
 * Diálogo do relógio — o lápis da barra de ações, mesmo caminho do botão.
 *
 * Mesma casca do diálogo de botão (Esc fecha, rascunho local, nada gravado até
 * confirmar). Edita um RASCUNHO: Cancelar não toca na corrida em andamento — o
 * `onSubmit` é o único momento em que a configuração sai daqui.
 *
 * O que se edita aqui é só CONFIGURAÇÃO: formato 12/24h, duração do timer e as
 * duas durações do pomodoro. Iniciar, pausar, zerar e volta são gestos do nó,
 * não deste formulário. Os campos aceitam horas/minutos/segundos, mas quem
 * converte para milissegundos inteiros e aplica limites é o módulo puro
 * (`setTimerDuration`, `setPomodoroDurations`, que passam por `clampDuration`).
 */
import { useEffect, useState } from 'react'
import type { ClockConfig } from '@shared/clock'
import {
  defaultClockConfig,
  formatDuration,
  setHour12,
  setPomodoroDurations,
  setTimerDuration
} from '@shared/clock'

interface Props {
  /** Rascunho de partida. `null` = o nó ainda está no padrão. */
  initial: ClockConfig | null
  onCancel: () => void
  onSubmit: (config: ClockConfig) => void
}

export function ClockDialog({ initial, onCancel, onSubmit }: Props): JSX.Element {
  const [draft, setDraft] = useState<ClockConfig>(() => initial ?? defaultClockConfig())

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

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-label="Editar Relógio" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Editar Relógio</h2>

        <div className="modal-body">
          <div className="tab-pane">
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

            <span className="section-label">Timer</span>
            <DurationField
              label="Duração"
              ms={draft.timer.durationMs}
              onChange={(ms) => setDraft((d) => setTimerDuration(d, ms))}
            />

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
              Editar uma duração não mexe num timer ou pomodoro que já está
              correndo — zere antes para a mudança valer.
            </p>
          </div>
        </div>

        <div className="modal-divider" />

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn is-primary" onClick={() => onSubmit(draft)}>
            Salvar
          </button>
        </footer>
      </div>
    </div>
  )
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
