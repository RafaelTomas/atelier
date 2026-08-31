/**
 * Mostrador do nó de relógio.
 *
 * O tempo não mora aqui: o coordenador encontra o contêiner e o readout pelos
 * atributos `data-` e os atualiza direto. Este componente só desenha o primeiro
 * quadro e persiste gestos semânticos; um tique React por nó foi descartado.
 */
import { useEffect, useRef, useState } from 'react'
import type { CanvasNode, WidgetContent } from '@shared/types'
import type { ClockConfig, ClockMode } from '@shared/clock'
import {
  CLOCK_MODES,
  DEFAULT_CLOCK_COLOR,
  advancePomodoroPhase,
  clockModeLabel,
  formatDuration,
  lapStopwatch,
  readClockConfig,
  resetPomodoro,
  resetStopwatch,
  resetTimer,
  setHour12,
  setMode,
  setPomodoroDurations,
  setTimerDuration,
  togglePomodoro,
  toggleStopwatch,
  toggleTimer,
  writeClockConfig
} from '@shared/clock'
import { readoutFor } from '../state/clock-coordinator'
import { segmentMarkup } from './seven-segment'
import { useClockDisplay } from '../state/use-clock-display'
import { store } from '../state/store'

/**
 * As cores de LED oferecidas no menu de ação.
 *
 * Cinco, e não a paleta de oito dos nós: estas são as cores que um display de
 * painel REALMENTE tem, e é essa a metáfora do nó. Um LED rosa ou marrom não
 * existe no objeto que o mostrador imita, e oferecê-lo transformaria um
 * aparelho num adesivo colorido.
 *
 * Só o LED aceso é escolhido. As barras apagadas e o brilho saem daqui por
 * `color-mix` no CSS — ver clock-widget.css.
 */
export const CLOCK_COLORS: { value: string; label: string }[] = [
  { value: DEFAULT_CLOCK_COLOR, label: 'Vermelho' },
  { value: '#ffb02e', label: 'Âmbar' },
  { value: '#32d74b', label: 'Verde' },
  { value: '#0a84ff', label: 'Azul' },
  { value: '#e8eaed', label: 'Branco' }
]

export function ClockWidget({ node, content }: { node: CanvasNode; content: WidgetContent }): JSX.Element {
  const config = readClockConfig(content.view)
  const [editing, setEditing] = useState(false)
  const displayRef = useClockDisplay(node.id, config.mode, editing)
  const [draft, setDraft] = useState('')
  const fieldRef = useRef<HTMLInputElement>(null)
  const { readout, detail } = readoutFor(config, Date.now())

  useEffect(() => {
    if (!editing) return
    fieldRef.current?.focus()
    fieldRef.current?.select()
  }, [editing])

  const apply = (next: ClockConfig): void => {
    void store.patchContent(node.id, { view: writeClockConfig(next, content.view) })
  }

  const startEditing = (): void => {
    if (config.mode === 'clock') {
      apply(setHour12(config, !config.hour12))
      return
    }
    if (config.mode === 'stopwatch') return
    setDraft(formatDuration(currentDuration(config)))
    setEditing(true)
  }

  const commit = (): void => {
    const duration = parseDuration(draft)
    if (duration !== null) {
      if (config.mode === 'timer') apply(setTimerDuration(config, duration))
      if (config.mode === 'pomodoro') {
        const p = config.pomodoro
        apply(setPomodoroDurations(config, p.phase === 'focus' ? duration : p.focusMs, p.phase === 'break' ? duration : p.breakMs))
      }
    }
    setEditing(false)
  }

  return (
    <div
      className="clock-widget"
      data-clock-node={node.id}
      ref={displayRef}
      // A cor escolhida entra como custom property, e não como classe: são cinco
      // hoje e o campo aceita qualquer `#rrggbb`, então uma classe por cor
      // viraria uma tabela que envelhece a cada cor nova — a mesma decisão do
      // `--btn-color` do botão. O resto do visor é derivado dela no CSS.
      style={{ '--clock-led': config.color } as React.CSSProperties}
    >
      <div className="clock-toolbar">
        {/* Quatro ícones, não um `<select>`: o modo é o estado mais consultado do
            nó e o mais barato de mostrar — um desenho diz qual está ativo sem
            gastar uma linha de texto, que num nó de 140px é o recurso escasso.
            O `<select>` também escondia três dos quatro estados atrás de um
            clique, e trocar de modo aqui é gesto frequente, não configuração. */}
        <div className="clock-modes" role="tablist" aria-label="Modo do relógio">
          {CLOCK_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={config.mode === mode}
              className={config.mode === mode ? 'clock-mode is-active' : 'clock-mode'}
              title={clockModeLabel(mode)}
              onMouseDown={stop}
              onClick={() => apply(setMode(config, mode))}
            >
              <ModeIcon mode={mode} />
            </button>
          ))}
        </div>
        <div className="clock-controls" aria-label="Controles">
          {config.mode === 'stopwatch' && <>
            <button type="button" className="clock-btn is-primary" onMouseDown={stop} onClick={() => apply(toggleStopwatch(config, Date.now()))}>{config.stopwatch.state === 'running' ? 'Pausar' : 'Iniciar'}</button>
            <button type="button" className="clock-btn" disabled={config.stopwatch.state !== 'running'} onMouseDown={stop} onClick={() => apply(lapStopwatch(config, Date.now()))}>Volta</button>
            <button type="button" className="clock-btn" onMouseDown={stop} onClick={() => apply(resetStopwatch(config))}>Zerar</button>
          </>}
          {config.mode === 'timer' && <>
            <button type="button" className="clock-btn is-primary" onMouseDown={stop} onClick={() => apply(toggleTimer(config, Date.now()))}>{config.timer.state === 'running' ? 'Pausar' : 'Iniciar'}</button>
            <button type="button" className="clock-btn" onMouseDown={stop} onClick={() => apply(resetTimer(config))}>Zerar</button>
          </>}
          {config.mode === 'pomodoro' && <>
            <button type="button" className="clock-btn is-primary" onMouseDown={stop} onClick={() => apply(togglePomodoro(config, Date.now()))}>{config.pomodoro.state === 'running' ? 'Pausar' : 'Iniciar'}</button>
            <button type="button" className="clock-btn" onMouseDown={stop} onClick={() => apply(advancePomodoroPhase(config, Date.now()))}>Fase</button>
            <button type="button" className="clock-btn" onMouseDown={stop} onClick={() => apply(resetPomodoro(config))}>Zerar</button>
          </>}
          {config.mode === 'timer' && config.timer.state === 'finished' && <span className="clock-finished" title="O timer terminou; nada é disparado retroativamente.">Terminado</span>}
        </div>
      </div>

      <div className="clock-display" title={readoutHint(config)}>
        {editing ? (
          <input
            ref={fieldRef}
            className="clock-readout-input"
            value={draft}
            aria-label="Duração"
            inputMode="numeric"
            onMouseDown={stop}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commit() }
              if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
            }}
          />
        ) : (
          // Ao editar este elemento SAI da árvore: o coordenador não pode escrever
          // por cima do rascunho. Ao fechar, o hook de registro o reencontra.
          //
          // `data-clock-segments` é o pedido de formato: com ele o coordenador
          // escreve o SVG das barras em vez de texto cru. E o markup vem da
          // MESMA função que ele usa (`segmentMarkup`), não de um JSX paralelo —
          // dois desenhos do mesmo mostrador divergiriam no primeiro ajuste, e a
          // divergência apareceria como um piscar na montagem. Nada digitado
          // pelo usuário passa por aqui: a edição é um `<input>` comum.
          <div
            className="clock-readout"
            data-clock-readout
            data-clock-segments
            data-clock-value={readout}
            role="timer"
            aria-live="off"
            aria-label={readout}
            onDoubleClick={startEditing}
            dangerouslySetInnerHTML={{ __html: segmentMarkup(readout) }}
          />
        )}
        {/* A ÚNICA linha que voltou depois do corte, e por um motivo concreto:
            sem ela o pomodoro mostra um número e nada mais — não dá para saber
            se aquilo é foco ou pausa, nem quantos ciclos já fecharam, e essa
            informação não tem outra casa no nó. Ela também é onde o cronômetro
            diz quantas voltas existem, já que a LISTA saiu (ver o CSS).
            Fica abaixo do número e minúscula: não disputa o mostrador. */}
        {!editing && <div className="clock-detail" data-clock-detail>{detail}</div>}
      </div>
    </div>
  )
}

function currentDuration(config: ClockConfig): number {
  if (config.mode === 'timer') return config.timer.durationMs
  return config.pomodoro.phase === 'focus' ? config.pomodoro.focusMs : config.pomodoro.breakMs
}

/** Aceita minutos soltos e relógios H:MM:SS/MM:SS; lixo não altera uma corrida. */
function parseDuration(value: string): number | null {
  const parts = value.trim().split(':')
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null
  const numbers = parts.map(Number)
  if (parts.length === 1) return numbers[0] * 60_000
  if (parts.length === 2) return (numbers[0] * 60 + numbers[1]) * 1_000
  return (numbers[0] * 3_600 + numbers[1] * 60 + numbers[2]) * 1_000
}

function readoutHint(config: ClockConfig): string {
  if (config.mode === 'clock') return 'Duplo clique alterna 12/24 h'
  if (config.mode === 'stopwatch') return 'Cronômetro'
  return config.mode === 'pomodoro'
    ? 'Duplo clique edita a duração da fase atual; a corrida só usa a mudança ao zerar.'
    : 'Duplo clique edita a duração; a corrida só usa a mudança ao zerar.'
}

function stop(event: React.MouseEvent): void {
  event.stopPropagation()
}

/**
 * Os quatro desenhos do seletor de modo.
 *
 * Moram AQUI, e não no catálogo de `node-icons.tsx`, porque aquele catálogo é
 * de ícones ESCOLHÍVEIS: o nome de cada um é gravado em disco no terminal e na
 * responsabilidade, então tudo que entra lá vira opção permanente no diálogo de
 * quem cria um agente. Estes quatro são um conjunto fechado de uma peça só,
 * nunca escolhidos e nunca persistidos por nome — publicá-los no catálogo seria
 * poluir uma grade de escolha com três desenhos que ninguém pode escolher.
 *
 * Traçado de 24×24 em `currentColor`, como o resto: a cor vem do estado do
 * botão, sem uma regra de CSS por ícone.
 */
function ModeIcon({ mode }: { mode: ClockMode }): JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {MODE_PATHS[mode]}
    </svg>
  )
}

const MODE_PATHS: Record<ClockMode, JSX.Element> = {
  // Relógio: mostrador com dois ponteiros — o mesmo desenho do ícone da dock.
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  // Cronômetro: a coroa e o botão em cima, que é o que distingue um cronômetro
  // de um relógio à primeira vista.
  stopwatch: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M9.5 2.5h5M12 2.5v3M12 10v3.5h3M18.6 6.4l1.4-1.4" />
    </>
  ),
  // Timer: a ampulheta. Contagem REGRESSIVA precisa de um desenho que fale de
  // esgotamento, não de hora.
  timer: (
    <>
      <path d="M7 3h10M7 21h10" />
      <path d="M8 3v3.5c0 2 4 3.7 4 5.5s-4 3.5-4 5.5V21" />
      <path d="M16 3v3.5c0 2-4 3.7-4 5.5s4 3.5 4 5.5V21" />
    </>
  ),
  // Pomodoro: o tomate com a folha. É o nome da técnica e o desenho que ela
  // carrega há trinta anos — qualquer metáfora nossa seria pior.
  pomodoro: (
    <>
      <path d="M12 7.5c-4 0-6.8 2.8-6.8 6.4S8 21 12 21s6.8-3.5 6.8-7.1S16 7.5 12 7.5z" />
      <path d="M12 7.5V5M9.6 5.4c1.2-1.4 3.6-1.4 4.8 0-1.2.9-3.6.9-4.8 0z" />
    </>
  )
}
